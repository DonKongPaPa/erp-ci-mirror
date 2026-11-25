import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import {
  authorizationToken,
  createAppAuthorization,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import type {
  AuthorizationDecision,
  CompositeResourceConditions,
} from '@nocobase/authorization/core';
import { createAppTest } from '../helpers/test-app.js';
import type { RepositoryPolicy } from '@nocobase/db';
import { ServiceContainer } from '@nocobase/service-provider';
import { expect } from 'vitest';

import AuthorizationResourcesProvider from '../../server/providers/authorization-resources.js';
import {
  departmentServiceToken,
  type DepartmentService,
} from '../../server/providers/departments.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-013 FQC 接入授权模型：注册、默认拒绝、服务层的判定结果、超管只有 root。
 *
 * 验收标准第 2、3、4 条。第 3 条这一版用服务层的 `authz.for(principal)` 判定代替
 * 端点断言 —— 端点要到第 2 段才接授权。断言之前应用已经启动完成，FQC 的资源在
 * provider 的 boot() 里注册好了；没注册时连 root 也会以 RESOURCE_ACTION_NOT_SUPPORTED
 * 被拒，那样的“被拒”不算数，所以先断言注册结果。
 *
 * 业务动作的判定结果恒为「有条件放行」，只看它抓不住退化：底层的某张表被拒时，
 * 那张表的键仍在，只是对应动作的取值被折叠成 false。所以这里逐表、逐动作断言
 * `conditions.database` 的取值。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const FQC_TABLES = ['fqcMessages', 'fqcScreenings', 'fqcTickets'];
/** R-002：确认记录表。只追加，只登记读与建。 */
const REVIEW_TABLE = 'fqcScreeningReviews';
const PASSWORD = 'R013-test-123!';

/** 人工复核能改的列（R-002）：只改结论、指过去的确认记录与更新时间。 */
const SCREENING_UPDATE_FIELDS = ['outcome', 'reviewId', 'updatedAt'];

/** 投递能改的十五列（R-002）：模型版草稿值、依据、六个出处列、结论与更新时间。 */
const INTAKE_SCREENING_UPDATE_FIELDS = [
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'engine',
  'promptVersion',
  'degraded',
  'degradeReason',
  'knowledgeRefs',
  'redacted',
  'outcome',
  'updatedAt',
];

const codes = (decision: { readonly reasons: readonly { code: string }[] }) =>
  decision.reasons.map((reason) => reason.code);

type FqcDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 判定结果里每张表的四个动作。底层检查被拒时，该动作折叠成 false。 */
const databasePolicies = (
  decision: FqcDecision,
): Readonly<Record<string, RepositoryPolicy>> =>
  decision.conditions?.database ?? {};

/** 底层检查放行（有条件或有条件之外的 true）；被拒、缺项都是 false。 */
const isAllowed = (value: unknown): boolean =>
  value !== undefined && value !== false;

/** 一个写动作允许的列；没有这个动作、或动作被拒时返回 undefined。 */
const writableFields = (
  node: RepositoryPolicy['update'] | RepositoryPolicy['create'] | undefined,
): readonly string[] | undefined => {
  if (node === undefined || typeof node === 'boolean') {
    return undefined;
  }
  return node.fields === undefined || node.fields === false
    ? undefined
    : [...node.fields].sort();
};

/**
 * 「查看」：三张业务表都有读，写动作都不放行。
 *
 * 确认记录表另说：两个质量角色的查看带它的读；部门主管的查看**不带**（没配范围
 * 就是拒绝，R-003 的收窄靠这一点）。范围键仍在，只是读被折成 false。
 */
const expectView = (
  decision: FqcDecision,
  options: { readonly readsConfirmations: boolean },
) => {
  expect(decision.effect, '查看应当是「有条件放行」').toBe('conditional');
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort()).toEqual(
    [...FQC_TABLES, REVIEW_TABLE].sort(),
  );
  for (const table of [...FQC_TABLES, REVIEW_TABLE]) {
    expect(isAllowed(policies[table]?.read), `${table} 的查看没有读`).toBe(
      table === REVIEW_TABLE ? options.readsConfirmations : true,
    );
    expect(isAllowed(policies[table]?.create), `${table} 的查看带了新建`).toBe(
      false,
    );
    expect(isAllowed(policies[table]?.update), `${table} 的查看带了修改`).toBe(
      false,
    );
    expect(isAllowed(policies[table]?.delete), `${table} 的查看带了删除`).toBe(
      false,
    );
  }
};

