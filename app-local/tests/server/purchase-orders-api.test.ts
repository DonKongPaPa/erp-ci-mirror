// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createDictEntry,
  createEmployee,
  createOrder,
  createPartner,
  createWarehouse,
  get,
  jsonOf,
  makeRoleUser,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-021 端点：建单自动取号、草稿整单替换、提交/取消、生成入库单的部分与全量，
 * 以及规则码。每条断言都从真库读回写入结果。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TIMEOUT = 30_000;
const PATH = '/purchase-orders';

test('建单自动取号：CG 前缀、供应商摘要、明细整单写入，服务端列不收', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const supplier = await createPartner(admin, { isSupplier: true });
  const item = await createItem(connection);
  const response = await admin.fetch(PATH, write({
    supplierId: supplier.id,
    orderDate: '2026-11-26',
    remark: '首张采购单',
    orderNo: '伪造的号',
    status: 'received',
    createdById: '伪造的人',
    lines: [{ itemId: item, qty: 10.5, price: 3.25, receivedQty: 999 }],
  }));
  expect(response.status, `建单失败：${await response.clone().text()}`).toBe(201);
  const order = await jsonOf(response);
  expect(String(order.orderNo)).toMatch(/^CG-\d{8}-\d{4,}$/u);
  expect(String(order.orderNo)).not.toBe('伪造的号');
  expect(order).toMatchObject({
    supplierId: supplier.id,
    orderDate: '2026-11-26',
    status: 'draft',
    remark: '首张采购单',
    submittedAt: null,
  });
  expect(order.supplier).toMatchObject({ id: supplier.id, code: supplier.code, name: supplier.name });
  expect(Object.keys(order.supplier ?? {})).not.toContain('email');
  expect(Object.keys(order)).not.toContain('createdById');
  expect(order.lines).toHaveLength(1);
  expect(order.lines?.[0]).toMatchObject({
    itemId: item, qty: 10.5, price: 3.25, receivedQty: 0, remainingQty: 10.5,
  });

  const stored = await connection.repository<Row>('purchaseOrders').findOne({
    filter: { id: order.id },
  });
  expect(stored?.status).toBe('draft');
  expect(stored?.orderNo).toBe(order.orderNo);
  expect(typeof stored?.createdById).toBe('string');
  expect(stored?.createdById).not.toBe('伪造的人');
  expect(
    await connection.repository<Row>('purchaseOrderLines').findMany({ filter: { orderId: order.id } }),
  ).toHaveLength(1);
}, TIMEOUT);

test('草稿整单替换、提交写 submittedAt、取消与没有删除', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: itemA, qty: 2 }],
  });
  const id = String(order.id);

  const patched = await admin.fetch(`${PATH}/${id}`, write({
    remark: '换掉明细',
    lines: [{ itemId: itemB, qty: 7, price: 1.5 }],
    orderNo: '伪造', status: 'received',
  }, 'PATCH'));
  expect(patched.status, `改草稿失败：${await patched.clone().text()}`).toBe(200);
  const body = await jsonOf(patched);
  expect(body.orderNo).toBe(order.orderNo);
  expect(body).toMatchObject({ status: 'draft', remark: '换掉明细' });
  expect(body.lines).toHaveLength(1);
  expect(body.lines?.[0]).toMatchObject({ itemId: itemB, qty: 7, remainingQty: 7 });
  expect(
    await connection.repository<Row>('purchaseOrderLines').findMany({ filter: { orderId: id } }),
  ).toHaveLength(1);

  const submitted = await admin.fetch(`${PATH}/${id}/submit`, write());
  expect(submitted.status, `提交失败：${await submitted.clone().text()}`).toBe(200);
  const submittedBody = await jsonOf(submitted);
  expect(submittedBody.status).toBe('ordered');
  expect(submittedBody.submittedAt).not.toBeNull();

  for (const [path, method, payload] of [
    [PATH + '/' + id, 'PATCH', { remark: '还想改', lines: [{ itemId: itemA, qty: 1 }] }],
    [`${PATH}/${id}/submit`, 'POST', {}],
  ] as const) {
    const refused = await admin.fetch(path, write(payload, method));
    expect(refused.status).toBe(422);
    expect((await jsonOf(refused)).error?.reason).toBe('ORDER_NOT_DRAFT');
  }

  const cancelled = await admin.fetch(`${PATH}/${id}/cancel`, write());
  expect(cancelled.status, `取消失败：${await cancelled.clone().text()}`).toBe(200);
  expect((await jsonOf(cancelled)).status).toBe('cancelled');
  const removed = await admin.fetch(`${PATH}/${id}`, {
    method: 'DELETE', headers: { origin: 'http://localhost' },
  });
  expect([404, 405]).toContain(removed.status);
  expect((await admin.fetch(`${PATH}/${id}`, get())).status).toBe(200);
}, TIMEOUT);

