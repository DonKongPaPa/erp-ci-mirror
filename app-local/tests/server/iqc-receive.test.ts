// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';
import type { Knex } from 'knex';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createEmployee,
  createOrder,
  get,
  jsonOf,
  unique,
  write,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  stockMutationsToken,
  type StockDocRecord,
} from '../../server/providers/inventory.js';
import { IqcRuleError } from '../../server/providers/iqc.js';

/**
 * R-070 IQC 与库存的挂点：窄读只回可入库需要的列；带 inspectionId 的入库按行余额校验，
 * 不带该键的采购入库逐字节照旧；两笔真事务同时用同一行时只有一笔成功。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R070-iqc-receive-123!';
type Row = Record<string, unknown>;

async function makeRoleUser(
  admin: TestSession,
  testApp: Parameters<typeof signIn>[0],
  prefix: string,
  role: string,
): Promise<{ session: TestSession; id: string }> {
  const username = unique(prefix);
  const created = await admin.fetch('/users', write({
    name: username, username,
    email: `${username.toLowerCase()}@example.test`,
    password: PASSWORD,
    roleScopes: { app: [role] },
  }));
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const id = String(((await jsonOf(created)).data as Row | undefined)?.id ?? '');
  return { session: await signIn(testApp, { username, password: PASSWORD }), id };
}

async function createWarehouse(admin: TestSession): Promise<string> {
  const response = await admin.fetch('/warehouses', write({
    code: unique('WH'), name: '来料检验仓',
  }));
  expect(response.status, `建仓库失败：${await response.clone().text()}`).toBe(201);
  return String((await jsonOf(response)).id);
}

async function completedInspection(
  testApp: Parameters<typeof signIn>[0],
  admin: TestSession,
  connection: DatabaseConnection,
  itemId: string,
  qty: number,
): Promise<{ id: string; lineId: string; orderId: string }> {
  const inspector = await makeRoleUser(admin, testApp, 'iqcrcvins', 'quality_inspector');
  await createEmployee(connection, inspector.id);
  const order = await createOrder(admin, 'purchase', { lines: [{ itemId, qty }] });
  expect(
    (await admin.fetch(`/purchase-orders/${String(order.id)}/submit`, write())).status,
  ).toBe(200);
  const created = await inspector.session.fetch('/inspections', write({
    purchaseOrderId: order.id,
    // 编造的例：采购 10、收货 10、检验 8、合格 7、抽检 2、抽检合格 2。
    lines: [{
      itemId, inspectionTypeCode: 'full', receivedQty: qty, inspectionQty: qty - 2,
      qualifiedQty: qty - 3, samplingQty: 2, samplingQualifiedQty: 2,
    }],
  }));
  expect(created.status, `建检验单失败：${await created.clone().text()}`).toBe(201);
  const body = await jsonOf(created);
  const id = String(body.id);
  expect(
    (await inspector.session.fetch(`/inspections/${id}/complete`, write())).status,
  ).toBe(200);
  const lineRow = await connection.repository<Row>('inspectionLines').findOne({
    filter: { orderId: id },
  });
  return { id, lineId: String(lineRow?.id), orderId: String(order.id) };
}

const balanceOf = async (
  connection: DatabaseConnection,
  itemId: string,
  warehouseId: string,
): Promise<number> => {
  const row = await connection.repository<Row>('stockBalances').findOne({
    filter: { itemId, warehouseId, batchNo: '' },
  });
  return row === undefined ? 0 : Number(row.qty);
};

/** 等第二个事务真的排在锁上；拿不到就是前置条件没成立，不能算并发通过。 */
async function waitForLockWait(
  connection: DatabaseConnection,
): Promise<number> {
  const knex = await connection.client<Knex>();
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await knex.raw(
      `select count(*)::int as waiting from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock'
          and (query ilike '%inspection_orders%' or query ilike '%inspection_lines%')`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('IQC 窄读与入库挂点：可入库 7 入完，第 8 个被拒，不带 inspectionId 的路径不变', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'iqcrcvkeeper', 'warehouse');
  const itemId = await createItem(connection);
  const warehouseId = await createWarehouse(admin);
  const inspection = await completedInspection(testApp, admin, connection, itemId, 10);
  const completed = await jsonOf(await admin.fetch(`/inspections/${inspection.id}`, get()));
  expect(Number((completed.lines as Row[])[0]?.releasableQty)).toBe(7);

  const options = await keeper.session.fetch(
    `/inspections/receivable-options?purchaseOrderId=${inspection.orderId}`, get(),
  );
  expect(options.status).toBe(200);
  const page = await jsonOf(options);
  expect(page.total).toBe(1);
  const option = (page.items as Row[])[0]!;
  expect(Object.keys(option).sort()).toEqual([
    'docNo', 'id', 'inspectionDate', 'lines', 'purchaseOrderId', 'status',
  ]);
  const optionLine = (option.lines as Row[])[0]!;
  expect(Object.keys(optionLine).sort()).toEqual([
    'batchNo', 'inspectionLineId', 'itemId', 'releasableQty', 'remainQty', 'warehouseId',
  ]);
  expect(Number(optionLine.releasableQty)).toBe(7);
  expect(Number(optionLine.remainQty)).toBe(7);
  for (const key of [
    'remark', 'inspector', 'price', 'email', 'phone', 'mobile', 'createdById',
    'qualifiedQty', 'note', 'purchaseQty',
  ]) {
    expect(Object.keys(option), `窄读不该回 ${key}`).not.toContain(key);
    expect(Object.keys(optionLine), `窄读行不该回 ${key}`).not.toContain(key);
  }

  const first = await keeper.session.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    sourceType: 'purchase_order', sourceId: inspection.orderId,
    inspectionId: inspection.id,
    lines: [{
      itemId, warehouseId, batchNo: '',
      qty: 7, inspectionLineId: inspection.lineId,
    }],
  }));
  expect(first.status, `带检验单建入库失败：${await first.clone().text()}`).toBe(201);
  const firstDoc = await jsonOf(first);
  expect(firstDoc.inspectionId).toBe(inspection.id);
  expect(
    (await keeper.session.fetch(`/stock-docs/${String(firstDoc.id)}/post`, write())).status,
  ).toBe(200);
  expect(await balanceOf(connection, itemId, warehouseId)).toBe(7);
  const transactions = await connection.repository<Row>('stockTransactions').findMany({
    filter: { docId: String(firstDoc.id) },
  });
  expect(transactions).toHaveLength(1);
  expect(Number(transactions[0]?.qtyDelta)).toBe(7);

  const excess = await keeper.session.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    inspectionId: inspection.id,
    lines: [{
      itemId, warehouseId, batchNo: '',
      qty: 1, inspectionLineId: inspection.lineId,
    }],
  }));
  expect(excess.status, '累计 8 件超过可入库数量 7').toBe(422);
  expect((await jsonOf(excess)).error?.reason).toBe('IQC_RELEASABLE_EXCEED');

  // 同一检验行分两张单入完：5 + 2 正好等于可入库数量。
  const splitItem = await createItem(connection);
  const split = await completedInspection(testApp, admin, connection, splitItem, 10);
  for (const qty of [5, 2]) {
    const doc = await keeper.session.fetch('/stock-docs', write({
      docType: 'in', reason: 'purchase_receipt',
      inspectionId: split.id,
      lines: [{
        itemId: splitItem, warehouseId, batchNo: '',
        qty, inspectionLineId: split.lineId,
      }],
    }));
    expect(doc.status, `分批入库 ${qty} 件`).toBe(201);
  }

  const ordinary = await admin.fetch('/stock-docs', write({
    docType: 'in', reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, batchNo: '', qty: 2 }],
  }));
  expect(ordinary.status, '不带检验单的采购入库照常建').toBe(201);
  const ordinaryDoc = await jsonOf(ordinary);
  expect(Object.keys(ordinaryDoc), '不带键的响应不得多出 inspectionId').not.toContain('inspectionId');
  expect(
    (await admin.fetch(`/stock-docs/${String(ordinaryDoc.id)}/post`, write())).status,
  ).toBe(200);
  expect(await balanceOf(connection, itemId, warehouseId)).toBe(9);
}, 60_000);

