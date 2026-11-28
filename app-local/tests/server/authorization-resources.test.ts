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
import { expect, vi } from 'vitest';

import AuthorizationResourcesProvider from '../../server/providers/authorization-resources.js';
import { ORDER_REVIEW_COLLECTIONS } from '../../server/order-review-resources.js';
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
/** R-017 S1：审批三张表，只登记读、建、改，没有业务资源与业务动作。 */
const APPROVAL_TABLES = ['approvals', 'approvalRounds', 'approvalRecords'];
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

/** R-026：消息表原来的十一列（「查看」只读它们）。 */
const VIEW_MESSAGE_READ_FIELDS = [
  'id',
  'channel',
  'externalId',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'createdAt',
  'updatedAt',
].sort();

/** R-026：「查看」读初筛表的十九列，不含本条新加的 ownerId。 */
const VIEW_SCREENING_READ_FIELDS = [
  'id',
  'messageId',
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'outcome',
  'createdAt',
  'updatedAt',
  'engine',
  'promptVersion',
  'degraded',
  'degradeReason',
  'knowledgeRefs',
  'redacted',
  'reviewId',
].sort();

/** R-003 S2：工单表全列去掉两个停写列，逐列列出。 */
const VIEW_TICKET_READ_FIELDS = [
  'id',
  'code',
  'title',
  'description',
  'sourceMessageId',
  'screeningId',
  'category',
  'severity',
  'assigneeId',
  'state',
  'closedAt',
  'createdAt',
  'updatedAt',
  'departmentId',
  'createdBy',
  'resolution',
  'reopenCount',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
].sort();

/** 停写两列：留在表里，谁也不写、不读。 */
const STOPPED_TICKET_FIELDS = ['ownerDepartment', 'dueAt'];

/** R-003 S2：「处理」建工单的列（数据模型里会写的列，不含停写两列）。 */
const HANDLE_TICKET_CREATE_FIELDS = [
  'id',
  'code',
  'title',
  'description',
  'sourceMessageId',
  'screeningId',
  'category',
  'severity',
  'departmentId',
  'createdBy',
  'assigneeId',
  'state',
  'closedAt',
  'createdAt',
  'updatedAt',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
].sort();

/** 改判只改类别与严重度。 */
const HANDLE_TICKET_UPDATE_FIELDS = ['category', 'severity'].sort();

/** 派单规则只读类别与责任部门；整体替换时写四列，改只写后三列。 */
const ROUTING_READ_FIELDS = ['category', 'departmentId'].sort();
const ROUTING_CREATE_FIELDS = [
  'category',
  'departmentId',
  'updatedAt',
  'updatedBy',
].sort();
const ROUTING_UPDATE_FIELDS = [
  'departmentId',
  'updatedAt',
  'updatedBy',
].sort();

/** R-026：「提交反馈」读消息表的十九列、建十七列，建初筛表十五列。 */
const SUBMIT_MESSAGE_READ_FIELDS = [
  'id',
  'channel',
  'externalId',
  'senderName',
  'senderContact',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'ownerId',
  'discardedAt',
  'discardReason',
  'createdAt',
  'updatedAt',
].sort();

const SUBMIT_MESSAGE_CREATE_FIELDS = [
  'id',
  'channel',
  'externalId',
  'senderName',
  'senderContact',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'ownerId',
  'createdAt',
  'updatedAt',
].sort();

const SUBMIT_SCREENING_CREATE_FIELDS = [
  'id',
  'messageId',
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'outcome',
  'degradeReason',
  'knowledgeRefs',
  'ownerId',
  'createdAt',
  'updatedAt',
].sort();

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

/** 一个写动作允许的列；没有这个动作、动作被拒时返回 undefined。 */
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