/** 「处理」：四张表都读；初筛表只能改三列，确认记录表只能建。 */
const expectHandle = (decision: FqcDecision) => {
  expect(decision.effect, '处理应当是「有条件放行」').toBe('conditional');
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort()).toEqual(
    [...FQC_TABLES, REVIEW_TABLE].sort(),
  );
  for (const table of [...FQC_TABLES, REVIEW_TABLE]) {
    expect(isAllowed(policies[table]?.read), `${table} 的处理没有读`).toBe(
      true,
    );
    expect(isAllowed(policies[table]?.delete), `${table} 的处理带了删除`).toBe(
      false,
    );
  }
  for (const table of FQC_TABLES) {
    expect(isAllowed(policies[table]?.create), `${table} 的处理带了新建`).toBe(
      false,
    );
  }
  // 确认记录只追加：处理可以建，不能改也不能删。
  expect(
    isAllowed(policies[REVIEW_TABLE]?.create),
    '处理没有建确认记录的权利',
  ).toBe(true);
  expect(
    isAllowed(policies[REVIEW_TABLE]?.update),
    '处理不该能改确认记录',
  ).toBe(false);
  expect(
    writableFields(policies[REVIEW_TABLE]?.update),
    '处理不该能改确认记录',
  ).toBeUndefined();
  expect(
    writableFields(policies.fqcMessages?.update),
    '处理不该能改客户消息：消息原文要留痕',
  ).toBeUndefined();
  expect(
    writableFields(policies.fqcTickets?.update),
    '处理不该能改质量工单：派单与关单等它们的端点做出来再加列',
  ).toBeUndefined();
  expect(
    writableFields(policies.fqcScreenings?.update),
    '处理只该改初筛表的结论、确认记录指针与更新时间',
  ).toEqual([...SCREENING_UPDATE_FIELDS].sort());
};

/** 建一个用户；不传 roleScopes 时框架会给它 member。 */
const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes?: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      ...(roleScopes === undefined ? {} : { roleScopes }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data as { id: string };
};

/** 没有部门的部门服务：boot() 只把接口交给两把范围键，解析器在注册时不会被调用。 */
const noDepartments = (): DepartmentService => ({
  subtreeIds: async () => [],
  departmentIdsOfUser: async () => [],
  managerOf: async () => null,
  primaryDepartmentOf: async () => null,
  titlesByIds: async () => ({}),
  byCode: async () => null,
  resolveSuccessor: async () => null,
});

const registrationSnapshot = (authz: AppAuthorization) => ({
  collections: authz.database.collections.list().map((collection) => ({
    name: collection.name,
    actions: collection.actions,
  })),
  composites: authz.compositeResources.list(),
  recordAccess: authz.recordAccess.list().map((definition) => definition.key),
  placement: authz.ui.placementOf({ type: 'composite', id: 'fqc' }),
});