test('规则码：往来单位与物料校验、重复物料、空明细、空 PATCH、不存在的订单', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const inactiveItem = await createItem(connection, 'inactive');
  const customer = await createPartner(admin, { isCustomer: true });
  const supplier = await createPartner(admin, { isSupplier: true });
  const inactiveSupplier = await createPartner(admin, { isSupplier: true });
  expect((await admin.fetch(`/partners/${String(inactiveSupplier.id)}`, write(
    { status: 'inactive' }, 'PATCH',
  ))).status).toBe(200);

  const reject = async (body: unknown, reason: string, status = 422): Promise<void> => {
    const response = await admin.fetch(PATH, write(body));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(status);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  const base = (supplierId: unknown, lines: unknown) => ({
    supplierId, orderDate: '2026-11-27', lines,
  });
  await reject(base(unique('NO-SUPPLIER'), [{ itemId: item, qty: 1 }]), 'PARTNER_NOT_FOUND', 404);
  await reject(base(customer.id, [{ itemId: item, qty: 1 }]), 'PARTNER_NOT_SUPPLIER');
  await reject(base(inactiveSupplier.id, [{ itemId: item, qty: 1 }]), 'PARTNER_INACTIVE');
  await reject(base(supplier.id, []), 'ORDER_LINE_INVALID');
  await reject(base(supplier.id, [{ itemId: item, qty: 0 }]), 'ORDER_LINE_INVALID');
  await reject(base(supplier.id, [{ itemId: item, qty: 1, price: -1 }]), 'ORDER_LINE_INVALID');
  await reject(base(supplier.id, [
    { itemId: item, qty: 1 }, { itemId: item, qty: 2 },
  ]), 'ORDER_LINE_DUPLICATED');
  await reject(base(supplier.id, [{ itemId: unique('NO-ITEM'), qty: 1 }]), 'ITEM_NOT_FOUND', 404);
  await reject(base(supplier.id, [{ itemId: inactiveItem, qty: 1 }]), 'ITEM_INACTIVE');

  const order = await createOrder(admin, 'purchase', { lines: [{ itemId: item, qty: 1 }] });
  const empty = await admin.fetch(`${PATH}/${String(order.id)}`, write({}, 'PATCH'));
  expect(empty.status).toBe(422);
  expect((await jsonOf(empty)).error?.reason).toBe('ORDER_EMPTY_PATCH');
  const missing = await admin.fetch(`${PATH}/${unique('NO-ORDER')}`, get());
  expect(missing.status).toBe(404);
  expect((await jsonOf(missing)).error?.reason).toBe('ORDER_NOT_FOUND');
}, TIMEOUT);

test('列表过滤与详情形状：列表不带明细与供应商，详情带', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);
  const supplier = await createPartner(admin, { isSupplier: true });
  const order = await createOrder(admin, 'purchase', {
    supplierId: supplier.id, lines: [{ itemId: item, qty: 3 }],
  });

  const list = await jsonOf(await admin.fetch(
    `${PATH}?status=draft&supplierId=${String(supplier.id)}&q=订单测试&page=1&pageSize=5`
    + `&from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z`, get(),
  ));
  expect(list.items?.map((row) => String(row.id))).toContain(String(order.id));
  expect(list).toMatchObject({ page: 1, pageSize: 5 });
  expect(list.items?.some((row) => 'lines' in row || 'supplier' in row)).toBe(false);
  const detail = await jsonOf(await admin.fetch(`${PATH}/${String(order.id)}`, get()));
  expect(detail.lines).toHaveLength(1);
  expect(detail.supplier).toMatchObject({ id: supplier.id });
  expect(detail, '没有来源的订单不多出单据号键').not.toHaveProperty('purchaseRequestDocNo');
}, TIMEOUT);