/** 一个读动作允许的列；全列时返回 undefined。 */
const readableFields = (
  node: RepositoryPolicy['read'] | undefined,
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
 *
 * R-026 把消息表与初筛表的读收成清单：前者是原来的十一列，后者是原来的十九列
 * （不含 ownerId）。部门主管也持「查看」，本条新加的十列一列也读不到。
 */
const expectView = (
  decision: FqcDecision,
  options: {
    readonly readsConfirmations: boolean;
    readonly readsRouting: boolean;
    readonly readsMessages?: boolean;
    readonly readsScreenings?: boolean;
  },
) => {
  expect(decision.effect, '查看应当是「有条件放行」').toBe('conditional');
  const policies = databasePolicies(decision);
  const VIEW_TABLES = [...FQC_TABLES, REVIEW_TABLE, 'fqcRoutingRules'];
  // 未配范围的键仍在决策里，只是读被折成 false（框架回 NO_RECORD_ACCESS）。
  expect(Object.keys(policies).sort()).toEqual(VIEW_TABLES.sort());
  for (const table of VIEW_TABLES) {
    const allowed =
      table === REVIEW_TABLE
        ? options.readsConfirmations
        : table === 'fqcRoutingRules'
          ? options.readsRouting
          : table === 'fqcMessages'
            ? (options.readsMessages ?? true)
            : table === 'fqcScreenings'
              ? (options.readsScreenings ?? true)
              : true;
    expect(isAllowed(policies[table]?.read), `${table} 的查看读`).toBe(allowed);
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
  if (isAllowed(policies.fqcMessages?.read)) {
    expect(
      readableFields(policies.fqcMessages?.read),
      '查看对消息表不是收窄后的九列',
    ).toEqual(VIEW_MESSAGE_READ_FIELDS);
    for (const field of ['senderName', 'senderContact']) {
      expect(
        readableFields(policies.fqcMessages?.read) ?? [],
        `查看不该读到消息表的 ${field}`,
      ).not.toContain(field);
    }
  }
  if (isAllowed(policies.fqcScreenings?.read)) {
    expect(
      readableFields(policies.fqcScreenings?.read),
      '查看对初筛表不是原来的十九列',
    ).toEqual(VIEW_SCREENING_READ_FIELDS);
  }
  expect(
    readableFields(policies.fqcScreenings?.read) ?? [],
    '查看对初筛表的读里出现了 ownerId',
  ).not.toContain('ownerId');
  // R-003 S2：最终契约——七列读得到，停写两列读不到。
  if (isAllowed(policies.fqcTickets?.read)) {
    expect(
      readableFields(policies.fqcTickets?.read),
      '查看对工单表不是最终列清单',
    ).toEqual(VIEW_TICKET_READ_FIELDS);
  }
  for (const field of STOPPED_TICKET_FIELDS) {
    expect(
      readableFields(policies.fqcTickets?.read) ?? [],
      `查看读到了停写列 ${field}`,
    ).not.toContain(field);
  }
  if (options.readsRouting) {
    expect(
      readableFields(policies.fqcRoutingRules?.read),
      '查看对派单规则只读类别与责任部门',
    ).toEqual(ROUTING_READ_FIELDS);
  } else {
    expect(
      isAllowed(policies.fqcRoutingRules?.read),
      '部门主管不该读到派单规则',
    ).toBe(false);
  }
};

/** 「处理」：五张表都读；初筛改三列，工单建行与改判两列，确认记录只建。 */
const expectHandle = (decision: FqcDecision) => {
  expect(decision.effect, '处理应当是「有条件放行」').toBe('conditional');
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort()).toEqual(
    [...FQC_TABLES, REVIEW_TABLE, 'fqcRoutingRules'].sort(),
  );
  for (const table of [...FQC_TABLES, REVIEW_TABLE, 'fqcRoutingRules']) {
    expect(isAllowed(policies[table]?.read), `${table} 的处理没有读`).toBe(
      true,
    );
    expect(isAllowed(policies[table]?.delete), `${table} 的处理带了删除`).toBe(
      false,
    );
  }
  for (const table of FQC_TABLES.filter((table) => table !== 'fqcTickets')) {
    expect(isAllowed(policies[table]?.create), `${table} 的处理带了新建`).toBe(
      false,
    );
  }
  expect(
    writableFields(policies.fqcTickets?.create),
    '处理建工单的列与设计不一致',
  ).toEqual(HANDLE_TICKET_CREATE_FIELDS);
  expect(
    readableFields(policies.fqcRoutingRules?.read),
    '处理对派单规则只读类别与责任部门',
  ).toEqual(ROUTING_READ_FIELDS);
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
    '改判只能改工单的类别与严重度',
  ).toEqual(HANDLE_TICKET_UPDATE_FIELDS);
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

test('R-003 S2: 处理工单与维护派单规则按设计逐列放开', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r003s2newactions', {
    app: ['quality_manager'],
  });
  const authz = app.container.resolve(authorizationToken);
  const context = authz.for({ principal: { type: 'user', id: user.id } });

  const ticket = await context.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'ticket',
  });
  expect(ticket.effect, '处理工单应当有条件放行').toBe('conditional');
  const ticketPolicies = databasePolicies(ticket);
  expect(Object.keys(ticketPolicies).sort()).toEqual(['fqcTickets']);
  expect(
    writableFields(ticketPolicies.fqcTickets?.create),
    '处理工单不该建工单',
  ).toBeUndefined();
  expect(
    writableFields(ticketPolicies.fqcTickets?.update),
    '处理工单改的列与设计不一致',
  ).toEqual(
    [
      'assigneeId',
      'resolution',
      'reopenCount',
      'departmentId',
      'closedAt',
      'statusChangedAt',
      'lifecycleVersion',
      'lifecycleDefinition',
    ].sort(),
  );
  expect(
    writableFields(ticketPolicies.fqcTickets?.update) ?? [],
    '处理工单不该直接写状态列',
  ).not.toContain('state');

  const configure = await context.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'configure',
  });
  expect(configure.effect, '维护派单规则应当有条件放行').toBe('conditional');
  const routing = databasePolicies(configure);
  expect(Object.keys(routing).sort()).toEqual(['fqcRoutingRules']);
  expect(readableFields(routing.fqcRoutingRules?.read)).toEqual(
    ROUTING_READ_FIELDS,
  );
  expect(writableFields(routing.fqcRoutingRules?.create)).toEqual(
    ROUTING_CREATE_FIELDS,
  );
  expect(writableFields(routing.fqcRoutingRules?.update)).toEqual(
    ROUTING_UPDATE_FIELDS,
  );
  expect(
    isAllowed(routing.fqcRoutingRules?.delete),
    '派单规则不该登记删除',
  ).toBe(false);
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
  const routing = authz.database.collections
    .list()
    .find((collection) => collection.name === 'fqcRoutingRules');
  expect(routing, '派单规则表没有注册').toBeDefined();
  expect(routing?.actions, '派单规则表登记的动作').toEqual([
    'read',
    'create',
    'update',
  ]);
  expect(authz.compositeResources.getAction('fqc', 'view')?.title).toEqual({
    key: 'authorization.fqc.actions.view',
    ns: 'app-local',
  });
  for (const action of [
    'view',
    'handle',
    'intake',
    'submit',
    'maintain',
    'ticket',
    'configure',
  ]) {
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

/**
 * R-017 S1：审批三张表的登记形状。
 *
 * 设计把审批授权放在端点自己身上、页面取 authz='skip'，没有给出业务资源与动作；
 * 所以只登记表，动作恰好是 read/create/update（多登记一个 delete 就红），不建
 * `approvals` composite，也不把表放进角色编辑器。root 也不能删这三张表。
 */
test('R-017 S1: registers the three approval tables with exactly read/create/update and no business action', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const table of APPROVAL_TABLES) {
    expect(authz.database.collections.has(table), `${table} 没有注册`).toBe(
      true,
    );
    const definition = authz.database.collections
      .list()
      .find((collection) => collection.name === table);
    expect(
      definition?.actions,
      `${table} 的登记动作应当只有读、建、改`,
    ).toEqual(['read', 'create', 'update']);
    expect(
      authz.ui.placementOf({ type: 'database.collection', id: table }),
      `${table} 被放进了角色编辑器`,
    ).toBeUndefined();
  }
  expect(
    authz.compositeResources.list().some((resource) => resource.name === 'approvals'),
    '设计没有审批业务资源，不该注册 approvals composite',
  ).toBe(false);

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const root = authz.for({
    principal: { type: 'user', id: String(admin.user.id) },
  });
  for (const table of APPROVAL_TABLES) {
    const read = await root.authorize({
      resource: { type: 'database.collection', id: table },
      action: 'read',
    });
    expect(read.effect, `root 读不了 ${table}`).not.toBe('deny');
    const remove = await root.authorize({
      resource: { type: 'database.collection', id: table },
      action: 'delete',
    });
    expect(remove.effect, `root 删得了 ${table}`).toBe('deny');
    expect(codes(remove)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
  }
});