test('R-013: registers the three FQC tables with three actions, the fqc actions, the department access and the workspace section', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const table of FQC_TABLES) {
    expect(authz.database.collections.has(table), `${table} 没有注册`).toBe(
      true,
    );
    // 不写动作清单的话框架默认把删除也登记上，管理员就能给角色写一条「可以删质量工单」。
    const definition = authz.database.collections
      .list()
      .find((collection) => collection.name === table);
    expect(
      definition?.actions,
      `${table} 的登记动作应当只有查看、新建、修改`,
    ).toEqual(['read', 'create', 'update']);
  }
  // R-002：确认记录表只追加，登记的动作只有读与建。
  const reviews = authz.database.collections
    .list()
    .find((collection) => collection.name === REVIEW_TABLE);
  expect(reviews, `${REVIEW_TABLE} 没有注册`).toBeDefined();
  expect(reviews?.actions, '确认记录表只登记读与建').toEqual([
    'read',
    'create',
  ]);
  expect(authz.compositeResources.getAction('fqc', 'view')?.title).toEqual({
    key: 'authorization.fqc.actions.view',
    ns: 'app-local',
  });
  for (const action of ['view', 'handle', 'intake']) {
    expect(
      authz.compositeResources.getAction('fqc', action),
      `fqc.${action} 没有注册`,
    ).toBeDefined();
  }
  for (const key of ['org.myDepartments', 'org.myDepartmentsAndBelow']) {
    expect(authz.recordAccess.get(key), `${key} 没有注册`).toBeDefined();
  }
  expect(authz.ui.placementOf({ type: 'composite', id: 'fqc' })).toEqual({
    section: 'quality',
  });
  // 三张表只供业务动作展开，不进角色编辑器：没有 placement。
  for (const table of FQC_TABLES) {
    expect(
      authz.ui.placementOf({ type: 'database.collection', id: table }),
      `${table} 被放进了角色编辑器`,
    ).toBeUndefined();
  }
});

test('R-013: the role editor catalogue lists the three FQC actions and no department scope on tables without the column', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/authorization/permissionSets/options');
  expect(response.status).toBe(200);
  const options = (await response.json()).data as {
    sections: {
      name: string;
      subsections: {
        name: string;
        resources: {
          id: string;
          actions: { name: string }[];
          dataScopes?: Record<
            string,
            { key: string; collection: string; recordAccess: string[] }[]
          >;
        }[];
      }[];
    }[];
  };
  const business = options.sections.find(
    (section) => section.name === 'business',
  );
  const quality = business?.subsections.find(
    (subsection) => subsection.name === 'quality',
  );
  const fqc = quality?.resources.find((resource) => resource.id === 'fqc');
  expect(fqc, '角色编辑器的目录里没有「质量管理」下的 fqc').toBeDefined();
  expect(fqc?.actions.map((action) => action.name)).toEqual([
    'view',
    'handle',
    'intake',
  ]);
  for (const action of ['view', 'handle']) {
    const scopes = fqc?.dataScopes?.[action] ?? [];
    expect(scopes.map((scope) => scope.collection).sort()).toEqual(
      [...FQC_TABLES, REVIEW_TABLE].sort(),
    );
    for (const scope of scopes) {
      expect(scope.recordAccess).toContain('allRecords');
      if (scope.collection === REVIEW_TABLE) {
        // R-002 的确认记录表带 departmentId 列，两把部门范围键在它上面是可用的。
        expect(scope.recordAccess).toContain('org.myDepartments');
        expect(scope.recordAccess).toContain('org.myDepartmentsAndBelow');
      } else {
        // 三张业务表没有 departmentId 列，部门范围键不该出现在这里（验收第 5 条的适用面）。
        expect(scope.recordAccess).not.toContain('org.myDepartments');
        expect(scope.recordAccess).not.toContain('org.myDepartmentsAndBelow');
      }
    }
  }
  // 投递只写三张业务表，不该出现确认记录表的数据范围。
  const intakeScopes = fqc?.dataScopes?.intake ?? [];
  expect(intakeScopes.map((scope) => scope.collection).sort()).toEqual(
    [...FQC_TABLES].sort(),
  );
});

