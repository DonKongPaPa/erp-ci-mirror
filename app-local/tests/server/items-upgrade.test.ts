// @vitest-environment node
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import {
  userManagementServiceToken,
  type UserManagementService,
} from '@nocobase/app-plugin-users/server/tokens';
import type { DatabaseConnection } from '@nocobase/db';
import { expect, vi } from 'vitest';

import AuthzUpgradeR019Page, {
  ITEMS_PAGE_ID,
  upgradeR019Page,
  type R019PageUpgradeServices,
} from '../../cli/authz/upgrade-r019-page.js';
import AuthzUpgradeR019Price, {
  neededGrants,
  PURCHASE_PRICE_ACTION,
  SALES_PRICE_ACTION,
  TARGETS as PRICE_TARGETS,
  upgradeR019Price,
  type R019PriceUpgradeServices,
} from '../../cli/authz/upgrade-r019-price.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-019 页面片的升级命令：已有环境里 seed 不会给销售/采购补物料页的页面授权。
 * 每个用例从 seed 形状出发，用 SQL 把两个角色的页面授权与 items.view 删掉，再跑命令；
 * 断言有效权限 `can()`、库里的形状、幂等与 revision。声明对不上或角色不存在时整条跳过、什么都不写。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const TARGETS = ['purchase', 'sales'] as const;
const OTHERS = [
  'staff',
  'warehouse',
  'quality_manager',
  'quality_inspector',
  'dept_manager',
  'member',
];
const PASSWORD = 'R019-upgrade-123!';

interface JsonGrant {
  resource: { type: string; id: string };
  actions: { action: string; policy?: unknown }[];
}
interface Snapshot {
  grants: JsonGrant[];
  revision: string;
}
const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];
const snapshot = async (
  authz: AppAuthorization,
  key: string,
): Promise<Snapshot> => {
  const set = await authz.permissionSets.get(key);
  if (!set) throw new Error(`permission set ${key} is missing`);
  return { grants: grantsOf(set), revision: set.revision as string };
};
const services = (app: {
  container: { resolve(token: typeof authorizationToken): AppAuthorization };
}): R019PageUpgradeServices => ({
  authorization: app.container.resolve(authorizationToken),
});
const can = (
  authz: AppAuthorization,
  userId: string,
  resource: { type: string; id: string },
  action: string,
) =>
  authz
    .for({ principal: { type: 'user', id: userId } })
    .can({ resource, action });
const itemsPage = { type: 'page', id: ITEMS_PAGE_ID };
const itemsResource = { type: 'composite', id: 'items' };
const createPerson = async (
  users: UserManagementService,
  name: string,
  roles: readonly string[],
) =>
  (
    await users.create({
      name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [...roles] },
    })
  ).id;

/** 这条命令会补的两样：物料页的页面授权与 items.view。 */
const isItemsGrant = (grant: JsonGrant): boolean =>
  (grant.resource.type === 'page' && grant.resource.id === ITEMS_PAGE_ID) ||
  (grant.resource.type === 'composite' && grant.resource.id === 'items');

/** 升级命令声明要写的那一条页面授权：items 页面的 access（不带 policy）。 */
const isItemsPageAccess = (grant: JsonGrant): boolean =>
  grant.resource.type === 'page' &&
  grant.resource.id === ITEMS_PAGE_ID &&
  grant.actions.some(
    (entry) => entry.action === 'access' && entry.policy === undefined,
  );