/**
 * R-017 S1 的形状在 M3 被新种子延伸，原文保留在下面这条注释里：
 * 原写「staff 对三表的读、建、改都为 deny:NO_OBJECT_PERMISSION」。M3 给 staff
 * 挂了 `approval.submit`（approvals 按 applicantId 仅本人）与 `approval.review`
 * （approvalRecords 按 assigneeId 仅本人），所以这两张表变成 conditional，
 * approvalRounds 仍默认拒绝；零角色用户仍是 deny。这里逐表断言新的精确形状。
 *
 * > Status: Outdated（2026-11-28，R-017 M3 给 staff 补了两个仅本人动作）
 * 上面那句「staff 对三表都为 deny」只适用于 S1。
 */
test('R-017 S1: business roles are denied on approval tables while root may read and write', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const staff = await createUser(admin, 'r017s1staff', { app: ['staff'] });
  const nobody = await createUser(admin, 'r017s1nobody', { app: [] });
  // 建人初始化器会补基线 staff；把它撤掉，留一个真正的零角色主体。
  await authz.permissionSets.revoke(`user:${nobody.id}:staff`);

  const decision = (userId: string, table: string, action: string) =>
    authz
      .for({ principal: { type: 'user', id: userId } })
      .authorize({ resource: { type: 'database.collection', id: table }, action });

  const rootId = String(admin.user.id);
  for (const table of APPROVAL_TABLES) {
    for (const action of ['read', 'create', 'update'] as const) {
      const rootDecision = await decision(rootId, table, action);
      expect(rootDecision.effect, `root 不能 ${action} ${table}`).not.toBe(
        'deny',
      );
      const staffDecision = await decision(staff.id, table, action);
      if (table === 'approvalRounds') {
        expect(staffDecision.effect, `approvalRounds 不该放开 ${action}`).toBe('deny');
        expect(codes(staffDecision)).toContain('NO_OBJECT_PERMISSION');
      } else {
        expect(
          staffDecision.effect,
          `staff 只能有仅本人的 ${action} ${table}`,
        ).toBe('conditional');
      }
      const denied = await decision(nobody.id, table, action);
      expect(denied.effect, `零角色用户不该能 ${action} ${table}`).toBe('deny');
      expect(codes(denied), `零角色用户 ${action} ${table} 的拒绝原因`).toContain(
        'NO_OBJECT_PERMISSION',
      );
    }
    const remove = await decision(rootId, table, 'delete');
    expect(remove.effect, `delete 没有登记，root 也删得了 ${table}`).toBe(
      'deny',
    );
    expect(codes(remove)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
  }
});

