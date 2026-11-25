import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import businessPermissionSetsSeed, {
  businessPermissionSets,
  persistBusinessPermissionSets,
} from '../../database/main/seeds/202611240001_seed_business_permission_sets.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-013 四个业务角色的 seed（验收标准第 1 条与第 11 条的前一半）。
 *
 * 角色的定义写在 seed 文件里，先在这里断言它的形状与设计一致（key、名称、授权、
 * 数据范围全部填 allRecords、没有「用户」资源的任何动作），再让 seed 写进库。
 * seed 的行为另测三件：重复执行不重复建、管理员改过的角色不被覆盖、已有的角色
 * 被跳过之后其余的角色仍要建出来（循环里用 continue，不是 return）。
 */
/** 两个质量角色持有确认记录表的全量范围：确认要读要写这张表。 */
const qualityFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
  fqcScreeningReviews: 'allRecords',
};

/** 其余角色只覆盖三张业务表：确认记录表没配范围就是拒绝（R-003 要的收窄）。 */
const deptFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
};

const pageGrant = {
  resource: { type: 'page', id: 'quality' },
  actions: [{ action: 'access' }],
};

const knowledgePageGrant = {
  resource: { type: 'page', id: 'knowledge' },
  actions: [{ action: 'access' }],
};

/** R-002：知识库的业务键是 `{ type: 'kb', id: 'kb.knowledge' }`，动作名带档位。 */
const knowledgeGrant = (action: 'manage.related' | 'propose.related') => ({
  resource: { type: 'kb', id: 'kb.knowledge' },
  actions: [{ action }],
});

const fqcViewAndHandle = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: qualityFqcScopes } },
    {
      action: 'handle',
      policy: { type: 'composite', scopes: qualityFqcScopes },
    },
  ],
};

const fqcViewOnly = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: deptFqcScopes } },
  ],
};

const expectedRoles = {
  quality_manager: {
    title: { key: 'permissionSets.business.qualityManager', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcViewAndHandle,
      knowledgePageGrant,
      knowledgeGrant('manage.related'),
    ],
  },
  quality_inspector: {
    title: { key: 'permissionSets.business.qualityInspector', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcViewAndHandle,
      knowledgePageGrant,
      knowledgeGrant('propose.related'),
    ],
  },
  dept_manager: {
    title: { key: 'permissionSets.business.deptManager', ns: 'app-local' },
    grants: [pageGrant, fqcViewOnly],
  },
  staff: {
    title: { key: 'permissionSets.business.staff', ns: 'app-local' },
    grants: [],
  },
} as const;

const roleKeys = Object.keys(expectedRoles);

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

test('R-013: declares the keys, titles and grants of the four designed roles', () => {
  expect(businessPermissionSets.map((set) => set.key)).toEqual(roleKeys);
  for (const set of businessPermissionSets) {
    const expected = expectedRoles[set.key as keyof typeof expectedRoles];
    expect(set.title).toEqual(expected.title);
    expect(set.grants).toEqual(expected.grants);
  }
});

test('R-013: the seed creates the four roles as the design describes them', async ({
  app,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const stored = await sets.list();
  for (const [key, expected] of Object.entries(expectedRoles)) {
    const set = stored.find((entry) => entry.key === key);
    expect(set, `seed 没有建出角色 ${key}`).toBeDefined();
    expect(set?.title).toEqual(expected.title);
    expect(set?.grants).toEqual(expected.grants);
  }
});

test('R-013: does not create the same role twice and keeps administrator changes', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;

  // 重复执行：除了 seed 的历史表，seed 自己也不重复建。
  expect(await persistBusinessPermissionSets(connection.query)).toEqual([]);

  const rowsFor = async () =>
    connection.query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', 'in', roleKeys)
      .execute();
  expect((await rowsFor()).length).toBe(4);

  // 管理员改了 quality_manager 的授权，删掉另外两个角色，模拟“一部分已存在”。
  const changedGrants = [
    {
      resource: { type: 'page', id: 'quality' },
      actions: [{ action: 'access' }],
    },
  ];
  await sets.update('quality_manager', {
    key: 'quality_manager',
    grants: changedGrants,
  });
  await sets.delete('quality_inspector');
  await sets.delete('dept_manager');

  // 循环里跳过已存在的角色要用 continue：改了的不覆盖，缺的要补回来。
  expect(
    (await persistBusinessPermissionSets(connection.query)).sort(),
  ).toEqual(['dept_manager', 'quality_inspector']);

  const rows = await rowsFor();
  expect(rows.length).toBe(4);
  expect(rows.filter((row) => row.key === 'quality_manager').length).toBe(1);
  const stored = await sets.list();
  expect(stored.find((set) => set.key === 'quality_manager')?.grants).toEqual(
    changedGrants,
  );
  for (const key of ['quality_inspector', 'dept_manager']) {
    expect(stored.find((set) => set.key === key)?.grants).toEqual(
      expectedRoles[key as keyof typeof expectedRoles].grants,
    );
  }
});