/** 造升级之前的环境：把两个角色的物料页页面授权与 items.view 整条删掉，revision 不动。 */
async function makeOld(
  connection: DatabaseConnection,
  authz: AppAuthorization,
): Promise<void> {
  for (const key of TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter((grant) => !isItemsGrant(grant));
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('新环境 seed：销售与采购各有物料页的页面授权与只读，别的角色一份都不给', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const buyer = await createPerson(users, 'r019seedbuyer', ['purchase']);
  const seller = await createPerson(users, 'r019seedseller', ['sales']);
  const keeper = await createPerson(users, 'r019seedkeeper', ['warehouse']);
  for (const person of [buyer, seller]) {
    expect(
      await can(authz, person, itemsPage, 'access'),
      '应当打得开物料页',
    ).toBe(true);
    expect(await can(authz, person, itemsResource, 'view')).toBe(true);
    // 写只给 root。
    expect(await can(authz, person, itemsResource, 'manage')).toBe(false);
  }
  // 仓管没有页面授权，也没有 items.view（设计第六节第 1 条记着的缺口）。
  expect(await can(authz, keeper, itemsPage, 'access')).toBe(false);
  expect(await can(authz, keeper, itemsResource, 'view')).toBe(false);
});

test('旧环境只补两个角色：原有授权不动、revision 更新，重跑不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz);
  const buyer = await createPerson(users, 'r019upgradebuyer', ['purchase']);
  const seller = await createPerson(users, 'r019upgradeseller', ['sales']);
  // 前置条件：升级前两个角色都打不开物料页，也读不了物料。
  expect(await can(authz, buyer, itemsPage, 'access')).toBe(false);
  expect(await can(authz, seller, itemsPage, 'access')).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS])
    before.set(key, await snapshot(authz, key));

  const lines: string[] = [];
  const report = await upgradeR019Page(services(app), {
    info: (message) => lines.push(message),
  });
  expect(report.pages.changed).toEqual([...TARGETS]);
  expect(report.pages.unchanged).toEqual([]);
  expect(report.pages.missing).toEqual([]);
  expect(report.pages.invalid).toEqual([]);
  expect(
    lines.some((line) =>
      line.includes('[r019-page] purchase: added the items page'),
    ),
  ).toBe(true);

  const after = new Map<string, Snapshot>();
  for (const key of [...TARGETS, ...OTHERS])
    after.set(key, await snapshot(authz, key));
  for (const key of TARGETS) {
    const old = before.get(key)!;
    const now = after.get(key)!;
    expect(now.revision).not.toBe(old.revision);
    // 原有的授权一条不动、顺序不变，新补的接在后面。
    expect(
      now.grants.slice(0, old.grants.length),
      `${key} 原有授权不该被动`,
    ).toEqual(old.grants);
    expect(now.grants.slice(old.grants.length).every(isItemsGrant)).toBe(true);
    expect(
      now.grants
        .filter(isItemsGrant)
        .map((grant) => grant.resource.type)
        .sort(),
    ).toEqual(['composite', 'page']);
  }
  for (const key of OTHERS)
    expect(after.get(key), `${key} 不该被动`).toEqual(before.get(key));
  for (const person of [buyer, seller]) {
    expect(await can(authz, person, itemsPage, 'access')).toBe(true);
    expect(await can(authz, person, itemsResource, 'view')).toBe(true);
    expect(await can(authz, person, itemsResource, 'manage')).toBe(false);
  }

  const second = await upgradeR019Page(services(app), {
    info: () => undefined,
  });
  expect(second.pages.changed).toEqual([]);
  expect(second.pages.unchanged).toEqual([...TARGETS]);
  expect(second.grants.changed).toEqual([]);
  for (const key of [...TARGETS, ...OTHERS])
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(
      after.get(key),
    );
});

/** 页面授权那一次写入：请求体的授权里有物料页。 */
const isPageWrite = (input: { grants?: unknown }): boolean =>
  JSON.stringify(input.grants ?? []).includes(`"id":"${ITEMS_PAGE_ID}"`);

test('页面授权的写入带读到的 revision', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  // 先只补业务授权（等于先跑过 upgrade-r021），这一次就只写页面授权。
  await upgradeR021Only(authz);
  const real = authz.permissionSets.update.bind(authz.permissionSets);
  const writes: { key: string; passed: unknown; current: unknown }[] = [];
  const spy = vi
    .spyOn(authz.permissionSets, 'update')
    .mockImplementation(async (key, input, revision) => {
      if (isPageWrite(input))
        writes.push({
          key,
          passed: revision,
          current: (await authz.permissionSets.get(key))?.revision,
        });
      return real(key, input, revision);
    });
  try {
    const report = await upgradeR019Page(services(app), {
      info: () => undefined,
    });
    expect(report.pages.changed).toEqual([...TARGETS]);
  } finally {
    spy.mockRestore();
  }
  expect(writes.map((write) => write.key)).toEqual([...TARGETS]);
  for (const write of writes) {
    // 命令带的是它读到的那一个 revision，也就是写之前库里的那一个。
    expect(write.current).toBeTypeOf('string');
    expect(write.passed).toBe(write.current);
  }
});

test('存量的角色没有 revision 时拒绝覆盖：这个角色什么都不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const list = authz.permissionSets.list.bind(authz.permissionSets);
  const spy = vi
    .spyOn(authz.permissionSets, 'list')
    .mockImplementation(async () =>
      (await list()).map((set) =>
        set.key === 'sales' ? { ...set, revision: undefined } : set,
      ),
    );
  try {
    await expect(
      upgradeR019Page(services(app), { info: () => undefined }),
    ).rejects.toThrow(/no revision/u);
  } finally {
    spy.mockRestore();
  }
  const sales = await authz.permissionSets.get('sales');
  // sales 缺 revision：只钉住命令声明要写的那条 items 页面 access。
  // sales 本来就有的其它页面授权（如 partners）不算，不能拿「有任意页面授权」当前置条件。
  expect(grantsOf(sales!).filter(isItemsPageAccess)).toEqual([]);
});