test('R-013: the role editor catalogue lists the five FQC actions and no department scope on tables without the column', async ({
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
            {
              key: string;
              collection: string;
              recordAccess: string[];
              defaultValue?: string;
            }[]
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
    'ticket',
    'configure',
    'submit',
    'maintain',
  ]);
  for (const action of ['view', 'handle']) {
    const scopes = fqc?.dataScopes?.[action] ?? [];
    expect(scopes.map((scope) => scope.collection).sort()).toEqual(
      [...FQC_TABLES, REVIEW_TABLE, 'fqcRoutingRules'].sort(),
    );
    for (const scope of scopes) {
      expect(scope.recordAccess).toContain('allRecords');
      if (
        scope.collection === REVIEW_TABLE ||
        scope.collection === 'fqcTickets' ||
        // 派单规则表也有 departmentId 列，框架的部门范围键会出现在目录里；
        // 目录列出可用范围不等于把范围配给了部门主管（seed 不配）。
        scope.collection === 'fqcRoutingRules'
      ) {
        // R-002 的确认记录表带 departmentId 列。R-003 设计「授权与暴露面」一节
        // （「为什么要把『处理工单』拆出来」与「默认授权」）给工单表加了这一列，
        // 部门主管的「查看」按它收成「本部门及下级」，所以两把部门范围键在这里可用。
        // 列的填充与范围真正生效在后面的片：S2 收口授权、S4 解析范围、S5 流转。
        expect(scope.recordAccess).toContain('org.myDepartments');
        expect(scope.recordAccess).toContain('org.myDepartmentsAndBelow');
      } else {
        // 剩下两张业务表没有 departmentId 列，部门范围键不该出现在这里（验收第 5 条的适用面）。
        expect(scope.recordAccess).not.toContain('org.myDepartments');
        expect(scope.recordAccess).not.toContain('org.myDepartmentsAndBelow');
      }
    }
  }
  // R-003 S2：处理工单只展开工单表，维护派单规则只展开派单规则表。
  expect(
    (fqc?.dataScopes?.ticket ?? []).map((scope) => scope.collection).sort(),
  ).toEqual(['fqcTickets']);
  expect(
    (fqc?.dataScopes?.configure ?? []).map((scope) => scope.collection).sort(),
  ).toEqual(['fqcRoutingRules']);
  // 投递只写三张业务表，不该出现确认记录表的数据范围。
  const intakeScopes = fqc?.dataScopes?.intake ?? [];
  // R-003 S2：投递不再建工单，目录里只剩消息与初筛两张表。
  expect(intakeScopes.map((scope) => scope.collection).sort()).toEqual([
    'fqcMessages',
    'fqcScreenings',
  ]);
  // R-026：提交反馈只有两张表，且只有「仅本人」一档，默认也是它。
  const submitScopes = fqc?.dataScopes?.submit ?? [];
  expect(submitScopes.map((scope) => scope.collection).sort()).toEqual([
    'fqcMessages',
    'fqcScreenings',
  ]);
  for (const scope of submitScopes) {
    expect(scope.recordAccess, `${scope.collection} 的范围选项不是只有仅本人`).toEqual(
      ['recordsIOwn'],
    );
    expect(scope.defaultValue, `${scope.collection} 的默认范围不是仅本人`).toBe(
      'recordsIOwn',
    );
  }
  // R-026：维护反馈单三张表，且只有「全部」一档，默认也是它。
  const maintainScopes = fqc?.dataScopes?.maintain ?? [];
  expect(maintainScopes.map((scope) => scope.collection).sort()).toEqual(
    [...FQC_TABLES].sort(),
  );
  for (const scope of maintainScopes) {
    expect(scope.recordAccess, `${scope.collection} 的范围选项不是只有全部`).toEqual(
      ['allRecords'],
    );
    expect(scope.defaultValue, `${scope.collection} 的默认范围不是全部`).toBe(
      'allRecords',
    );
  }
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
      {
        readsConfirmations: true,
        readsRouting: name === 'r013manager',
      },
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
    {
      readsConfirmations: false,
      readsRouting: false,
      readsMessages: false,
      readsScreenings: false,
    },
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

test('R-013: staff and a member-only user (both carrying the baseline staff) may submit feedback and nothing else; a user with no role is denied every action', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await createUser(admin, 'r013staff', { app: ['staff'] });
  const member = await createUser(admin, 'r013member');
  const nobody = await createUser(admin, 'r013nobody', { app: [] });

  const permissionSets =
    app.container.resolve(authorizationToken).permissionSets;
  // R-026 的基线 staff 在建人时自动补，person 账号建不出「没有任何角色」；
  // 把基线撤掉，留一个真正的零赋值主体给这条用例。
  await permissionSets.revoke(`user:${nobody.id}:staff`);
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

  // 先证明这三个用户的角色就是名字说的那样：member 之外都带着 R-026 的基线 staff。
  expect(setsOf(staff.id), '普通员工没有拿到 staff 角色').toEqual(['staff']);
  expect(setsOf(member.id), '这个用户没有拿到 member 角色').toEqual([
    'member',
    'staff',
  ]);
  expect(setsOf(nobody.id), '这个用户不该持有任何角色').toEqual([]);

  const authz = app.container.resolve(authorizationToken);
  // R-026：「提交反馈」是普通员工唯一能用的动作；其余四个仍然被拒。
  const staffContext = authz.for({
    principal: { type: 'user', id: staff.id },
  });
  const submit = await staffContext.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'submit',
  });
  expect(submit.effect, '普通员工不能提交反馈').toBe('conditional');
  expect(codes(submit)).not.toContain('NO_MATCHING_GRANT');
  for (const action of ['view', 'handle', 'intake', 'maintain']) {
    const denied = await staffContext.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action,
    });
    expect(denied.effect, `普通员工不该能 ${action}`).toBe('deny');
    expect(codes(denied)).toContain('NO_MATCHING_GRANT');
  }
  for (const user of [member, nobody]) {
    const context = authz.for({ principal: { type: 'user', id: user.id } });
    // 只持 member 的账号也带 R-026 的基线 staff，所以也能提交（仅本人）；
    // 撤销了基线账号的 nobody 什么都不能。
    const submit = await context.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action: 'submit',
    });
    if (user === member) {
      expect(submit.effect, '持 member 的账号也带基线 staff，应当能提交').toBe(
        'conditional',
      );
    } else {
      expect(submit.effect, '这个用户不应当能 submit').toBe('deny');
      expect(codes(submit)).toContain('NO_MATCHING_GRANT');
    }
    for (const action of ['view', 'handle', 'intake', 'maintain']) {
      const denied = await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action,
      });
      expect(denied.effect, `${user.id} 不应当能 ${action}`).toBe('deny');
      expect(codes(denied)).toContain('NO_MATCHING_GRANT');
    }
  }
});

