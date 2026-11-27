import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
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

/** R-003 S2：部门主管的「查看」只配工单表的「本部门及下级」。 */
const deptFqcScopes = { fqcTickets: 'org.myDepartmentsAndBelow' };

/** R-026「提交反馈」：两张表都只有「仅本人」。 */
const submitFqcScopes = {
  fqcMessages: 'recordsIOwn',
  fqcScreenings: 'recordsIOwn',
};

/** R-026「维护反馈单」：三张表都是「全部」。 */
const maintainFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
};

const pageGrant = {
  resource: { type: 'page', id: 'quality' },
  actions: [{ action: 'access' }],
};

/** R-026：反馈单页的页面授权。 */
const feedbackPageGrant = {
  resource: { type: 'page', id: 'feedback' },
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

const qualityViewScopes = {
  ...qualityFqcScopes,
  fqcRoutingRules: 'allRecords',
};
const qualityHandleScopes = {
  ...qualityFqcScopes,
  fqcRoutingRules: 'allRecords',
};
const ticketScopes = { fqcTickets: 'allRecords' };
const configureScopes = { fqcRoutingRules: 'allRecords' };

const fqcTicket = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'ticket', policy: { type: 'composite', scopes: ticketScopes } },
  ],
};

const fqcConfigure = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'configure',
      policy: { type: 'composite', scopes: configureScopes },
    },
  ],
};

const fqcView = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: qualityViewScopes } },
  ],
};

const fqcInspectorView = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: qualityFqcScopes } },
  ],
};

const fqcHandle = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'handle',
      policy: { type: 'composite', scopes: qualityHandleScopes },
    },
  ],
};

const fqcViewOnly = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: deptFqcScopes } },
  ],
};

/** R-026：两个新动作各自成一条授权，不并进上面那条「查看、处理」。 */
const fqcSubmit = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'submit', policy: { type: 'composite', scopes: submitFqcScopes } },
  ],
};

const fqcMaintain = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'maintain',
      policy: { type: 'composite', scopes: maintainFqcScopes },
    },
  ],
};

/** R-025：班次定义不是人员信息，独立资源；staff 只读，没有 policy、没有页面授权。 */
const shiftsViewGrant = {
  resource: { type: 'composite', id: 'shifts' },
  actions: [{ action: 'view' }],
};

/** R-014：销售只拿 customers，采购只拿 suppliers，各三个动作。 */
const customerGrant = {
  resource: { type: 'composite', id: 'customers' },
  actions: [
    { action: 'view' },
    { action: 'create' },
    { action: 'update' },
  ],
};
const supplierGrant = {
  resource: { type: 'composite', id: 'suppliers' },
  actions: [
    { action: 'view' },
    { action: 'create' },
    { action: 'update' },
  ],
};

/** R-020：仓管五个库存动作，不含 warehouseManage，没有页面授权。 */
const inventoryGrant = {
  resource: { type: 'composite', id: 'inventory' },
  actions: [
    { action: 'warehouseView' },
    { action: 'stockView' },
    { action: 'stockWrite' },
    { action: 'stockPost' },
    { action: 'stockVoid' },
  ],
};