test('声明对不上时整条跳过：业务授权与页面授权都不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of TARGETS) before.set(key, await snapshot(authz, key));
  const real = authz.compositeResources.getAction.bind(
    authz.compositeResources,
  );
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) =>
      id === 'items' ? undefined : real(id, action),
    );
  try {
    const report = await upgradeR019Page(services(app), {
      info: () => undefined,
    });
    expect(report.pages.invalid).toEqual([...TARGETS]);
    expect(report.pages.changed).toEqual([]);
    for (const key of TARGETS)
      expect(await snapshot(authz, key)).toEqual(before.get(key));
  } finally {
    spy.mockRestore();
  }
});

test('角色不存在时记一行跳过，另一个角色照常补', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz);
  await connection.query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'purchase')
    .execute();
  const lines: string[] = [];
  const report = await upgradeR019Page(services(app), {
    info: (line) => lines.push(line),
  });
  expect(report.pages.missing).toEqual(['purchase']);
  expect(report.pages.changed).toEqual(['sales']);
  expect(
    lines.some(
      (line) => line.includes('purchase') && line.includes('not found'),
    ),
  ).toBe(true);
  const sales = await authz.permissionSets.get('sales');
  expect(
    grantsOf(sales!)
      .filter(isItemsGrant)
      .map((grant) => grant.resource.type)
      .sort(),
  ).toEqual(['composite', 'page']);
});

test('升级命令挂在 authz 主题下，声明与 seed 一致', () => {
  expect(AuthzUpgradeR019Page.summary).toContain('purchase');
  expect(AuthzUpgradeR019Page.summary).toContain('sales');
  expect(AuthzUpgradeR019Page.description).toContain('"items"');
  expect(AuthzUpgradeR019Page.description).toContain(
    'never grants items.manage',
  );
});

/** 只补业务授权的那一半：等价于先跑过 upgrade-r021。 */
async function upgradeR021Only(authz: AppAuthorization): Promise<void> {
  const { upgradeR021 } = await import('../../cli/authz/upgrade-r021.js');
  await upgradeR021({ authorization: authz }, { info: () => undefined });
}

/* -------------------------------------------------------------------------- */
/* R-019 加片：upgrade-r019-price 只给两个角色各补一个价格动作                  */
/* -------------------------------------------------------------------------- */

const priceServices = (app: Parameters<typeof services>[0]): R019PriceUpgradeServices => ({
  authorization: app.container.resolve(authorizationToken),
});

/** 价格授权单独成一条 composite/items grant，删掉它才等于升级前的环境。 */
const isPriceGrant = (grant: JsonGrant): boolean =>
  grant.resource.type === 'composite' &&
  grant.resource.id === 'items' &&
  grant.actions.some(
    (entry) =>
      entry.action === PURCHASE_PRICE_ACTION || entry.action === SALES_PRICE_ACTION,
  );

async function makeOldPrice(
  connection: DatabaseConnection,
  authz: AppAuthorization,
): Promise<void> {
  for (const key of PRICE_TARGETS) {
    const set = await authz.permissionSets.get(key);
    if (!set) throw new Error(`permission set ${key} is missing`);
    const next = grantsOf(set).filter((grant) => !isPriceGrant(grant));
    await connection.query
      .updateTable('authorizationPermissionSets')
      .set({ grants: JSON.stringify(next) })
      .where('key', '=', key)
      .execute();
  }
}

test('新环境 seed：采购拿采购价、销售拿销售价，不交叉、仓管两个都没有', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const buyer = await createPerson(users, 'r019pricebuyer', ['purchase']);
  const seller = await createPerson(users, 'r019priceseller', ['sales']);
  const keeper = await createPerson(users, 'r019pricekeeper', ['warehouse']);
  expect(
    await can(authz, buyer, itemsResource, PURCHASE_PRICE_ACTION),
  ).toBe(true);
  expect(await can(authz, buyer, itemsResource, SALES_PRICE_ACTION)).toBe(false);
  expect(
    await can(authz, seller, itemsResource, SALES_PRICE_ACTION),
  ).toBe(true);
  expect(await can(authz, seller, itemsResource, PURCHASE_PRICE_ACTION)).toBe(false);
  expect(await can(authz, keeper, itemsResource, PURCHASE_PRICE_ACTION)).toBe(false);
  expect(await can(authz, keeper, itemsResource, SALES_PRICE_ACTION)).toBe(false);
});