test('生成入库单：默认全量、指定行/部分行、超额与重复生成被拒，取消被单据挡住', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemA = await createItem(connection);
  const itemB = await createItem(connection);
  const warehouse = await createWarehouse(admin);
  const draft = await createOrder(admin, 'purchase', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const beforeSubmit = await admin.fetch(
    `${PATH}/${String(draft.id)}/create-receipt`, write({ warehouseId: warehouse.id }),
  );
  expect(beforeSubmit.status).toBe(422);
  expect((await jsonOf(beforeSubmit)).error?.reason).toBe('ORDER_NOT_ISSUABLE');

  const order = await createOrder(admin, 'purchase', {
    lines: [{ itemId: itemA, qty: 10 }, { itemId: itemB, qty: 5 }],
  });
  const id = String(order.id);
  expect((await admin.fetch(`${PATH}/${id}/submit`, write())).status).toBe(200);
  const orderLines = (await jsonOf(await admin.fetch(`${PATH}/${id}`, get()))).lines!;
  const lineA = orderLines.find((line) => line.itemId === itemA)!;
  expect(lineA, '测试前置：应当找得到 itemA 对应的订单行').toBeDefined();

  const partial = await admin.fetch(`${PATH}/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 4 }],
  }));
  expect(partial.status, `生成入库单失败：${await partial.clone().text()}`).toBe(201);
  const doc = await jsonOf(partial);
  expect(doc).toMatchObject({
    docType: 'in',
    reason: 'purchase_receipt',
    status: 'draft',
    sourceType: 'purchase_order',
    sourceId: id,
  });
  expect(doc.lines).toHaveLength(1);
  expect(doc.lines?.[0]).toMatchObject({
    itemId: itemA, warehouseId: warehouse.id, qty: 4, batchNo: '',
  });
  const afterPartial = await jsonOf(await admin.fetch(`${PATH}/${id}`, get()));
  const remainingOf = (body: typeof afterPartial, itemId: string): number =>
    Number(body.lines?.find((line) => line.itemId === itemId)?.remainingQty);
  expect(remainingOf(afterPartial, itemA)).toBe(6);
  expect(remainingOf(afterPartial, itemB)).toBe(5);

  const tooMuch = await admin.fetch(`${PATH}/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: lineA.id, qty: 7 }],
  }));
  expect(tooMuch.status).toBe(422);
  expect((await jsonOf(tooMuch)).error?.reason).toBe('ORDER_QTY_EXCEEDS_REMAINING');
  const unknownLine = await admin.fetch(`${PATH}/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
    lines: [{ lineId: unique('NO-LINE'), qty: 1 }],
  }));
  expect(unknownLine.status).toBe(422);
  expect((await jsonOf(unknownLine)).error?.reason).toBe('ORDER_LINE_INVALID');

  const cancel = await admin.fetch(`${PATH}/${id}/cancel`, write());
  expect(cancel.status).toBe(422);
  expect((await jsonOf(cancel)).error?.reason).toBe('ORDER_NOT_CANCELLABLE');

  const rest = await admin.fetch(`${PATH}/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
  }));
  expect(rest.status, `按剩余全量生成失败：${await rest.clone().text()}`).toBe(201);
  const restDoc = await jsonOf(rest);
  expect(restDoc.lines).toHaveLength(2);
  expect(restDoc.lines).toHaveLength(2);
  expect(restDoc.lines?.map((line) => Number(line.qty)).sort()).toEqual([5, 6]);
  const afterAll = await jsonOf(await admin.fetch(`${PATH}/${id}`, get()));
  expect(afterAll.lines?.every((line) => Number(line.remainingQty) === 0)).toBe(true);

  const again = await admin.fetch(`${PATH}/${id}/create-receipt`, write({
    warehouseId: warehouse.id,
  }));
  expect(again.status).toBe(422);
  expect((await jsonOf(again)).error?.reason).toBe('ORDER_LINES_ALREADY_ISSUED');
  expect(
    await connection.repository<Row>('stockDocs').findMany({
      filter: { sourceType: 'purchase_order', sourceId: id },
    }),
  ).toHaveLength(2);
}, TIMEOUT);