test('R-013: an unregistered collection or business action is denied even for root', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const root = authz.for({
    principal: { type: 'user', id: String(admin.user.id) },
  });

  const collection = await root.authorize({
    resource: { type: 'database.collection', id: 'r013UnregisteredTable' },
    action: 'read',
  });
  expect(collection.effect).toBe('deny');
  expect(codes(collection)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');

  const action = await root.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'r013UnregisteredAction',
  });
  expect(action.effect).toBe('deny');
  expect(codes(action)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
});

test('R-013: quality roles view and handle as designed and may not intake', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const contextFor = (id: string) =>
    authz.for({ principal: { type: 'user', id } });

  for (const [name, role] of [
    ['r013manager', 'quality_manager'],
    ['r013inspector', 'quality_inspector'],
  ] as const) {
    const user = await createUser(admin, name, { app: [role] });
    const context = contextFor(user.id);

    expectView(
      await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action: 'view',
      }),
      { readsConfirmations: true },
    );
    expectHandle(
      await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action: 'handle',
      }),
    );

    // 投递不给业务角色：带读的投递会把客户联系方式与消息原文交出去，这一段连写都不开。
    const intake = await context.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action: 'intake',
    });
    expect(intake.effect, `${role} 不应当能投递`).toBe('deny');
    expect(codes(intake)).toContain('NO_MATCHING_GRANT');
  }

  // 业务角色不带「用户 · 读」：只持有业务角色的人打用户列表接口要被拒（验收第 11 条）。
  const managerSession = await signIn(testApp, {
    username: 'r013manager',
    password: PASSWORD,
  });
  expect((await managerSession.fetch('/users')).status).toBe(403);
});

test('R-013: a department manager views and neither handles nor intakes', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r013deptmanager', {
    app: ['dept_manager'],
  });
  const context = app.container
    .resolve(authorizationToken)
    .for({ principal: { type: 'user', id: user.id } });

  expectView(
    await context.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action: 'view',
    }),
    { readsConfirmations: false },
  );
  for (const action of ['handle', 'intake']) {
    const denied = await context.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action,
    });
    expect(denied.effect, `部门主管不应当能 ${action}`).toBe('deny');
    expect(codes(denied)).toContain('NO_MATCHING_GRANT');
  }
});

test('R-013: staff, a member-only user and a user with no role are denied every action', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await createUser(admin, 'r013staff', { app: ['staff'] });
  const member = await createUser(admin, 'r013member');
  const nobody = await createUser(admin, 'r013nobody', { app: [] });

  const permissionSets =
    app.container.resolve(authorizationToken).permissionSets;
  const assignments = await permissionSets.listAssignments();
  const setsOf = (userId: string) =>
    assignments
      .filter(
        (assignment) =>
          assignment.subject.type === 'user' &&
          assignment.subject.id === userId,
      )
      .map((assignment) => assignment.permissionSet)
      .sort();

  // 先证明这三个用户的角色就是名字说的那样：不默认持有 member、也没有多出来什么。
  expect(setsOf(staff.id), '普通员工没有拿到 staff 角色').toEqual(['staff']);
  expect(setsOf(member.id), '这个用户没有拿到 member 角色').toEqual(['member']);
  expect(setsOf(nobody.id), '这个用户不该持有任何角色').toEqual([]);

  const authz = app.container.resolve(authorizationToken);
  for (const user of [staff, member, nobody]) {
    const context = authz.for({ principal: { type: 'user', id: user.id } });
    for (const action of ['view', 'handle', 'intake']) {
      const denied = await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action,
      });
      expect(denied.effect, `${user.id} 不应当能 ${action}`).toBe('deny');
      expect(codes(denied)).toContain('NO_MATCHING_GRANT');
    }
  }
});

