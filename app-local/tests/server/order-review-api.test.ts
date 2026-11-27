// @vitest-environment node
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { Knex } from 'knex';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createItem } from '../helpers/inventory.js';
import {
  createOrder,
  get,
  jsonOf,
  ORIGIN,
  unique,
  write,
  type Row,
} from '../helpers/orders.js';
import { createStandaloneServer } from '../../server/standalone.js';
import {
  orderReviewMutationsToken,
  REVIEW_FACTORS,
  ReviewRuleError,
  type Factor,
} from '../../server/providers/order-reviews.js';

/**
 * R-064 验收 2-6、9（真 Postgres）：评审正向、台账与提醒的窄形状、重新评审、
 * 逐条拒绝、并发确认只有一条 confirmed，以及老订单端点响应键不变。
 * 所有姓名、单号、日期都编造；超期日期按测试当天的上海自然日推算。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R064-api-test-123!';
const dateOffset = (days: number): string => {
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
};

const fiveFactors = (): { factor: Factor; conclusion: string; note: string }[] =>
  REVIEW_FACTORS.map((factor) => ({
    factor, conclusion: `编造结论-${factor}`, note: `编造备注-${factor}`,
  }));

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
  expect(created.status, `建用户失败：${await created.clone().text()}`).toBe(201);
  const userId = String(((await jsonOf(created)).data as Row).id);
  return { userId, session: await signIn(testApp, { username, password: PASSWORD }) };
}

async function linkEmployee(
  admin: TestSession,
  userId: string,
): Promise<void> {
  const response = await admin.fetch('/employees/link',
    write({ userId, hiredOn: '2026-01-01' }));
  expect(response.status, `补档案失败：${await response.clone().text()}`).toBe(201);
}

async function createSalesOrder(
  admin: TestSession,
  connection: { client<T>(): Promise<T> },
  override: Row = {},
): Promise<Row> {
  const itemId = await createItem(connection);
  const order = await createOrder(admin, 'sales', {
    orderDate: dateOffset(-10),
    lines: [{ itemId, qty: 10, deliveryDate: dateOffset(-3) }],
    ...override,
  });
  const response = await admin.fetch(
    `/sales-orders/${String(order.id)}/submit`, write(),
  );
  expect(response.status).toBe(200);
  const knex = await connection.client<Knex>();
  const line = await knex('sales_order_lines').where({ order_id: String(order.id) }).first();
  await knex('sales_order_lines').where({ id: line.id }).update({ shipped_qty: 4 });
  return order;
}

async function createReview(
  session: TestSession,
  salesOrderId: string,
  reviewerUserId: string,
  lines = fiveFactors(),
): Promise<Row> {
  const response = await session.fetch('/order-reviews', write({
    salesOrderId, reviewerUserId, lines,
  }));
  expect(response.status, `建评审失败：${await response.clone().text()}`).toBe(201);
  return await jsonOf(response);
}

async function post(
  session: TestSession,
  path: string,
  body: unknown = {},
): Promise<Row> {
  const response = await session.fetch(path, write(body));
  return { ...(await jsonOf(response)), statusCode: response.status } as Row;
}

async function waitForSalesOrderLock(
  connection: { client<T>(): Promise<T> },
): Promise<number> {
  const knex = await connection.client<Knex>();
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await knex.raw(
      `select count(*)::int as waiting from pg_stat_activity
        where state = 'active' and wait_event_type = 'Lock'
          and query ilike '%sales_orders%'`,
    );
    waiting = Number((result.rows ?? result)[0]?.waiting ?? 0);
    if (waiting > 0) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}

test('正向：planning 建五项、提交、确认；详情两键评审人、带时区评审时间与 sales 可读', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064planner', ['planning']);
  await linkEmployee(admin, planner.userId);
  const seller = await makeUser(admin, testApp, 'r064seller', ['sales']);
  const order = await createSalesOrder(root, connection);

  const draft = await createReview(planner.session, String(order.id), planner.userId);
  expect(draft.status).toBe('draft');
  expect(draft.lines).toHaveLength(5);
  expect(Object.keys(draft.reviewer ?? {})).toEqual(['userId', 'name']);
  expect((draft.reviewer as Row).userId).toBe(planner.userId);

  const patch = await planner.session.fetch(
    `/order-reviews/${String(draft.id)}`,
    write({ lines: fiveFactors() }, 'PATCH'),
  );
  expect(patch.status).toBe(200);

  const submitted = await post(planner.session, `/order-reviews/${String(draft.id)}/submit`);
  expect(submitted.statusCode).toBe(200);
  expect(submitted.status).toBe('submitted');
  expect(String(submitted.reviewedAt)).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/u,
  );

  const delivery = dateOffset(3);
  const confirmed = await post(planner.session,
    `/order-reviews/${String(draft.id)}/confirm`,
    { confirmedDeliveryDate: delivery });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.confirmedDeliveryDate).toBe(delivery);

  const detailResponse = await planner.session.fetch(
    `/order-reviews/${String(draft.id)}`, get());
  expect(detailResponse.status).toBe(200);
  const detail = await jsonOf(detailResponse);
  expect(detail.lines).toHaveLength(5);
  expect(detail.salesOrder).toMatchObject({
    id: order.id, orderNo: order.orderNo, orderDate: order.orderDate,
  });
  expect(Object.keys(detail.reviewer as Row)).toEqual(['userId', 'name']);
  expect(String(detail.reviewedAt)).toMatch(/\+08:00$/u);

  const salesDetail = await seller.session.fetch(
    `/order-reviews/${String(draft.id)}`, get());
  expect(salesDetail.status).toBe(200);
  expect((await jsonOf(salesDetail)).id).toBe(draft.id);

  const listResponse = await planner.session.fetch(
    `/order-reviews?salesOrderId=${String(order.id)}`, get());
  expect(listResponse.status).toBe(200);
  const list = await jsonOf(listResponse);
  expect(list.items).toHaveLength(1);
  expect(Object.keys(list.items![0] as Row)).not.toContain('lines');
});

test('台账与提醒：评审段 done、发货数量来自订单行，四段为 null，超期与回落按自然日算', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064ledgerplanner', ['planning']);
  await linkEmployee(admin, planner.userId);
  const order = await createSalesOrder(root, connection);
  const review = await createReview(planner.session, String(order.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(review.id)}/submit`);
  const delivery = dateOffset(-3);
  await post(planner.session, `/order-reviews/${String(review.id)}/confirm`,
    { confirmedDeliveryDate: delivery });

  const ledgerResponse = await planner.session.fetch(
    `/sales-orders/ledger?q=${encodeURIComponent(String(order.orderNo))}`, get(),
  );
  expect(ledgerResponse.status).toBe(200);
  const ledger = await jsonOf(ledgerResponse);
  expect(ledger.total).toBe(1);
  const row = ledger.items![0] as Row;
  expect(row.review).toMatchObject({ status: 'done', confirmedDeliveryDate: delivery });
  expect(row.shipping).toMatchObject({ qty: 4, total: 10 });
  for (const segment of ['purchase', 'production', 'receipt', 'payment'] as const) {
    expect(row[segment]).toEqual({ status: null, qty: null, total: null });
  }
  expect(row.overdue).toBe(true);
  expect(row.overdueDays).toBe(3);
  expect(row.upcoming).toBe(false);

  // 没有确认评审的单回落到订单行的 latestDeliveryDate。
  const fallbackItem = await createItem(connection);
  const fallback = await createSalesOrder(root, connection, {
    lines: [{ itemId: fallbackItem, qty: 10, deliveryDate: dateOffset(-5) }],
  });
  const fallbackLedger = await jsonOf(await planner.session.fetch(
    `/sales-orders/ledger?q=${encodeURIComponent(String(fallback.orderNo))}`, get()));
  const fallbackRow = fallbackLedger.items![0] as Row;
  expect(fallbackRow.baselineDate).toBe(dateOffset(-5));
  expect(fallbackRow.review.status).toBe('pending');
  expect(fallbackRow.overdue).toBe(true);

  const overdueResponse = await planner.session.fetch(
    '/home/delivery-reminders?scope=overdue', get());
  expect(overdueResponse.status).toBe(200);
  const reminders = await jsonOf(overdueResponse);
  const ids = reminders.items!.map((item) => String((item as Row).salesOrderId));
  expect(ids).toContain(String(order.id));
  expect(ids).toContain(String(fallback.id));
  const dates = reminders.items!.map((item) => String((item as Row).baselineDate));
  expect([...dates].sort()).toEqual(dates);
  expect(reminders.items!.every((item) => (item as Row).scope === 'overdue')).toBe(true);

  const upcomingOrder = await createSalesOrder(root, connection);
  const upcomingReview = await createReview(
    planner.session, String(upcomingOrder.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(upcomingReview.id)}/submit`);
  await post(planner.session, `/order-reviews/${String(upcomingReview.id)}/confirm`,
    { confirmedDeliveryDate: dateOffset(3) });
  const upcoming = await jsonOf(await planner.session.fetch(
    '/home/delivery-reminders?scope=upcoming&days=7', get()));
  expect(upcoming.items!.map((item) => (item as Row).salesOrderId))
    .toContain(upcomingOrder.id);
  const soon = await jsonOf(await planner.session.fetch(
    '/home/delivery-reminders?scope=upcoming&days=1', get()));
  expect(soon.items!.map((item) => (item as Row).salesOrderId))
    .not.toContain(upcomingOrder.id);
});

test('重新评审：新一轮确认把旧的置 void，台账取新交期；并发兜底另有测试', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064replanner', ['planning']);
  await linkEmployee(admin, planner.userId);
  const order = await createSalesOrder(root, connection);
  const first = await createReview(planner.session, String(order.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(first.id)}/submit`);
  await post(planner.session, `/order-reviews/${String(first.id)}/confirm`,
    { confirmedDeliveryDate: dateOffset(-5) });

  const second = await createReview(planner.session, String(order.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(second.id)}/submit`);
  const again = await post(planner.session, `/order-reviews/${String(second.id)}/confirm`,
    { confirmedDeliveryDate: dateOffset(-1) });
  expect(again.statusCode).toBe(200);

  const knex = await connection.client<Knex>();
  const rows = await knex('order_reviews')
    .select('id', 'status').where({ sales_order_id: String(order.id) });
  expect(rows.find((row: Row) => row.id === first.id)?.status).toBe('void');
  expect(rows.find((row: Row) => row.id === second.id)?.status).toBe('confirmed');
  const ledger = await jsonOf(await planner.session.fetch(
    `/sales-orders/ledger?q=${encodeURIComponent(String(order.orderNo))}`, get()));
  expect((ledger.items![0] as Row).review.confirmedDeliveryDate).toBe(dateOffset(-1));

  // 顺序再评审：已确认的那条是「待替代」，新一轮照常确认并把它置 void。
  // 409 REVIEW_CONFIRMED_EXISTS 只留给并发兜底（见下面的两事务测试）。
  const third = await createReview(planner.session, String(order.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(third.id)}/submit`);
  const replacement = await post(planner.session,
    `/order-reviews/${String(third.id)}/confirm`,
    { confirmedDeliveryDate: dateOffset(1) });
  expect(replacement.statusCode).toBe(200);
  const after = await knex('order_reviews')
    .select('id', 'status').where({ sales_order_id: String(order.id), status: 'confirmed' });
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(third.id);
});

test('拒绝：五项不齐、离职评审人、未提交确认、非草稿修改、没有 DELETE', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064rejectplanner', ['planning']);
  await linkEmployee(admin, planner.userId);
  const left = await makeUser(admin, testApp, 'r064left', ['planning']);
  await linkEmployee(admin, left.userId);
  const knex = await connection.client<Knex>();
  await knex('employees').where({ user_id: left.userId }).update({ status: 'left' });
  const order = await createSalesOrder(root, connection);

  const missing = await post(planner.session, '/order-reviews', {
    salesOrderId: String(order.id), reviewerUserId: planner.userId,
    lines: fiveFactors().slice(0, 4),
  });
  expect(missing.statusCode).toBe(422);
  expect(missing.error).toMatchObject({ reason: 'REVIEW_FACTORS_INCOMPLETE' });

  const invalidPerson = await post(planner.session, '/order-reviews', {
    salesOrderId: String(order.id), reviewerUserId: left.userId, lines: fiveFactors(),
  });
  expect(invalidPerson.statusCode).toBe(422);
  expect(invalidPerson.error).toMatchObject({ reason: 'REVIEW_PERSON_INVALID' });

  const draft = await createReview(planner.session, String(order.id), planner.userId);
  const early = await post(planner.session,
    `/order-reviews/${String(draft.id)}/confirm`,
    { confirmedDeliveryDate: dateOffset(1) });
  expect(early.statusCode).toBe(422);
  expect(early.error).toMatchObject({ reason: 'REVIEW_NOT_SUBMITTED' });

  await post(planner.session, `/order-reviews/${String(draft.id)}/submit`);
  const patchResponse = await planner.session.fetch(
    `/order-reviews/${String(draft.id)}`, write({ lines: fiveFactors() }, 'PATCH'));
  expect(patchResponse.status).toBe(422);
  expect((await jsonOf(patchResponse)).error).toMatchObject({ reason: 'REVIEW_NOT_DRAFT' });

  const deleteResponse = await planner.session.fetch(
    `/order-reviews/${String(draft.id)}`, { method: 'DELETE', headers: { origin: ORIGIN } });
  expect([404, 405]).toContain(deleteResponse.status);
});

test('并发确认：两个真事务锁订单头，只有一条 confirmed，另一条兜底拒绝', async ({
  testApp, connection, database, app,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const admin = root;
  const planner = await makeUser(admin, testApp, 'r064conplanner', ['planning']);
  await linkEmployee(admin, planner.userId);
  const order = await createSalesOrder(root, connection);
  const first = await createReview(planner.session, String(order.id), planner.userId);
  const second = await createReview(planner.session, String(order.id), planner.userId);
  await post(planner.session, `/order-reviews/${String(first.id)}/submit`);
  await post(planner.session, `/order-reviews/${String(second.id)}/submit`);
  const mutations = app.container.resolve(orderReviewMutationsToken);

  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let pendingSecond: Promise<unknown> | undefined;
  const firstRun = database
    .transaction(async (tx) => {
      await mutations.confirm(String(first.id), dateOffset(-2), tx);
      firstWritten.resolve();
      await releaseFirst.promise;
    })
    .catch((error: unknown) => error);
  try {
    await firstWritten.promise;
    pendingSecond = database
      .transaction(async (tx) => {
        secondEntered.resolve();
        await mutations.confirm(String(second.id), dateOffset(-1), tx);
      })
      .then(() => null, (error: unknown) => error);
    await secondEntered.promise;
    expect(
      await waitForSalesOrderLock(connection),
      '第二个事务没有停在订单头行锁上，不能证明并发',
    ).toBeGreaterThan(0);
  } finally {
    releaseFirst.resolve();
  }
  await firstRun;
  const failure = pendingSecond === undefined ? null : await pendingSecond;
  expect(failure, '后一个确认必须被拒绝').toBeInstanceOf(ReviewRuleError);
  expect((failure as ReviewRuleError).code).toBe('confirmed-exists');

  const knex = await connection.client<Knex>();
  const confirmed = await knex('order_reviews')
    .select('id').where({ sales_order_id: String(order.id), status: 'confirmed' });
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0].id).toBe(first.id);
}, 60_000);

test('老客户端：GET /sales-orders 与详情的键不变，确认交期不在订单上', async ({
  testApp, connection,
}) => {
  const root = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const order = await createSalesOrder(root, connection);
  const list = await jsonOf(await root.fetch('/sales-orders', get()));
  expect(list.items!.length).toBeGreaterThan(0);
  expect(Object.keys(list.items![0] as Row)).not.toContain('confirmedDeliveryDate');
  const detail = await jsonOf(await root.fetch(`/sales-orders/${String(order.id)}`, get()));
  expect(Object.keys(detail)).not.toContain('confirmedDeliveryDate');
});