test('R-026 23: 普通员工持有的「提交反馈」建列、改列与初筛的不读逐项固定', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const staff = await createUser(admin, 'r026submitstaff', { app: ['staff'] });
  const decision = await app.container
    .resolve(authorizationToken)
    .for({ principal: { type: 'user', id: staff.id } })
    .authorize({ resource: { type: 'composite', id: 'fqc' }, action: 'submit' });
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort()).toEqual(['fqcMessages', 'fqcScreenings']);
  expect(
    readableFields(policies.fqcMessages?.read),
    '提交反馈读消息表的列与设计不一致',
  ).toEqual(SUBMIT_MESSAGE_READ_FIELDS);
  expect(
    writableFields(policies.fqcMessages?.create),
    '提交反馈建消息表的列与设计不一致',
  ).toEqual(SUBMIT_MESSAGE_CREATE_FIELDS);
  expect(
    writableFields(policies.fqcMessages?.update),
    '提交反馈不该能改消息表',
  ).toBeUndefined();
  expect(
    writableFields(policies.fqcScreenings?.create),
    '提交反馈建初筛表的列与设计不一致',
  ).toEqual(SUBMIT_SCREENING_CREATE_FIELDS);
  expect(
    writableFields(policies.fqcScreenings?.update),
    '提交反馈改初筛表的列与投递不一致',
  ).toEqual([...INTAKE_SCREENING_UPDATE_FIELDS].sort());
  expect(
    isAllowed(policies.fqcScreenings?.read),
    '提交反馈不该能读初筛表',
  ).toBe(false);
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

  for (const action of [
    'view',
    'handle',
    'intake',
    'submit',
    'maintain',
    'ticket',
    'configure',
  ]) {
    const decision = await root.authorize({
      resource: { type: 'composite', id: 'fqc' },
      action,
    });
    // root 不受限：跳过 grant 检查，但底层表的检查仍是带范围的 conditional。
    expect(decision.effect, `root 被拒了 fqc.${action}`).toBe('conditional');
    expect(codes(decision)).toContain('UNRESTRICTED_ACCESS');
    const expectedTables =
      action === 'intake'
        ? ['fqcMessages', 'fqcScreenings']
        : action === 'maintain'
          ? [...FQC_TABLES]
          : action === 'submit'
          ? ['fqcMessages', 'fqcScreenings']
          : action === 'ticket'
            ? ['fqcTickets']
            : action === 'configure'
              ? ['fqcRoutingRules']
              : [...FQC_TABLES, REVIEW_TABLE, 'fqcRoutingRules'];
    expect(Object.keys(decision.conditions?.database ?? {}).sort()).toEqual(
      expectedTables.sort(),
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
  // 这条用例验的是「只有这份投递授权」的主体；建人初始化器会给它补基线 staff，
  // 而 staff 的「提交反馈」带消息表的读，会干扰下面的裸读断言。把基线撤掉。
  await authz.permissionSets.revoke(`user:${proxy.id}:staff`);
  const context = authz.for({ principal: { type: 'user', id: proxy.id } });

  // 先证明这份授权真的生效，否则下面的「读被拒」可能只是因为它什么都没有。
  const intake = await context.authorize({
    resource: { type: 'composite', id: 'fqc' },
    action: 'intake',
  });
  expect(intake.effect, '只持投递的主体投不了').not.toBe('deny');
  const policies = databasePolicies(intake);
  for (const table of ['fqcMessages', 'fqcScreenings']) {
    expect(isAllowed(policies[table]?.create), `${table} 的投递没有建`).toBe(
      true,
    );
  }
  expect(
    isAllowed(policies.fqcTickets?.create),
    '投递不该还有工单表的建',
  ).toBe(false);

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
                fqcScreenings: 'allRecords',              },
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
      outcome: 'suggested',
      updatedAt: new Date('2026-11-20T10:01:00'),
    },
  });
  const updated = await connection
    .repository('fqcScreenings')
    .findOne({ filter: { id: screeningId } });
  expect(updated).toMatchObject({
    summary: '模型版摘要',
    outcome: 'suggested',
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
    'fqcRoutingRules',
    'departments',
    'departmentMembers',
    'departmentMemberHistory',
    // R-011：provider 现在还注册四张员工表。
    'employees',
    'employeeChanges',
    'positions',
    'jobGrades',
    // R-017 S1：三张审批表，没有 composite 资源与业务动作。
    ...APPROVAL_TABLES,
    // R-025 S1：班次定义一张表，独立 composite 资源。
    'shifts',
    // R-014：往来单位两张表（main 已并入，这里的钉子此前漏了）。
    'partners',
    'partnerContacts',
    // R-014 加片：交货地址表（只登记，不进角色编辑器目录）。
    'partnerAddresses',
    // R-019：物料三张表（main 已并入，这里的钉子此前漏了）。
    'units',
    'itemCategories',
    'items',
    // R-020：仓库与库存五张表。
    'warehouses',
    'stockDocs',
    'stockDocLines',
    'stockBalances',
    'stockTransactions',
    // R-021/R-022：采购与销售订单各两张表。
    'purchaseOrders',
    'purchaseOrderLines',
    'salesOrders',
    'salesOrderLines',
    // R-022 复刻波 1：报价单头与明细两张表。
    'quotations',
    'quotationLines',
    // R-021 加片：单据附件通用表。
    'docFiles',
    // R-065：支出与到票各两张表。
    'expenseRecords',
    'expenseRecordLines',
    'invoiceReceiptRecords',
    'invoiceReceiptRecordLines',
    // R-072：业务字典一张表，两个只读资源各不分表。
    'bizDictEntries',
    // R-064：订单评审头表与五项明细表。
    ...ORDER_REVIEW_COLLECTIONS.map((collection) => collection.name),
    // R-066：请款单与报销单一表分型（注册顺序在 R-020/R-021 之前）。
    'financeRequestDocs',
    // R-020 波 1：盘点单与调拨单各两张表。
    'stocktakingDocs', 'stocktakingDocLines', 'transferDocs', 'transferDocLines',
    // R-021 波 1 加片：请购单头表与明细表。
    'purchaseRequests',
    'purchaseRequestLines',
    // R-070：采购检验单头与明细。
    'inspectionOrders', 'inspectionLines',
  ]);
  expect(registered.composites.map((composite) => composite.name)).toContain(
    'fqc',
  );
  expect(registered.composites.map((composite) => composite.name)).toContain(
    'employees',
  );
  expect(registered.composites.map((composite) => composite.name)).toContain(
    'shifts',
  );
  for (const name of ['bizDict', 'bizOptions']) {
    expect(registered.composites.map((composite) => composite.name)).toContain(name);
  }
  expect(registered.composites.map((composite) => composite.name)).toContain('orderReviews');
  expect(registered.composites.map((composite) => composite.name)).toContain('purchaseRequests');
  expect(registered.recordAccess).toContain('purchaseRequest.creatorOwn');
  expect(registered.composites.map((composite) => composite.name)).toContain('financeRequests');
  expect(registered.recordAccess).toContain('financeRequest.creatorOwn');
  // R-076：三组打印资源各两个动作；表沿用 inventory，不重复登记集合。
  for (const name of ['docPrintInternalIssue', 'docPrintSalesIssue', 'docPrintPurchaseReceipt']) {
    expect(registered.composites.map((composite) => composite.name)).toContain(name);
    expect(
      registered.composites
        .find((composite) => composite.name === name)
        ?.actions.map((action) => action.name)
        .sort(),
    ).toEqual(['print', 'printPrice']);
  }

  await expect(provider.boot()).resolves.toBeUndefined();
  expect(registrationSnapshot(authz)).toEqual(registered);
});