test('R-013: root is unrestricted on the business actions, may read the tables and may not delete them', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const root = authz.for({
    principal: { type: 'user', id: String(admin.user.id) },
  });

  for (const action of ['view', 'handle', 'intake']) {
    const decision = await root.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action,
    });
    // root 不受限：跳过 grant 检查，但底层表的检查仍是带范围的 conditional。
    expect(decision.effect, `root 被拒了 fqc.${action}`).toBe('conditional');
    expect(codes(decision)).toContain('UNRESTRICTED_ACCESS');
    expect(Object.keys(decision.conditions?.database ?? {}).sort()).toEqual(
      (action === 'intake'
        ? [...FQC_TABLES]
        : [...FQC_TABLES, REVIEW_TABLE]
      ).sort(),
    );
  }
  for (const table of [...FQC_TABLES, REVIEW_TABLE]) {
    const read = await root.authorize({
      resource: { type: 'database.collection', id: table },
      action: 'read',
    });
    expect(read.effect, `root 读不了 ${table}`).not.toBe('deny');
    expect(codes(read)).toContain('UNRESTRICTED_ACCESS');

    // 删除没有登记，连 root 也拒：这是「表不登记删除」在运行期的样子。
    const remove = await root.authorize({
      resource: { type: 'database.collection', id: table },
      action: 'delete',
    });
    expect(remove.effect, `root 删得了 ${table}`).toBe('deny');
    expect(codes(remove)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
  }
  // 确认记录表只追加：修改与删除都没有登记。
  const updateReview = await root.authorize({
    resource: { type: 'database.collection', id: REVIEW_TABLE },
    action: 'update',
  });
  expect(updateReview.effect, '确认记录表不该登记修改').toBe('deny');
  expect(codes(updateReview)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
});

test('R-013: a grant holding only intake creates rows and cannot read the tables', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({
    key: 'r013intake-proxy',
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'intake',
            policy: {
              type: 'composite',
              scopes: {
                fqcMessages: 'allRecords',
                fqcScreenings: 'allRecords',
                fqcTickets: 'allRecords',
              },
            },
          },
        ],
      },
    ],
  });
  const proxy = await createUser(admin, 'r013proxy', {
    app: ['r013intake-proxy'],
  });
  const context = authz.for({ principal: { type: 'user', id: proxy.id } });

  // 先证明这份授权真的生效，否则下面的「读被拒」可能只是因为它什么都没有。
  const intake = await context.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'intake',
  });
  expect(intake.effect, '只持投递的主体投不了').not.toBe('deny');
  const policies = databasePolicies(intake);
  for (const table of FQC_TABLES) {
    expect(isAllowed(policies[table]?.create), `${table} 的投递没有建`).toBe(
      true,
    );
  }

  // 投递的授权不带读：裸读三张表都要被拒。
  for (const table of FQC_TABLES) {
    const read = await context.authorize({
      resource: { type: 'database.collection', id: table },
      action: 'read',
    });
    expect(read.effect, `只持投递的主体读得了 ${table}`).toBe('deny');
    expect(codes(read)).toContain('NO_OBJECT_PERMISSION');
  }
});