test('加片金额、交期与字典：三行合计、优惠后金额、两单价以含税为准、最晚交期', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const supplier = await createPartner(admin, { isSupplier: true });
  const warehouse = await createWarehouse(admin);
  const items = [await createItem(connection), await createItem(connection), await createItem(connection)];
  await createDictEntry(connection, 'project', 'PROJ-A');
  await createDictEntry(connection, 'settlement', 'SET-A');

  const created = await admin.fetch(PATH, write({
    supplierId: supplier.id,
    orderDate: '2026-11-27',
    warehouseId: warehouse.id,
    contactName: '测试联系人',
    contactPhone: '000-0000',
    deliveryAddress: '测试交付地址',
    settlementCode: 'SET-A',
    projectCode: 'PROJ-A',
    discountAmount: 30,
    lines: [
      { itemId: items[0], qty: 10, price: 113, taxExcludedPrice: 999, taxRate: 13, deliveryDate: '2026-12-01' },
      { itemId: items[1], qty: 10, price: 113, taxRate: 13, deliveryDate: '2026-12-05' },
      { itemId: items[2], qty: 10, price: 113, taxRate: 13, deliveryDate: '2026-12-03' },
    ],
  }));
  expect(created.status, `建单失败：${await created.clone().text()}`).toBe(201);
  const order = await jsonOf(created);
  expect(order.lines).toHaveLength(3);
  for (const line of order.lines!) {
    expect(line).toMatchObject({
      taxRate: 13, taxExcludedPrice: 100, taxExcludedAmount: 1000,
      taxAmount: 130, taxIncludedAmount: 1130,
    });
  }
  expect(order).toMatchObject({
    totalQty: 30, taxIncludedTotal: 3390, taxExcludedTotal: 3000,
    taxTotal: 390, discountAmount: 30, payableTotal: 3360,
    latestDeliveryDate: '2026-12-05', projectCode: 'PROJ-A', settlementCode: 'SET-A',
  });

  const patched = await admin.fetch(`${PATH}/${String(order.id)}`, write({
    latestDeliveryDate: '1999-01-01', discountAmount: 0,
  }, 'PATCH'));
  expect(patched.status, `改优惠失败：${await patched.clone().text()}`).toBe(200);
  const after = await jsonOf(patched);
  expect(after.latestDeliveryDate, '头上交期是派生列，请求带了要忽略').toBe('2026-12-05');
  expect(after.payableTotal).toBe(3390);
}, TIMEOUT);

test('加片拒绝路径：单价、优惠、字典码、经办人四类规则码', async ({ testApp, connection }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const supplier = await createPartner(admin, { isSupplier: true });
  const item = await createItem(connection);
  await createDictEntry(connection, 'project', 'PROJ-OFF', 'inactive');
  const base = { supplierId: supplier.id, orderDate: '2026-11-27' };
  const reject = async (body: Row, reason: string): Promise<void> => {
    const response = await admin.fetch(PATH, write({ ...base, lines: [{ itemId: item, qty: 1 }], ...body }));
    expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(422);
    expect((await jsonOf(response)).error?.reason).toBe(reason);
  };
  await reject({ lines: [{ itemId: item, qty: 1, taxExcludedPrice: 10 }] }, 'ORDER_LINE_PRICE_INVALID');
  await reject({ lines: [{ itemId: item, qty: 1, price: 113, taxRate: 13 }], discountAmount: 200 }, 'ORDER_DISCOUNT_INVALID');
  await reject({ projectCode: 'PROJ-OFF' }, 'ORDER_DICT_CODE_INVALID');
  await reject({ projectCode: 'PROJ-NO-SUCH' }, 'ORDER_DICT_CODE_INVALID');
  await reject({ handlerUserId: unique('NO-PERSON') }, 'ORDER_PERSON_INVALID');
}, TIMEOUT);

test('风险反向：只持 view 的会话读列表与详情都没有价格键；默认经办人是登录人', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const item = await createItem(connection);

  // 采购角色的默认授权带 viewPrice；经办人默认登录人，只回标识与姓名。
  const username = unique('r021handler');
  const password = 'R021-handler-123!';
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password, roleScopes: { app: ['purchase'] },
  }));
  expect(created.status).toBe(201);
  const userId = String((await jsonOf(created)).data?.id);
  expect(userId, '前置：用户 id').toBeTruthy();
  await createEmployee(connection, userId);
  const buyer = await signIn(testApp, { username, password });
  const order = await createOrder(buyer, 'purchase', {
    lines: [{ itemId: item, qty: 10, price: 113, taxRate: 13 }],
  });
  expect(order.handler).toMatchObject({ userId });
  expect(Object.keys(order.handler as Row).sort()).toEqual(['name', 'userId']);

  // 只给 view、不给 viewPrice：列表与详情里所有价格与金额键必须不出现。
  const { session: viewer } = await makeRoleUser(
    admin, testApp, 'r021view', [
      { resource: { type: 'composite', id: 'purchaseOrders' }, actions: [{ action: 'view' }] },
    ],
  );
  const headerPriceKeys = [
    'discountAmount', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
  ];
  const linePriceKeys = [
    'price', 'taxExcludedPrice', 'taxExcludedAmount', 'taxAmount', 'taxIncludedAmount',
  ];
  const priceKeys = [...headerPriceKeys, ...linePriceKeys];
  for (const response of [
    await viewer.fetch(PATH, get()),
    await viewer.fetch(`${PATH}/${String(order.id)}`, get()),
  ]) {
    expect(response.status, `只持 view 应当能读：${await response.clone().text()}`).toBe(200);
    const body = await jsonOf(response);
    const rows: Row[] = body.items ?? [body];
    for (const row of rows) {
      for (const key of priceKeys) expect(Object.keys(row)).not.toContain(key);
      for (const line of (row.lines ?? []) as Row[]) {
        for (const key of priceKeys) expect(Object.keys(line)).not.toContain(key);
      }
    }
  }
  // 对照：持 viewPrice 的会话同一张单这些键都在，不是数据本身没有算。
  const priced = await jsonOf(await buyer.fetch(`${PATH}/${String(order.id)}`, get()));
  for (const key of headerPriceKeys) expect(Object.keys(priced)).toContain(key);
  expect(priced.lines?.length).toBeGreaterThan(0);
  for (const line of priced.lines!) {
    for (const key of linePriceKeys) expect(Object.keys(line)).toContain(key);
  }
}, TIMEOUT);