test('R-065: financeView 只登记在采购订单资源上，销售订单的动作清单里没有', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const actionsOf = (id: string): readonly string[] =>
    authz.compositeResources.list()
      .find((resource) => resource.name === id)
      ?.actions.map((action) => action.name)
      .sort() ?? [];
  expect(actionsOf('purchaseOrders')).toEqual([
    'cancel', 'create', 'createReceipt', 'financeView', 'receive',
    'submit', 'update', 'view', 'viewPrice',
  ]);
  expect(actionsOf('salesOrders')).toEqual([
    'cancel', 'create', 'createIssue', 'ledgerView', 'ship', 'submit', 'update',
    'view', 'viewPrice',
  ]);
  expect(actionsOf('orderReviews')).toEqual([
    'confirm', 'create', 'submit', 'update', 'view', 'void',
  ]);
  expect(actionsOf('purchaseRequests')).toEqual([
    'convert', 'create', 'submit', 'update', 'view', 'void',
  ]);
  // R-022 复刻波 1：报价单新资源六个动作，不提供删除。
  expect(actionsOf('quotations')).toEqual([
    'confirm', 'convert', 'create', 'update', 'view', 'void',
  ]);
  expect(actionsOf('financeRequests')).toEqual([
    'convert', 'create', 'submit', 'update', 'view', 'void',
  ]);
  expect(actionsOf('purchaseOrders')).toContain('financeView');
  expect(actionsOf('salesOrders'), '销售订单不该有借采购授权的 financeView').not.toContain('financeView');
});