test('R-013: writes no grant on the user resource for any business role', async ({
  connection,
}) => {
  const rows = await connection.query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', 'in', roleKeys)
    .execute();
  expect(rows.length).toBe(4);
  for (const row of rows) {
    const grants = JSON.parse(String(row.grants)) as {
      resource: { type: string; id: string };
      actions: { action: string }[];
    }[];
    for (const grant of grants) {
      expect(
        grant.resource.type,
        `角色 ${String(row.key)} 授予了「用户」资源：${JSON.stringify(grant)}`,
      ).not.toBe('user');
    }
  }
});

test('R-002: only the two quality roles get the confirmation-record scope in the seed', () => {
  // 确认记录表是「人的判断」。seed 只把它给两个质量角色；部门主管等角色没有这个
  // 范围键，底层就是拒绝 —— R-003 的收窄靠的就是这一点。
  for (const set of businessPermissionSets) {
    const actions = set.grants
      .filter((grant) => grant.resource.type === 'composite')
      .filter((grant) => grant.resource.id === 'fqc')
      .flatMap((grant) => grant.actions);
    const scoped = actions.some(
      (action) =>
        action.policy?.type === 'composite' &&
        action.policy.scopes !== undefined &&
        'fqcScreeningReviews' in action.policy.scopes,
    );
    expect(scoped, `角色 ${set.key} 的确认记录范围与设计不一致`).toBe(
      set.key === 'quality_manager' || set.key === 'quality_inspector',
    );
  }
});

test('R-002: the seed grants the knowledge actions the plugin registers, related not all', async ({
  app,
}) => {
  // 插件登记到授权模型的动作才是 `manage.related` / `propose.related` 这样的档位；
  // `kb.knowledge/manage` 是业务键，登记不出来。写成业务键时这里会红，角色编辑器里
  // 那一项也永远勾不上。
  const item = app.container
    .resolve(authorizationToken)
    .resourceTypes.get('kb')
    .items?.get('kb.knowledge');
  const registered = new Set(item?.actions.map((action) => action.name) ?? []);

  const knowledgeGrants = businessPermissionSets.flatMap((set) =>
    set.grants
      .filter((grant) => grant.resource.type === 'kb')
      .flatMap((grant) =>
        grant.actions.map((entry) => ({
          role: set.key,
          resourceId: grant.resource.id,
          action: entry.action,
        })),
      ),
  );
  expect(knowledgeGrants).toEqual([
    {
      role: 'quality_manager',
      resourceId: 'kb.knowledge',
      action: 'manage.related',
    },
    {
      role: 'quality_inspector',
      resourceId: 'kb.knowledge',
      action: 'propose.related',
    },
  ]);
  for (const grant of knowledgeGrants) {
    expect(
      registered.has(grant.action),
      `知识库动作 ${grant.action} 没有被插件登记`,
    ).toBe(true);
    expect(
      grant.action.endsWith('.all'),
      'seed 用 .related，不用 .all：.all 会覆盖以后新加的空间',
    ).toBe(false);
  }
  // 投递的服务账号也要有 read.related（管理员建它时的一步）：动作本身必须先被登记。
  expect(registered.has('read.related')).toBe(true);
});

test('R-013: names the seed after its file so the loader can find it', () => {
  expect(businessPermissionSetsSeed.name).toBe(
    '202611240001_seed_business_permission_sets',
  );
  expect(typeof businessPermissionSetsSeed.run).toBe('function');
});