test('经办人缺省：非员工建单留空且能改草稿；在职员工取登录人；显式离职员工仍被拒', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const supplier = await createPartner(admin, { isSupplier: true });
  const item = await createItem(connection);
  const base = {
    supplierId: supplier.id, orderDate: '2026-11-28',
    lines: [{ itemId: item, qty: 1 }],
  };

  // root 没有员工档案：缺省经办人必须留空，否则编辑时回送这个标识会被拒。
  const rootCreated = await admin.fetch(PATH, write(base));
  expect(rootCreated.status, `root 建单失败：${await rootCreated.clone().text()}`).toBe(201);
  const rootOrder = await jsonOf(rootCreated);
  expect(rootOrder.handler, 'root 建单的经办人应为空').toBeNull();
  expect(rootOrder.handlerUserId, 'root 建单的经办人标识应为空').toBeNull();
  expect(
    (await connection.repository<Row>('purchaseOrders').findOne({ filter: { id: rootOrder.id } }))?.handlerUserId,
    '库里的经办人列也应为空',
  ).toBeNull();
  const edited = await admin.fetch(`${PATH}/${String(rootOrder.id)}`, write({
    remark: 'root 改草稿',
  }, 'PATCH'));
  expect(edited.status, `root 改草稿失败：${await edited.clone().text()}`).toBe(200);
  const returned = await jsonOf(edited);
  expect(returned.handlerUserId, '编辑后经办人仍为空').toBeNull();
  const echoed = await admin.fetch(`${PATH}/${String(rootOrder.id)}`, write({
    remark: '回送经办人标识', handlerUserId: returned.handlerUserId,
  }, 'PATCH'));
  expect(echoed.status, `回送空经办人编辑失败：${await echoed.clone().text()}`).toBe(200);

  // 在职员工不传经办人：取登录人本人。
  const username = unique('r021default');
  const password = 'R021-default-123!';
  const createdUser = await admin.fetch('/users', write({
    name: username, username, email: `${username.toLowerCase()}@example.test`,
    password, roleScopes: { app: ['purchase'] },
  }));
  expect(createdUser.status, `建用户失败：${await createdUser.clone().text()}`).toBe(201);
  const userId = String((await jsonOf(createdUser)).data?.id);
  expect(userId, '前置：用户 id').toBeTruthy();
  await createEmployee(connection, userId);
  const buyer = await signIn(testApp, { username, password });
  const staffCreated = await buyer.fetch(PATH, write(base));
  expect(staffCreated.status, `在职员工建单失败：${await staffCreated.clone().text()}`).toBe(201);
  const staffOrder = await jsonOf(staffCreated);
  expect(staffOrder.handler).toMatchObject({ userId });
  expect(staffOrder.handlerUserId).toBe(userId);

  // 显式离职员工照旧 422。
  const leftId = unique('LEFT');
  await createEmployee(connection, leftId, 'left');
  const rejected = await admin.fetch(PATH, write({ ...base, handlerUserId: leftId }));
  expect(rejected.status, `显式离职员工应当被拒：${await rejected.clone().text()}`).toBe(422);
  expect((await jsonOf(rejected)).error?.reason).toBe('ORDER_PERSON_INVALID');
}, TIMEOUT);
