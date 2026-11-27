// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { DatabaseConnection } from '@nocobase/db';
import type { Knex } from 'knex';
import { expect, vi } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  get,
  jsonOf,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { upgradeR064, type R064UpgradeServices } from '../../cli/authz/upgrade-r064.js';
import {
  planningPermissionSet,
  salesReviewPermissionSet,
} from '../../database/main/seeds/202611280003_seed_order_review_grants.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  orderLedgerToken,
  type LedgerRow,
  type ReminderRow,
} from '../../server/providers/order-ledger.js';
import {
  orderReviewMutationsToken,
  orderReviewReaderToken,
  REVIEW_FACTORS,
  type Factor,
} from '../../server/providers/order-reviews.js';

/**
 * R-064 验收 7、8 与升级命令（真 Postgres）：sales 只读；仓储、采购、普通员工全拒；
 * 先授权后读内容；非 planning 改不了确认交期；台账与提醒的响应里没有电话、邮箱、价格，
 * 客户恰好三列、人员恰好两列。升级命令建角色、只加不改、幂等、声明对不上整条跳过。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R064-authz-test-123!';
const FORBIDDEN_KEYS = [
  'contactPhone', 'contactName', 'email', 'salespersonPhone',
  'reviewerEmail', 'phone', 'address', 'price', 'amount',
];
const fiveFactors = (): { factor: Factor; conclusion: string }[] =>
  REVIEW_FACTORS.map((factor) => ({ factor, conclusion: `编造结论-${factor}` }));

type TestApp = Parameters<typeof signIn>[0];

async function makeUser(
  admin: TestSession,
  testApp: TestApp,
  prefix: string,
  roles: readonly string[],
): Promise<{ session: TestSession; userId: string }> {
  const username = unique(prefix).toLowerCase();
  const created = await admin.fetch('/users', write({
    name: username, username, email: `${username}@example.test`,
    password: PASSWORD, roleScopes: { app: [...roles] },
  }));
  expect(created.status).toBe(201);
  const userId = String(((await jsonOf(created)).data as Row).id);
  return { userId, session: await signIn(testApp, { username, password: PASSWORD }) };
}

async function linkEmployee(admin: TestSession, userId: string): Promise<void> {
  const response = await admin.fetch('/employees/link',
    write({ userId, hiredOn: '2026-01-01' }));
  expect(response.status).toBe(201);
}

async function setupOrder(
  root: TestSession,
  connection: DatabaseConnection,
): Promise<Row> {
  const itemId = await createItem(connection);
  const order = await createOrder(root, 'sales', {
    orderDate: '2026-11-01',
    lines: [{ itemId, qty: 10, deliveryDate: '2026-11-20' }],
  });
  const knex = await connection.client<Knex>();
  const line = await knex('sales_order_lines').where({ order_id: String(order.id) }).first();
  await knex('sales_order_lines').where({ id: line.id }).update({ shipped_qty: 4 });
  return order;
}

async function setupReview(
  planner: TestSession,
  orderId: string,
  reviewerUserId: string,
): Promise<Row> {
  const created = await planner.fetch('/order-reviews', write({
    salesOrderId: orderId, reviewerUserId, lines: fiveFactors(),
  }));
  expect(created.status).toBe(201);
  const review = await jsonOf(created);
  expect((await planner.fetch(
    `/order-reviews/${String(review.id)}/submit`, write())).status).toBe(200);
  expect((await planner.fetch(
    `/order-reviews/${String(review.id)}/confirm`,
    write({ confirmedDeliveryDate: '2026-11-02' }))).status).toBe(200);
  return review;
}

function assertNoSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSensitiveKeys);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(row)) {
    expect(FORBIDDEN_KEYS, `响应里不该有 ${key}`).not.toContain(key);
    assertNoSensitiveKeys(nested);
  }
}

const customerKeys = (row: LedgerRow | ReminderRow): string[] =>
  Object.keys(row.customer ?? {}).sort();

test('授权正向与拒绝：sales 只读，仓管/采购/员工全拒，非法请求也先 403', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064plan', ['planning']);
  await linkEmployee(admin, planner.userId);
  const seller = await makeUser(admin, testApp, 'r064sell', ['sales']);
  const order = await setupOrder(root, connection);
  const review = await setupReview(planner.session, String(order.id), planner.userId);

  expect((await seller.session.fetch(
    `/order-reviews/${String(review.id)}`, get())).status).toBe(200);
  expect((await seller.session.fetch('/sales-orders/ledger', get())).status).toBe(200);
  expect((await seller.session.fetch('/home/delivery-reminders', get())).status).toBe(200);

  for (const denied of [
    await seller.session.fetch('/order-reviews', write({
      salesOrderId: String(order.id), reviewerUserId: planner.userId, lines: fiveFactors(),
    })),
    await seller.session.fetch(`/order-reviews/${String(review.id)}/confirm`,
      write({ confirmedDeliveryDate: '2026-11-03' })),
    await seller.session.fetch(`/order-reviews/${String(review.id)}`,
      write({ lines: fiveFactors() }, 'PATCH')),
  ]) {
    expect(denied.status).toBe(403);
  }

  const readPaths = [
    '/order-reviews', `/order-reviews/${String(review.id)}`,
    '/sales-orders/ledger', '/home/delivery-reminders',
  ];
  for (const role of ['warehouse', 'purchase', 'staff'] as const) {
    const stranger = await makeUser(admin, testApp, `r064${role}`, [role]);
    for (const path of readPaths) {
      expect((await stranger.session.fetch(path, get())).status, `${role} ${path}`).toBe(403);
    }
    // 请求体在业务上非法，但授权在前：403 而不是 422。
    const illegal = await stranger.session.fetch('/order-reviews', write({
      salesOrderId: 'missing', reviewerUserId: 'missing', lines: [],
    }));
    expect(illegal.status).toBe(403);
    expect((await jsonOf(illegal)).error?.reason).not.toBe('REVIEW_FACTORS_INCOMPLETE');
    const ledger = await stranger.session.fetch('/sales-orders/ledger', get());
    expect((await jsonOf(ledger)).error?.reason).toBe('LEDGER_FORBIDDEN');
  }
});

test('先授权后读内容：无授权时评审与台账的读服务一次都不调用', async ({
  app, testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const stranger = await makeUser(admin, testApp, 'r064probe', ['staff']);
  const order = await setupOrder(root, connection);
  const reviews = app.container.resolve(orderReviewReaderToken);
  const mutations = app.container.resolve(orderReviewMutationsToken);
  const ledger = app.container.resolve(orderLedgerToken);
  const listSpy = vi.spyOn(reviews, 'list');
  const detailSpy = vi.spyOn(reviews, 'detail');
  const createSpy = vi.spyOn(mutations, 'create');
  const confirmSpy = vi.spyOn(mutations, 'confirm');
  const ledgerSpy = vi.spyOn(ledger, 'list');
  const reminderSpy = vi.spyOn(ledger, 'reminders');
  try {
    expect((await stranger.session.fetch('/order-reviews', get())).status).toBe(403);
    expect((await stranger.session.fetch('/order-reviews/nope', get())).status).toBe(403);
    expect((await stranger.session.fetch('/order-reviews', write({
      salesOrderId: String(order.id), reviewerUserId: 'nobody', lines: [],
    }))).status).toBe(403);
    expect((await stranger.session.fetch('/order-reviews/nope/confirm',
      write({ confirmedDeliveryDate: '2026-11-02' }))).status).toBe(403);
    expect((await stranger.session.fetch('/sales-orders/ledger', get())).status).toBe(403);
    expect((await stranger.session.fetch('/home/delivery-reminders', get())).status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
    expect(detailSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(reminderSpy).not.toHaveBeenCalled();
  } finally {
    listSpy.mockRestore();
    detailSpy.mockRestore();
    createSpy.mockRestore();
    confirmSpy.mockRestore();
    ledgerSpy.mockRestore();
    reminderSpy.mockRestore();
  }
});

test('反向断言：非 planning 改不了确认交期，台账与提醒不带联系方式与价格', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064ownplan', ['planning']);
  await linkEmployee(admin, planner.userId);
  const seller = await makeUser(admin, testApp, 'r064ownsell', ['sales']);
  const order = await setupOrder(root, connection);
  const review = await setupReview(planner.session, String(order.id), planner.userId);

  const blocked = await seller.session.fetch(
    `/order-reviews/${String(review.id)}/confirm`,
    write({ confirmedDeliveryDate: '2026-12-31' }));
  expect(blocked.status).toBe(403);
  const knex = await connection.client<Knex>();
  const stored = await knex('order_reviews').where({ id: String(review.id) }).first();
  expect(stored.status).toBe('confirmed');
  expect(new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(stored.confirmed_delivery_date))).toBe('2026-11-02');
  expect((await seller.session.fetch(
    `/order-reviews/${String(review.id)}`,
    write({ reviewerUserId: seller.userId }, 'PATCH'))).status).toBe(403);

  const ledger = await jsonOf(await planner.session.fetch('/sales-orders/ledger', get()));
  const reminders = await jsonOf(await planner.session.fetch(
    '/home/delivery-reminders?scope=overdue', get()));
  const detail = await jsonOf(await planner.session.fetch(
    `/order-reviews/${String(review.id)}`, get()));
  assertNoSensitiveKeys(ledger);
  assertNoSensitiveKeys(reminders);
  assertNoSensitiveKeys(detail);
  for (const row of ledger.items as LedgerRow[]) {
    expect(customerKeys(row)).toEqual(['code', 'id', 'name']);
    if (row.review.reviewer !== null) {
      expect(Object.keys(row.review.reviewer).sort()).toEqual(['name', 'userId']);
    }
    if (row.handler !== null) {
      expect(Object.keys(row.handler).sort()).toEqual(['name', 'userId']);
    }
  }
  for (const row of reminders.items as ReminderRow[]) {
    expect(customerKeys(row)).toEqual(['code', 'id', 'name']);
  }
  expect(Object.keys(detail.reviewer).sort()).toEqual(['name', 'userId']);
});

type Grants = readonly {
  resource: { type: string; id: string };
  actions: readonly { action: string; policy?: unknown }[];
}[];
const actionsOf = (grants: Grants, id: string): readonly string[] =>
  grants.filter((grant) => grant.resource.type === 'composite' && grant.resource.id === id)
    .flatMap((grant) => grant.actions.map((action) => action.action));

test('seed：planning 拿六个评审动作与台账只读，不拿订单 view；sales 只多两个读动作', async ({
  app,
}) => {
  // 授权定义钉在新种子上，原种子已执行过、不能回改。
  const authz = app.container.resolve(authorizationToken);
  const planning = await authz.permissionSets.get('planning');
  expect(planning).toBeDefined();
  expect(planning!.grants).toEqual(planningPermissionSet.grants);
  const grants = planning!.grants as unknown as Grants;
  expect(actionsOf(grants, 'orderReviews')).toEqual([
    'view', 'create', 'update', 'submit', 'confirm', 'void',
  ]);
  expect(actionsOf(grants, 'salesOrders')).toEqual(['ledgerView']);
  expect(planning!.title).toEqual({
    key: 'permissionSets.business.planning', ns: 'app-local',
  });
  const sales = await authz.permissionSets.get('sales');
  const salesGrants = sales!.grants as unknown as Grants;
  expect(actionsOf(salesGrants, 'orderReviews')).toEqual(['view']);
  // sales 原有的订单 view 保留；planning 才是不拿 view 的那个。
  expect(actionsOf(salesGrants, 'salesOrders')).toContain('ledgerView');
  for (const added of salesReviewPermissionSet.grants) {
    expect(salesGrants, '新种子的 sales 补丁授权没有落库').toContainEqual(added);
  }
  const warehouse = await authz.permissionSets.get('warehouse');
  expect(actionsOf(warehouse!.grants as unknown as Grants, 'orderReviews')).toEqual([]);
});

test('升级：旧环境没有 planning 就建，补齐授权；重跑不写、别的角色不动', async ({
  app, connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const before = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );
  await authz.permissionSets.delete('planning');
  // 旧环境的 sales 没有两条新读动作，其他授权保持原样。
  const sales = await authz.permissionSets.get('sales');
  const salesGrants = JSON.parse(JSON.stringify(sales!.grants)) as Row[];
  const oldSales = salesGrants.filter((grant) => {
    const resource = grant.resource as Row;
    const actions = grant.actions as Row[];
    return !(
      resource.id === 'orderReviews' ||
      (resource.id === 'salesOrders' && actions.every((action) => action.action === 'ledgerView'))
    );
  });
  await connection.query.updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(oldSales) })
    .where('key', '=', 'sales')
    .execute();

  const lines: string[] = [];
  const first = await upgradeR064({ authorization: authz },
    { info: (line) => lines.push(line) });
  expect(first.created).toEqual(['planning']);
  expect(first.changed).toContain('sales');
  const created = await authz.permissionSets.get('planning');
  expect(created!.title).toEqual({
    key: 'permissionSets.business.planning', ns: 'app-local',
  });
  expect(actionsOf(created!.grants as unknown as Grants, 'orderReviews')).toEqual([
    'view', 'create', 'update', 'submit', 'confirm', 'void',
  ]);
  expect(actionsOf(created!.grants as unknown as Grants, 'salesOrders')).toEqual(['ledgerView']);
  expect(actionsOf((await authz.permissionSets.get('sales'))!.grants as unknown as Grants,
    'orderReviews')).toEqual(['view']);
  expect(lines.join('\n')).toContain('role created');

  const revisions = new Map(
    (await authz.permissionSets.list()).map((set) => [set.key, set.revision]),
  );
  const again = await upgradeR064({ authorization: authz }, { info: () => {} });
  expect(again.unchanged).toEqual(['planning', 'sales']);
  expect(again.changed).toEqual([]);
  expect(again.created).toEqual([]);
  for (const [key, value] of revisions) {
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改写`).toBe(value);
  }
  for (const [key, value] of before) {
    if (key === 'planning' || key === 'sales') continue;
    expect((await authz.permissionSets.get(key))!.revision, `${key} 不该被改动`).toBe(value);
  }
});

test('升级：声明对不上整条跳过，带读到的 revision 写入', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const broken = {
    compositeResources: {
      getAction: () => undefined,
      validateGrant: () => undefined,
    },
    permissionSets: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  } as unknown as R064UpgradeServices['authorization'];
  const invalid = await upgradeR064({ authorization: broken }, { info: () => {} });
  expect(invalid.invalid).toEqual(['planning', 'sales']);
  expect(broken.permissionSets.create).not.toHaveBeenCalled();
  expect(broken.permissionSets.update).not.toHaveBeenCalled();

  const set = await authz.permissionSets.get('planning');
  const grants = JSON.parse(JSON.stringify(set!.grants)) as Row[];
  const withoutLedger = grants.filter((grant) =>
    (grant.resource as Row).id !== 'salesOrders');
  await connection.query.updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(withoutLedger) })
    .where('key', '=', 'planning')
    .execute();
  const spy = vi.spyOn(authz.permissionSets, 'update');
  try {
    const repaired = await upgradeR064({ authorization: authz }, { info: () => {} });
    expect(repaired.changed).toContain('planning');
    expect(spy).toHaveBeenCalledWith(
      'planning', expect.objectContaining({ key: 'planning' }),
      set!.revision,
    );
  } finally {
    spy.mockRestore();
  }
}, 30_000);