test('IQC 并发：两笔真事务同时用同一检验行，合计超过时只有一笔成功', async ({
  testApp, app, database, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const itemId = await createItem(connection);
  const warehouseId = await createWarehouse(admin);
  const inspection = await completedInspection(testApp, admin, connection, itemId, 10);
  const mutations = app.container.resolve(stockMutationsToken);
  const input = {
    docType: 'in' as const,
    reason: 'purchase_receipt' as const,
    inspectionId: inspection.id,
    lines: [{
      itemId, warehouseId, batchNo: '', qty: 7,
      inspectionLineId: inspection.lineId,
    }],
  };

  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let second: Promise<unknown> | undefined;
  const first = database
    .transaction(async (tx) => {
      await mutations.createDoc(input, 'iqc-concurrency', tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    second = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.createDoc(input, 'iqc-concurrency', tx);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await secondEntered.promise;
    expect(
      await waitForLockWait(connection),
      '第二个事务没有停在锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    releaseFirst.resolve();
  }
  await first;
  const failure = second === undefined ? null : await second;

  expect(failure, '第二个建单必须被拒绝').toBeInstanceOf(IqcRuleError);
  expect((failure as IqcRuleError).code).toBe('iqc-releasable-exceed');
  const docs = await connection.repository<StockDocRecord>('stockDocs').findMany({
    filter: { inspectionId: inspection.id },
  });
  expect(docs, '只有一张入库单成功').toHaveLength(1);
}, 60_000);

const receipt = (
  inspectionId: string,
  itemId: string,
  warehouseId: string,
  qty: number,
  inspectionLineId: string,
) => ({
  docType: 'in',
  reason: 'purchase_receipt',
  inspectionId,
  lines: [{ itemId, warehouseId, batchNo: '', qty, inspectionLineId }],
});

test('IQC 作废入库草稿后占用放回，未作废的草稿继续占着', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'iqcvoiddoc', 'warehouse');
  const itemId = await createItem(connection);
  const warehouseId = await createWarehouse(admin);
  const inspection = await completedInspection(testApp, admin, connection, itemId, 10);

  const draft = await keeper.session.fetch('/stock-docs', write(
    receipt(inspection.id, itemId, warehouseId, 5, inspection.lineId),
  ));
  expect(draft.status).toBe(201);
  const draftId = String((await jsonOf(draft)).id);
  const voided = await keeper.session.fetch(`/stock-docs/${draftId}/void`, write());
  expect(voided.status, '作废入库草稿').toBe(200);

  const afterVoid = await keeper.session.fetch('/stock-docs', write(
    receipt(inspection.id, itemId, warehouseId, 7, inspection.lineId),
  ));
  expect(afterVoid.status, '作废后 5 个占用放回，7 个应当建得出来').toBe(201);

  // 对照组：不经过作废，5 + 2 正好用完，第 3 个被拒。
  const controlItem = await createItem(connection);
  const control = await completedInspection(testApp, admin, connection, controlItem, 10);
  const first = await keeper.session.fetch('/stock-docs', write(
    receipt(control.id, controlItem, warehouseId, 5, control.lineId),
  ));
  expect(first.status).toBe(201);
  const second = await keeper.session.fetch('/stock-docs', write(
    receipt(control.id, controlItem, warehouseId, 2, control.lineId),
  ));
  expect(second.status, '5 + 2 = 7 正好用完').toBe(201);
  const excess = await keeper.session.fetch('/stock-docs', write(
    receipt(control.id, controlItem, warehouseId, 3, control.lineId),
  ));
  expect(excess.status).toBe(422);
  expect((await jsonOf(excess)).error?.reason).toBe('IQC_RELEASABLE_EXCEED');
}, 60_000);

test('IQC 改草稿重新校验可入库上限，换检验单被拒', async ({
  testApp, connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const keeper = await makeRoleUser(admin, testApp, 'iqcpatchdoc', 'warehouse');
  const itemId = await createItem(connection);
  const warehouseId = await createWarehouse(admin);
  const inspection = await completedInspection(testApp, admin, connection, itemId, 10);

  const draft = await keeper.session.fetch('/stock-docs', write(
    receipt(inspection.id, itemId, warehouseId, 5, inspection.lineId),
  ));
  expect(draft.status).toBe(201);
  const draftId = String((await jsonOf(draft)).id);
  const patch = (qty: number) => keeper.session.fetch(`/stock-docs/${draftId}`, write({
    reason: 'purchase_receipt',
    lines: [{ itemId, warehouseId, batchNo: '', qty, inspectionLineId: inspection.lineId }],
  }, 'PATCH'));

  const tooBig = await patch(8);
  expect(tooBig.status, '把挂检验单的草稿改成 8 个应当被拒').toBe(422);
  expect((await jsonOf(tooBig)).error?.reason).toBe('IQC_RELEASABLE_EXCEED');
  const unchanged = await connection.repository<Row>('stockDocLines').findMany({
    filter: { docId: draftId },
  });
  expect(unchanged).toHaveLength(1);
  expect(Number(unchanged[0]?.qty), '被拒的补丁不改库').toBe(5);

  const okPatch = await patch(6);
  expect(okPatch.status, '改成 6 个，排除本单原行后应当成功').toBe(200);

  // 换检验单不能静默忽略：显式 422，库里仍挂着原检验单。
  const otherItem = await createItem(connection);
  const other = await completedInspection(testApp, admin, connection, otherItem, 10);
  const swapped = await keeper.session.fetch(`/stock-docs/${draftId}`, write({
    ...receipt(other.id, itemId, warehouseId, 6, inspection.lineId),
  }, 'PATCH'));
  expect(swapped.status, '更新时换 inspectionId 必须被拒').toBe(422);
  expect((await jsonOf(swapped)).error?.reason).toBe('IQC_NOT_RELEASABLE');
  const stored = await connection.repository<Row>('stockDocs').findOne({ filter: { id: draftId } });
  expect(stored?.inspectionId).toBe(inspection.id);

  const one = await keeper.session.fetch('/stock-docs', write(
    receipt(inspection.id, itemId, warehouseId, 1, inspection.lineId),
  ));
  expect(one.status, '6 + 1 = 7 正好用完').toBe(201);
  const excess = await keeper.session.fetch('/stock-docs', write(
    receipt(inspection.id, itemId, warehouseId, 2, inspection.lineId),
  ));
  expect(excess.status).toBe(422);
  expect((await jsonOf(excess)).error?.reason).toBe('IQC_RELEASABLE_EXCEED');
}, 60_000);