test('R-002 21: 投递对初筛表能改的十五列逐项固定，reviewId 与溯源列写不进去', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({
    key: 'r002-intake-columns',
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'intake',
            policy: {
              type: 'composite',
              scopes: {
                fqcMessages: 'allRecords',
                fqcScreenings: 'allRecords',
                fqcTickets: 'allRecords',
              },
            },
          },
        ],
      },
    ],
  });
  const proxy = await createUser(admin, 'r002intakecolumns', {
    app: ['r002-intake-columns'],
  });
  const context = authz.for({ principal: { type: 'user', id: proxy.id } });
  const intake = await context.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'intake',
  });
  const policy = databasePolicies(intake).fqcScreenings;
  expect(policy, '投递没有给出初筛表的范围').toBeDefined();

  // 二十五列之外都不给改：可写列恰好是设计列出的那十五列。
  expect(writableFields(policy?.update), '投递能改的列与设计不一致').toEqual(
    [...INTAKE_SCREENING_UPDATE_FIELDS].sort(),
  );

  const screeningId = randomUUID();
  const now = new Date('2026-11-20T10:00:00');
  await connection.repository('fqcScreenings').createOne({
    values: {
      id: screeningId,
      messageId: randomUUID(),
      category: 'dimension',
      severity: 'major',
      suggestedOwner: 'quality-dimension',
      summary: '规则版摘要',
      confidence: '0.4500',
      evidence: ['尺寸'],
      modelName: 'rule-baseline',
      outcome: 'needs-review',
      engine: 'rules',
      promptVersion: null,
      degraded: false,
      degradeReason: 'model-disabled',
      knowledgeRefs: [],
      redacted: false,
      reviewId: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  const repo = connection
    .repository('fqcScreenings')
    .withPolicy(policy as RepositoryPolicy);

  // 十五列里的四个能写。用 updateMany：投递不带读，updateOne 会先按读策略取那一行。
  await repo.updateMany({
    filter: { id: screeningId },
    values: {
      summary: '模型版摘要',
      confidence: '0.8000',
      outcome: 'auto',
      updatedAt: new Date('2026-11-20T10:01:00'),
    },
  });
  const updated = await connection
    .repository('fqcScreenings')
    .findOne({ filter: { id: screeningId } });
  expect(updated).toMatchObject({
    summary: '模型版摘要',
    outcome: 'auto',
  });

  // 主键、创建时间、两个溯源指针写不进去：授权层在仓库写入之前拒绝。
  for (const forbidden of [
    { id: randomUUID() },
    { createdAt: new Date() },
    { messageId: randomUUID() },
    { reviewId: randomUUID() },
  ]) {
    await expect(
      repo.updateMany({ filter: { id: screeningId }, values: forbidden }),
      `${Object.keys(forbidden)[0]} 不该写得进去`,
    ).rejects.toThrow();
  }
  // 被拒的写入一行都没改。
  expect(
    await connection
      .repository('fqcScreenings')
      .findOne({ filter: { id: screeningId } }),
  ).toMatchObject({ summary: '模型版摘要' });
});

test('R-013: booting the authorization resources provider twice registers once', async () => {
  // 用一个空的授权模型起 provider：应用自己那份已经注册过 fqc，再定义一次会抛
  // 「already defined」。这里验证守卫本身 —— 同一个应用上连续两次 boot() 不抛错、
  // 注册结果不变。容器就是应用给 provider 的全部上下文，所以造一个只含两个令牌的。
  const authz = createAppAuthorization({});
  const container = new ServiceContainer();
  container.instance(authorizationToken, authz);
  container.instance(departmentServiceToken, noDepartments());
  const provider = new AuthorizationResourcesProvider({
    container,
  } as unknown as AppPluginApplication);

  await provider.boot();
  const registered = registrationSnapshot(authz);
  expect(registered.collections.map((collection) => collection.name)).toEqual([
    ...FQC_TABLES,
    REVIEW_TABLE,
    'departments',
    'departmentMembers',
    'departmentMemberHistory',
    // R-011：provider 现在还注册四张员工表。
    'employees',
    'employeeChanges',
    'positions',
    'jobGrades',
  ]);
  expect(registered.composites.map((composite) => composite.name)).toContain(
    'fqc',
  );
  expect(registered.composites.map((composite) => composite.name)).toContain(
    'employees',
  );

  await expect(provider.boot()).resolves.toBeUndefined();
  expect(registrationSnapshot(authz)).toEqual(registered);
});

test('R-013: root is the only unrestricted permission set; the seeded roles stay editable', async ({
  app,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const stored = await sets.list();
  const unrestricted = stored.filter(
    (set) => sets.protection(set.key)?.unrestricted === true,
  );
  expect(unrestricted.map((set) => set.key)).toEqual(['root']);
  for (const key of [
    'quality_manager',
    'quality_inspector',
    'dept_manager',
    'staff',
  ]) {
    expect(
      sets.protection(key),
      `${key} 不该带保护标记：业务角色与管理员自建的角色同等`,
    ).toBeUndefined();
  }
});