/** R-070 IQC：六个动作逐一登记，两张表不登记删除，不进角色编辑器目录。 */
test('R-070: registers inspectionOrders with six actions and no delete', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const actionsOf = (id: string): readonly string[] =>
    authz.compositeResources.list()
      .find((resource) => resource.name === id)
      ?.actions.map((action) => action.name)
      .sort() ?? [];
  expect(actionsOf('inspectionOrders')).toEqual([
    'complete', 'create', 'receiveView', 'update', 'view', 'void',
  ]);
  for (const table of ['inspectionOrders', 'inspectionLines']) {
    const definition = authz.database.collections.list().find((entry) => entry.name === table);
    expect(definition, `${table} 没有登记`).toBeDefined();
    expect(definition?.actions, `${table} 不该登记删除`).toEqual(['read', 'create', 'update']);
  }
  expect(authz.ui.placementOf({ type: 'composite', id: 'inspectionOrders' })).toBeUndefined();
});

test('R-065: 每个集合只登记一次，重复的清单不会写第二遍', async () => {
  const authz = createAppAuthorization({});
  const container = new ServiceContainer();
  container.instance(authorizationToken, authz);
  container.instance(departmentServiceToken, noDepartments());
  const provider = new AuthorizationResourcesProvider({
    container,
  } as unknown as AppPluginApplication);
  const add = vi.spyOn(authz.database.collections, 'add');
  try {
    await provider.boot();
    const names = add.mock.calls.map(([definition]) => definition.name);
    expect(
      names.filter((name, index) => names.indexOf(name) !== index),
      '同一个集合名被登记了多次',
    ).toEqual([]);
  } finally {
    add.mockRestore();
  }
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


test('R-020 波 1: registers stocktakings and transfers with no delete action', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const actionsOf = (id: string): readonly string[] =>
    authz.compositeResources.list()
      .find((resource) => resource.name === id)
      ?.actions.map((action) => action.name)
      .sort() ?? [];
  expect(actionsOf('stocktakings')).toEqual(['create', 'finish', 'update', 'view', 'void']);
  expect(actionsOf('transfers')).toEqual(['create', 'post', 'update', 'view', 'void']);
  for (const table of ['stocktakingDocs', 'stocktakingDocLines', 'transferDocs', 'transferDocLines']) {
    const definition = authz.database.collections.list().find((entry) => entry.name === table);
    expect(definition, `${table} 没有登记`).toBeDefined();
    expect(definition?.actions, `${table} 不该登记删除`).not.toContain('delete');
  }
  // 两个资源都不做页面目录：本片没有页面，等波 2 的页面片再放。
  for (const id of ['stocktakings', 'transfers']) {
    expect(authz.ui.placementOf({ type: 'composite', id })).toBeUndefined();
  }
});