const expectedRoles = {
  quality_manager: {
    title: { key: 'permissionSets.business.qualityManager', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcView,
      fqcHandle,
      fqcTicket,
      fqcConfigure,
      feedbackPageGrant,
      fqcSubmit,
      fqcMaintain,
      knowledgePageGrant,
      knowledgeGrant('manage.related'),
    ],
  },
  quality_inspector: {
    title: { key: 'permissionSets.business.qualityInspector', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcInspectorView,
      fqcHandle,
      fqcTicket,
      feedbackPageGrant,
      fqcSubmit,
      fqcMaintain,
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
    grants: [feedbackPageGrant, fqcSubmit, shiftsViewGrant],
  },
  warehouse: {
    title: { key: 'permissionSets.business.warehouse', ns: 'app-local' },
    grants: [inventoryGrant],
  },
  sales: {
    title: { key: 'permissionSets.business.sales', ns: 'app-local' },
    grants: [customerGrant],
  },
  purchase: {
    title: { key: 'permissionSets.business.purchase', ns: 'app-local' },
    grants: [supplierGrant],
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

test('R-013: declares the keys, titles and grants of the designed roles', () => {
  expect(businessPermissionSets.map((set) => set.key)).toEqual(roleKeys);
  for (const set of businessPermissionSets) {
    const expected = expectedRoles[set.key as keyof typeof expectedRoles];
    expect(set.title).toEqual(expected.title);
    expect(set.grants).toEqual(expected.grants);
  }
});

test('R-013: the seed creates the designed roles', async ({
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

/** 建一个持有所给角色的用户；用户名只收字母数字。 */
const createRoleUser = async (
  admin: Awaited<ReturnType<typeof signIn>>,
  name: string,
  role: string,
): Promise<string> => {
  const username = name.replace(/-/gu, '');
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name,
      username,
      email: `${username}@example.test`,
      password: 'R026-seed-test-123!',
      roleScopes: { app: [role] },
    }),
  });
  expect(response.status, `建用户 ${name} 失败`).toBe(201);
  return ((await response.json()).data as { id: string }).id;
};

/** R-017 S1：审批三张表，seed 里没有任何业务角色拿到授权。 */
const APPROVAL_TABLES = ['approvals', 'approvalRounds', 'approvalRecords'];

/**
 * R-017 S1：默认拒绝要有「经过 seed 的应用」上的行为证据。
 *
 * 上一个切片的行为测试在没有跑 seed 的应用上证明的是「没授权就被拒」，证明不了
 * 「seed 没给」。这里在同一份 seed 已落库的应用上走授权服务的正式入口
 * `authz.for(...).authorize()`：staff 与零角色用户对三表的读、建、改都必须 deny，
 * 只有 root 可读写。把 seed 改成给 staff 审批读，这一条必须红。
 */
test('R-017 S1: with the seed applied, staff and a roleless user are denied on approval tables', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const staff = await createRoleUser(admin, 'r017-seed-staff', 'staff');
  const nobody = await createRoleUser(admin, 'r017-seed-nobody', 'staff');
  await authz.permissionSets.revoke(`user:${nobody}:staff`);

  const decision = (userId: string, table: string, action: string) =>
    authz
      .for({ principal: { type: 'user', id: userId } })
      .authorize({ resource: { type: 'database.collection', id: table }, action });
  const codes = (d: { reasons: readonly { code: string }[] }) =>
    d.reasons.map((reason) => reason.code);

  for (const table of APPROVAL_TABLES) {
    for (const action of ['read', 'create', 'update'] as const) {
      for (const [label, id] of [
        ['staff', staff],
        ['零角色用户', nobody],
      ] as const) {
        const denied = await decision(id, table, action);
        expect(denied.effect, `${label} 不该能 ${action} ${table}`).toBe('deny');
        expect(codes(denied), `${label} ${action} ${table} 的拒绝原因`).toContain(
          'NO_OBJECT_PERMISSION',
        );
      }
      const rootDecision = await decision(String(admin.user.id), table, action);
      expect(rootDecision.effect, `root 不能 ${action} ${table}`).not.toBe(
        'deny',
      );
    }
    const remove = await decision(String(admin.user.id), table, 'delete');
    expect(remove.effect, `delete 没有登记，root 也删得了 ${table}`).toBe(
      'deny',
    );
    expect(codes(remove)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
  }
});

// 这一条要在「管理员改过的角色不被覆盖」之前跑：那条测试会把 quality_manager 的
// 授权改成只剩页面授权，后面的测试看到的不再是 seed 的初始状态。
test('R-026 25: seed 的五个动作逐条展开，该放行的没有 NO_MATCHING_GRANT', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const cases = [
    {
      role: 'staff',
      allowed: ['submit'],
      denied: ['view', 'handle', 'intake', 'maintain'],
    },
    {
      role: 'quality_manager',
      allowed: ['view', 'handle', 'submit', 'maintain'],
      denied: ['intake'],
    },
    {
      role: 'quality_inspector',
      allowed: ['view', 'handle', 'submit', 'maintain'],
      denied: ['intake'],
    },
    {
      role: 'dept_manager',
      allowed: ['view'],
      denied: ['handle', 'intake', 'submit', 'maintain'],
    },
  ] as const;

  for (const entry of cases) {
    const userId = await createRoleUser(
      admin,
      `r026seed${entry.role.replace(/_/gu, '')}`,
      entry.role,
    );
    const context = authz.for({ principal: { type: 'user', id: userId } });
    const allowed = new Set<string>(entry.allowed);
    // R-026 的建人初始化器会给每个「人」补基线 staff。这条用例验的是 seed 里
    // 各角色自己的授权，所以把基线撤掉（staff 本身就是要验的角色，不撤），
    // 让测试用户只持有被验的那一个角色。
    if (entry.role !== 'staff') {
      await authz.permissionSets.revoke(`user:${userId}:staff`);
    }
    for (const action of [...entry.allowed, ...entry.denied]) {
      const decision = await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action,
      });
      const reasons = decision.reasons.map((reason) => reason.code);
      if (allowed.has(action)) {
        expect(decision.effect, `${entry.role} 应当能 ${action}`).not.toBe(
          'deny',
        );
        // 质量主管的「查看」「处理」没有因为加了新动作而丢。
        expect(reasons, `${entry.role} ${action} 返回 NO_MATCHING_GRANT`).not.toContain(
          'NO_MATCHING_GRANT',
        );
      } else {
        expect(decision.effect, `${entry.role} 不应当能 ${action}`).toBe('deny');
        expect(reasons, `${entry.role} ${action} 不是没有授权`).toContain(
          'NO_MATCHING_GRANT',
        );
      }
    }
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
  expect((await rowsFor()).length).toBe(roleKeys.length);

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
  expect(rows.length).toBe(roleKeys.length);
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
  expect(rows.length).toBe(roleKeys.length);
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

/**
 * R-017 S1：审批的「默认授权」是默认拒绝。
 *
 * R-017.md 把审批授权放在端点自己身上、页面取 authz='skip'，没有定义 composite
 * 资源与业务动作；seed 因此不给任何业务角色审批表的授权，也不给「用户 · 读」
 * （R-028）。后续片在端点与页面落地时按实际读写列补声明与授权，本测试守住
 * 「没有在 seed 里先放开」这一条；谁加了一条宽授权这里就红。
 */
test('R-017 S1: the seed grants no approval table and no user resource to business roles', () => {
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(
        grant.resource.type,
        `角色 ${set.key} 被授了「用户」资源`,
      ).not.toBe('user');
      if (grant.resource.type === 'database.collection') {
        expect(
          APPROVAL_TABLES,
          `角色 ${set.key} 被授了审批表 ${grant.resource.id}`,
        ).not.toContain(grant.resource.id);
      }
      const scopes = grant.actions.flatMap((action) =>
        action.policy?.type === 'composite' && action.policy.scopes
          ? Object.keys(action.policy.scopes)
          : [],
      );
      for (const table of APPROVAL_TABLES) {
        expect(
          scopes,
          `角色 ${set.key} 的授权里出现了审批表 ${table}`,
        ).not.toContain(table);
      }
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