test('旧环境只补两个价格动作：原有授权不动、revision 更新，重跑不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOldPrice(connection, authz);
  const buyer = await createPerson(users, 'r019upgradepricebuyer', ['purchase']);
  const seller = await createPerson(users, 'r019upgradepriceseller', ['sales']);
  // 前置条件：升级前两个角色都没有价格动作。
  expect(await can(authz, buyer, itemsResource, PURCHASE_PRICE_ACTION)).toBe(false);
  expect(await can(authz, seller, itemsResource, SALES_PRICE_ACTION)).toBe(false);

  const before = new Map<string, Snapshot>();
  for (const key of [...PRICE_TARGETS, ...OTHERS])
    before.set(key, await snapshot(authz, key));

  const report = await upgradeR019Price(priceServices(app), {
    info: () => undefined,
  });
  expect(report.changed).toEqual([...PRICE_TARGETS]);
  expect(report.unchanged).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.invalid).toEqual([]);

  for (const key of PRICE_TARGETS) {
    const old = before.get(key)!;
    const now = await snapshot(authz, key);
    // 原有授权一条不动、顺序不变，新补的价格动作接在后面。
    expect(now.grants.slice(0, old.grants.length)).toEqual(old.grants);
    expect(now.grants.slice(old.grants.length).filter(isPriceGrant)).toHaveLength(1);
    expect(now.revision).not.toBe(old.revision);
  }
  for (const key of OTHERS)
    expect(await snapshot(authz, key)).toEqual(before.get(key));
  expect(await can(authz, buyer, itemsResource, PURCHASE_PRICE_ACTION)).toBe(true);
  expect(await can(authz, buyer, itemsResource, SALES_PRICE_ACTION)).toBe(false);
  expect(await can(authz, seller, itemsResource, SALES_PRICE_ACTION)).toBe(true);
  expect(await can(authz, seller, itemsResource, PURCHASE_PRICE_ACTION)).toBe(false);

  // 记下第一次升级之后的状态，重跑必须逐字节回到这里。
  const afterFirst = new Map<string, Snapshot>();
  for (const key of [...PRICE_TARGETS, ...OTHERS])
    afterFirst.set(key, await snapshot(authz, key));
  const second = await upgradeR019Price(priceServices(app), {
    info: () => undefined,
  });
  expect(second.changed).toEqual([]);
  expect(second.unchanged).toEqual([...PRICE_TARGETS]);
  for (const key of [...PRICE_TARGETS, ...OTHERS])
    expect(await snapshot(authz, key), `${key} 重跑不该变化`).toEqual(
      afterFirst.get(key),
    );
});

test('声明对不上时整条跳过；角色不存在记一行跳过，另一个照常补', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOldPrice(connection, authz);
  const before = new Map<string, Snapshot>();
  for (const key of PRICE_TARGETS) before.set(key, await snapshot(authz, key));
  const real = authz.compositeResources.getAction.bind(authz.compositeResources);
  const spy = vi
    .spyOn(authz.compositeResources, 'getAction')
    .mockImplementation((id, action) =>
      id === 'items' ? undefined : real(id, action),
    );
  try {
    const report = await upgradeR019Price(priceServices(app), {
      info: () => undefined,
    });
    expect(report.invalid).toEqual([...PRICE_TARGETS]);
    expect(report.changed).toEqual([]);
    for (const key of PRICE_TARGETS)
      expect(await snapshot(authz, key)).toEqual(before.get(key));
  } finally {
    spy.mockRestore();
  }

  await connection.query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'purchase')
    .execute();
  const lines: string[] = [];
  const report = await upgradeR019Price(priceServices(app), {
    info: (line) => lines.push(line),
  });
  expect(report.missing).toEqual(['purchase']);
  expect(report.changed).toEqual(['sales']);
  expect(
    lines.some((line) => line.includes('purchase') && line.includes('not found')),
  ).toBe(true);
});

test('升级命令挂在 authz 主题下，动作清单只含各自的价格动作', () => {
  expect(AuthzUpgradeR019Price.summary).toContain('purchase');
  expect(AuthzUpgradeR019Price.summary).toContain('sales');
  expect(AuthzUpgradeR019Price.description).toContain(PURCHASE_PRICE_ACTION);
  expect(AuthzUpgradeR019Price.description).toContain(SALES_PRICE_ACTION);
  expect(AuthzUpgradeR019Price.description).toContain('no other role');
  expect(neededGrants('purchase')).toEqual([
    {
      resource: { type: 'composite', id: 'items' },
      actions: [{ action: PURCHASE_PRICE_ACTION }],
    },
  ]);
  expect(neededGrants('sales')).toEqual([
    {
      resource: { type: 'composite', id: 'items' },
      actions: [{ action: SALES_PRICE_ACTION }],
    },
  ]);
});
