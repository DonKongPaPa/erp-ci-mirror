import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken, type AppAuthorization } from '@nocobase/app-plugin-authorization';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import type {
  AuthorizationDecision,
  CompositeResourceConditions,
} from '@nocobase/authorization/core';
import type { RepositoryPolicy } from '@nocobase/db';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-026 验收23、24：两个新动作与三处收窄的声明，以及按列、按范围在仓储层的真实行为。
 *
 * 验收23 是反向断言：建列与改列逐项等于设计里的清单，原文七列不在任何动作的改列里，
 * 「提交反馈」对初筛表的建只有十五列、改只有十五列且没有读，两个动作对工单表都没有建，
 * 两张表/三张表的范围选项分别是「仅本人」/「全部」，「查看」对两张表读的是十一列与
 * 十九列。验收24 用「提交反馈」决策里初筛表的范围做带谓词的更新：只改到本人那一行，
 * 同一份范围去读被拒。
 *
 * 这里是声明与仓储层：端点的接线、响应投影与 `mine` 端点在后面的切片里验。
 */
const PASSWORD = 'R026-test-123!';

const FQC = { type: 'composite', id: 'fqc' } as const;

/** 迁移 `202611220001` 建的消息表十一列：「查看」只读它们。 */
const VIEW_MESSAGE_READ_FIELDS = [
  'channel',
  'content',
  'createdAt',
  'externalId',
  'id',
  'rawContentType',
  'receivedAt',
  'senderContact',
  'senderName',
  'status',
  'updatedAt',
].sort();

/** 「提交反馈」读消息表的十九列：全部二十一列去掉 note 与 discardedBy。 */
const SUBMIT_MESSAGE_READ_FIELDS = [
  'attachmentIds',
  'batchNo',
  'channel',
  'content',
  'createdAt',
  'customerName',
  'discardReason',
  'discardedAt',
  'externalId',
  'id',
  'model',
  'ownerId',
  'productName',
  'rawContentType',
  'receivedAt',
  'senderContact',
  'senderName',
  'status',
  'updatedAt',
].sort();

/** 「提交反馈」建消息表的十七列：全部二十一列去掉 note 与丢弃的三列。 */
const SUBMIT_MESSAGE_CREATE_FIELDS = [
  'attachmentIds',
  'batchNo',
  'channel',
  'content',
  'createdAt',
  'customerName',
  'externalId',
  'id',
  'model',
  'ownerId',
  'productName',
  'rawContentType',
  'receivedAt',
  'senderContact',
  'senderName',
  'status',
  'updatedAt',
].sort();

/** 「投递」建消息表的十六列：「提交反馈」的十七列再去掉 ownerId。 */
const INTAKE_MESSAGE_CREATE_FIELDS = SUBMIT_MESSAGE_CREATE_FIELDS.filter(
  (field) => field !== 'ownerId',
);

/** 「维护反馈单」改消息表的十一列。 */
const MAINTAIN_MESSAGE_UPDATE_FIELDS = [
  'attachmentIds',
  'batchNo',
  'customerName',
  'discardReason',
  'discardedAt',
  'discardedBy',
  'model',
  'note',
  'productName',
  'status',
  'updatedAt',
].sort();

/** 原文七列：落库之后任何动作都不能改。 */
const ORIGINAL_FIELDS = [
  'channel',
  'content',
  'externalId',
  'rawContentType',
  'receivedAt',
  'senderContact',
  'senderName',
] as const;

/** 「提交反馈」建初筛表与改初筛表的十五列。 */
const SUBMIT_SCREENING_CREATE_FIELDS = [
  'category',
  'confidence',
  'createdAt',
  'degradeReason',
  'evidence',
  'id',
  'knowledgeRefs',
  'messageId',
  'modelName',
  'outcome',
  'ownerId',
  'severity',
  'suggestedOwner',
  'summary',
  'updatedAt',
].sort();

/** 与主线上的 `INTAKE_SCREENING_UPDATE_FIELDS` 逐项相同。 */
const SCREENING_UPDATE_FIELDS = [
  'category',
  'confidence',
  'degradeReason',
  'degraded',
  'engine',
  'evidence',
  'knowledgeRefs',
  'modelName',
  'outcome',
  'promptVersion',
  'redacted',
  'severity',
  'suggestedOwner',
  'summary',
  'updatedAt',
].sort();

/** 「查看」读初筛表的十九列：今天实际读到的十二列加第一个切片的七列，不含 ownerId。 */
const VIEW_SCREENING_READ_FIELDS = [
  'category',
  'confidence',
  'createdAt',
  'degradeReason',
  'degraded',
  'engine',
  'evidence',
  'id',
  'knowledgeRefs',
  'messageId',
  'modelName',
  'outcome',
  'promptVersion',
  'redacted',
  'reviewId',
  'severity',
  'suggestedOwner',
  'summary',
  'updatedAt',
].sort();

/** 「维护反馈单」读初筛表的八个字段与工单表的五个字段。 */
const MAINTAIN_SCREENING_READ_FIELDS = [
  'category',
  'confidence',
  'id',
  'messageId',
  'outcome',
  'severity',
  'suggestedOwner',
  'summary',
].sort();

const MAINTAIN_TICKET_READ_FIELDS = [
  'code',
  'id',
  'screeningId',
  'sourceMessageId',
  'state',
].sort();

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const codes = (decision: { readonly reasons: readonly { code: string }[] }) =>
  decision.reasons.map((reason) => reason.code);

type FqcDecision = AuthorizationDecision<CompositeResourceConditions>;

const databasePolicies = (
  decision: FqcDecision,
): Readonly<Record<string, RepositoryPolicy>> =>
  decision.conditions?.database ?? {};

const isAllowed = (value: unknown): boolean =>
  value !== undefined && value !== false;

/** 一个读写动作允许的列；没有这个动作、动作被拒或全列时返回 undefined。 */
const fieldsOf = (
  node:
    | RepositoryPolicy['read']
    | RepositoryPolicy['create']
    | RepositoryPolicy['update']
    | undefined,
): readonly string[] | undefined => {
  if (node === undefined || typeof node === 'boolean') {
    return undefined;
  }
  return node.fields === undefined || node.fields === false
    ? undefined
    : [...node.fields].sort();
};

const grant = (action: string, scopes: Readonly<Record<string, string>>) => ({
  resource: { type: 'composite', id: 'fqc' },
  actions: [{ action, policy: { type: 'composite', scopes } }],
});

/** 建一个权限集与持有它的用户，取回这个用户对指定动作的决策。 */
async function decisionFor(
  app: AppPluginApplication,
  admin: TestSession,
  key: string,
  action: string,
  scopes: Readonly<Record<string, string>>,
): Promise<FqcDecision> {
  const authz: AppAuthorization = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({ key, grants: [grant(action, scopes)] });
  // 用户名走 better-auth 的 username 插件，只收字母数字；权限集的键可以有连字符。
  const username = key.replace(/-/gu, '');
  const response = await admin.fetch(
    '/users',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
      },
      body: JSON.stringify({
        name: key,
        username,
        email: `${username}@example.test`,
        password: PASSWORD,
        roleScopes: { app: [key] },
      }),
    },
  );
  const status = response.status;
  if (status !== 201) {
    throw new Error(`建用户 ${key} 失败：${status} ${await response.text()}`);
  }
  const user = (await response.json()).data as { id: string };
  return authz
    .for({ principal: { type: 'user', id: user.id } })
    .authorize({ resource: FQC, action });
}

/** 建一行完整的消息，返回它的标识。原文七列都有值，便于读的断言。 */
const insertMessage = async (
  connection: any,
  ownerId: string | null,
): Promise<string> => {
  const id = randomUUID();
  const now = new Date('2026-11-20T10:00:00');
  await connection.repository('fqcMessages').createOne({
    values: {
      id,
      channel: 'web',
      externalId: null,
      senderName: '发件人',
      senderContact: '021-00000000',
      content: '尺寸超差',
      rawContentType: 'text',
      receivedAt: now,
      status: 'open',
      ownerId,
      customerName: '客户甲',
      productName: '产品甲',
      model: '型号甲',
      batchNo: '批次甲',
      attachmentIds: [],
      note: '内部备注',
      discardedAt: null,
      discardedBy: null,
      discardReason: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
};

/** 建一行完整的初筛，返回它的标识。 */
const insertScreening = async (
  connection: any,
  ownerId: string | null,
  reviewId: string | null = null,
): Promise<string> => {
  const id = randomUUID();
  const now = new Date('2026-11-20T10:00:00');
  await connection.repository('fqcScreenings').createOne({
    values: {
      id,
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
      reviewId,
      ownerId,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
};

test('R-026 23: 「提交反馈」的读写清单与两张表的范围逐项等于设计', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const decision = await decisionFor(app, admin, 'r026-submit', 'submit', {
    fqcMessages: 'recordsIOwn',
    fqcScreenings: 'recordsIOwn',
  });

  expect(decision.effect, '提交反馈应当是「有条件放行」').toBe('conditional');
  expect(codes(decision)).not.toContain('NO_MATCHING_GRANT');
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort(), '提交反馈不该对工单表有任何权利').toEqual(
    ['fqcMessages', 'fqcScreenings'],
  );

  // 消息表：读十九列、建十七列、没有改与删。
  expect(isAllowed(policies.fqcMessages?.read), '提交反馈没有读消息表').toBe(
    true,
  );
  expect(fieldsOf(policies.fqcMessages?.read), '提交反馈读消息表的列与设计不一致').toEqual(
    SUBMIT_MESSAGE_READ_FIELDS,
  );
  expect(fieldsOf(policies.fqcMessages?.create), '提交反馈建消息表的列与设计不一致').toEqual(
    SUBMIT_MESSAGE_CREATE_FIELDS,
  );
  expect(isAllowed(policies.fqcMessages?.update), '提交反馈不该能改消息表').toBe(
    false,
  );
  expect(isAllowed(policies.fqcMessages?.delete), '提交反馈不该能删消息表').toBe(
    false,
  );

  // 初筛表：建、改各十五列，不读。
  expect(fieldsOf(policies.fqcScreenings?.create), '提交反馈建初筛表的列与设计不一致').toEqual(
    SUBMIT_SCREENING_CREATE_FIELDS,
  );
  expect(fieldsOf(policies.fqcScreenings?.update), '提交反馈改初筛表的列与投递不一致').toEqual(
    SCREENING_UPDATE_FIELDS,
  );
  expect(isAllowed(policies.fqcScreenings?.read), '提交反馈不该读初筛表').toBe(
    false,
  );
  expect(isAllowed(policies.fqcScreenings?.delete), '提交反馈不该能删初筛表').toBe(
    false,
  );

  // 角色编辑器里两张表的范围只有「仅本人」，且默认就是它。
  const options = await admin.fetch('/authorization/permissionSets/options');
  expect(options.status).toBe(200);
  const sections = ((await options.json()).data as {
    sections: {
      subsections: {
        resources: {
          id: string;
          dataScopes?: Record<
            string,
            { key: string; recordAccess: string[]; defaultValue?: string }[]
          >;
        }[];
      }[];
    }[];
  }).sections;
  const fqc = sections
    .flatMap((section) => section.subsections)
    .flatMap((subsection) => subsection.resources)
    .find((resource) => resource.id === 'fqc');
  expect(fqc, '角色编辑器的目录里没有 fqc').toBeDefined();
  for (const table of ['fqcMessages', 'fqcScreenings']) {
    const scope = (fqc?.dataScopes?.submit ?? []).find(
      (entry) => entry.key === table,
    );
    expect(scope, `提交反馈没有声明 ${table} 的范围`).toBeDefined();
    expect(scope?.recordAccess, `${table} 的范围选项应当只有「仅本人」`).toEqual([
      'recordsIOwn',
    ]);
    expect(scope?.defaultValue, `${table} 的默认范围应当是「仅本人」`).toBe(
      'recordsIOwn',
    );
  }
});

test('R-026 23: 「维护反馈单」的全列读、十一列改与初筛/工单的按列读', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const decision = await decisionFor(app, admin, 'r026-maintain', 'maintain', {
    fqcMessages: 'allRecords',
    fqcScreenings: 'allRecords',
    fqcTickets: 'allRecords',
  });

  expect(decision.effect, '维护反馈单应当是「有条件放行」').toBe('conditional');
  const policies = databasePolicies(decision);
  expect(Object.keys(policies).sort()).toEqual([
    'fqcMessages',
    'fqcScreenings',
    'fqcTickets',
  ]);

  // 消息表全列读、只改十一列、不建不删。
  expect(isAllowed(policies.fqcMessages?.read), '维护反馈单读不了消息表').toBe(
    true,
  );
  expect(fieldsOf(policies.fqcMessages?.update), '维护反馈单改消息表的列与设计不一致').toEqual(
    MAINTAIN_MESSAGE_UPDATE_FIELDS,
  );
  expect(isAllowed(policies.fqcMessages?.create), '维护反馈单不该能建消息表').toBe(
    false,
  );
  expect(isAllowed(policies.fqcMessages?.delete), '维护反馈单不该能删消息表').toBe(
    false,
  );

  // 初筛八个字段、工单五个字段，两个都没有建。
  expect(fieldsOf(policies.fqcScreenings?.read), '维护反馈单读初筛表的列与设计不一致').toEqual(
    MAINTAIN_SCREENING_READ_FIELDS,
  );
  expect(fieldsOf(policies.fqcTickets?.read), '维护反馈单读工单表的列与设计不一致').toEqual(
    MAINTAIN_TICKET_READ_FIELDS,
  );
  for (const table of ['fqcScreenings', 'fqcTickets']) {
    expect(
      isAllowed(policies[table]?.create),
      `维护反馈单不该能建 ${table}：建单只发生在 R-003 的派单里`,
    ).toBe(false);
  }

  // 按列是真的按列：改原文被拒，不是悄悄丢掉。
  const messageId = await insertMessage(connection, null);
  const repo = connection
    .repository('fqcMessages')
    .withPolicy(policies.fqcMessages as RepositoryPolicy);
  await expect(
    repo.updateMany({
      filter: { id: messageId },
      values: { content: '想改原文' },
    }),
    '维护反馈单改得动原文',
  ).rejects.toMatchObject({ code: 'FIELD_WRITE_FORBIDDEN' });
  const unchanged = await connection
    .repository('fqcMessages')
    .findOne({ filter: { id: messageId } });
  expect(unchanged?.content, '被拒的写入改动了原文').toBe('尺寸超差');
});

test('R-026 23: 「查看」只读原来的十一列消息与十九列初筛，不含 ownerId', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const decision = await decisionFor(app, admin, 'r026-view', 'view', {
    fqcMessages: 'allRecords',
    fqcScreenings: 'allRecords',
    fqcTickets: 'allRecords',
  });
  const policies = databasePolicies(decision);

  expect(fieldsOf(policies.fqcMessages?.read), '查看对消息表不是原来的十一列').toEqual(
    VIEW_MESSAGE_READ_FIELDS,
  );
  expect(fieldsOf(policies.fqcScreenings?.read), '查看对初筛表不是原来的十九列').toEqual(
    VIEW_SCREENING_READ_FIELDS,
  );
  expect(
    fieldsOf(policies.fqcScreenings?.read),
    '查看对初筛表的读里出现了 ownerId',
  ).not.toContain('ownerId');

  // 仓储层：返回的行里恰好是清单里的列；点名清单外的列被拒。
  const messageId = await insertMessage(connection, randomUUID());
  const messages = connection
    .repository('fqcMessages')
    .withPolicy(policies.fqcMessages as RepositoryPolicy);
  const message = await messages.findOne({ filter: { id: messageId } });
  expect(Object.keys(message ?? {}).sort(), '查看读到的消息列不是十一列').toEqual(
    VIEW_MESSAGE_READ_FIELDS,
  );

  const screeningId = await insertScreening(connection, randomUUID());
  const screenings = connection
    .repository('fqcScreenings')
    .withPolicy(policies.fqcScreenings as RepositoryPolicy);
  const screening = await screenings.findOne({ filter: { id: screeningId } });
  expect(Object.keys(screening ?? {}).sort(), '查看读到的初筛列不是十九列').toEqual(
    VIEW_SCREENING_READ_FIELDS,
  );
  expect(screening, '查看读到了 ownerId').not.toHaveProperty('ownerId');
  await expect(
    screenings.findOne({
      filter: { id: screeningId },
      select: (select) => select.fields('id', 'ownerId'),
    }),
    '点名清单外的 ownerId 没有被拒',
  ).rejects.toMatchObject({ code: 'FIELD_READ_FORBIDDEN' });
});

test('R-026 23: 「投递」建消息表收成十六列，原文七列不在任何动作的改列里', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const intake = await decisionFor(app, admin, 'r026-intake', 'intake', {
    fqcMessages: 'allRecords',
    fqcScreenings: 'allRecords',
    fqcTickets: 'allRecords',
  });
  const intakePolicies = databasePolicies(intake);
  expect(fieldsOf(intakePolicies.fqcMessages?.create), '投递建消息表的列与设计不一致').toEqual(
    INTAKE_MESSAGE_CREATE_FIELDS,
  );
  expect(fieldsOf(intakePolicies.fqcScreenings?.update), '投递改初筛表的列变了').toEqual(
    SCREENING_UPDATE_FIELDS,
  );
  expect(isAllowed(intakePolicies.fqcMessages?.update), '投递不该能改消息表').toBe(
    false,
  );

  // 原文七列在投递与两个新动作的改列清单里都不出现。
  for (const field of ORIGINAL_FIELDS) {
    expect(
      fieldsOf(intakePolicies.fqcMessages?.update) ?? [],
      `投递的改列清单里有原文列 ${field}`,
    ).not.toContain(field);
  }
});

test('R-026 23: 原文七列对「维护反馈单」也写不进去（反向断言，含建列）', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const maintain = await decisionFor(app, admin, 'r026-maintain2', 'maintain', {
    fqcMessages: 'allRecords',
    fqcScreenings: 'allRecords',
    fqcTickets: 'allRecords',
  });
  const policies = databasePolicies(maintain);
  const repo = connection
    .repository('fqcMessages')
    .withPolicy(policies.fqcMessages as RepositoryPolicy);
  const messageId = await insertMessage(connection, null);

  for (const [field, value] of [
    ['channel', 'proxy'],
    ['externalId', 'replaced'],
    ['senderName', '换人'],
    ['senderContact', '000'],
    ['content', '换原文'],
    ['rawContentType', 'html'],
    ['receivedAt', new Date()],
  ] as const) {
    await expect(
      repo.updateMany({ filter: { id: messageId }, values: { [field]: value } }),
      `维护反馈单改得动原文列 ${field}`,
    ).rejects.toMatchObject({ code: 'FIELD_WRITE_FORBIDDEN' });
  }

  // 维护反馈单没有建：整笔写被拒（比按列更严）。丢弃的三列与 note 因此也造不出来。
  for (const field of ['note', 'discardedAt', 'discardedBy', 'discardReason']) {
    await expect(
      connection
        .repository('fqcMessages')
        .withPolicy(policies.fqcMessages as RepositoryPolicy)
        .createMany({
          values: [
            {
              id: randomUUID(),
              channel: 'web',
              content: '新单',
              rawContentType: 'text',
              receivedAt: new Date(),
              status: 'open',
              createdAt: new Date(),
              updatedAt: new Date(),
              [field]: field === 'note' ? '备注' : field === 'discardReason' ? 'other' : null,
            },
          ],
        }),
      `维护反馈单通过写 ${field} 造出了一行`,
    ).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN' });
  }
});

test('R-026 23: 「提交反馈」往初筛表写五列被拒，写列清单不是全列', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const submit = await decisionFor(app, admin, 'r026-submit-columns', 'submit', {
    fqcMessages: 'recordsIOwn',
    fqcScreenings: 'recordsIOwn',
  });
  const policy = databasePolicies(submit).fqcScreenings as RepositoryPolicy;
  const repo = connection.repository('fqcScreenings').withPolicy(policy);

  const base = {
    id: randomUUID(),
    messageId: randomUUID(),
    outcome: 'needs-review',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  for (const [field, value] of [
    ['reviewId', randomUUID()],
    ['promptVersion', 'v1'],
    ['engine', 'model'],
    ['degraded', true],
    ['redacted', true],
  ] as const) {
    await expect(
      repo.createMany({ values: [{ ...base, [field]: value }] }),
      `提交反馈写进了 ${field}`,
    ).rejects.toMatchObject({ code: 'FIELD_WRITE_FORBIDDEN' });
  }

  // 清单内的列能写，证明上面的拒绝不是「什么都写不进」。
  const id = randomUUID();
  await repo.createMany({
    values: [
      {
        ...base,
        id,
        category: 'dimension',
        evidence: ['尺寸'],
        degradeReason: 'model-disabled',
        knowledgeRefs: [],
        ownerId: randomUUID(),
        messageId: randomUUID(),
      },
    ],
  });
  expect(
    await connection
      .repository('fqcScreenings')
      .findOne({ filter: { id } }),
  ).not.toBeNull();

  // 消息表的建列也收窄了：note 与丢弃三列不在清单里，写它们被拒。
  const messagePolicy = databasePolicies(submit).fqcMessages as RepositoryPolicy;
  const messageBase = {
    id: randomUUID(),
    channel: 'web',
    content: '新单',
    rawContentType: 'text',
    receivedAt: new Date(),
    status: 'open',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  for (const [field, value] of [
    ['note', '内部备注'],
    ['discardedAt', null],
    ['discardedBy', null],
    ['discardReason', 'other'],
  ] as const) {
    await expect(
      connection
        .repository('fqcMessages')
        .withPolicy(messagePolicy)
        .createMany({ values: [{ ...messageBase, [field]: value }] }),
      `提交反馈建消息表写进了 ${field}`,
    ).rejects.toMatchObject({ code: 'FIELD_WRITE_FORBIDDEN' });
  }
});

test('R-026 24: 「提交反馈」的范围带上谓词只改到本人的初筛行', async ({
  app,
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz: AppAuthorization = app.container.resolve(authorizationToken);
  await authz.permissionSets.create({
    key: 'r026-submit-scope',
    grants: [
      grant('submit', {
        fqcMessages: 'recordsIOwn',
        fqcScreenings: 'recordsIOwn',
      }),
    ],
  });
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name: 'r026submitscope',
      username: 'r026submitscope',
      email: 'r026submitscope@example.test',
      password: PASSWORD,
      roleScopes: { app: ['r026-submit-scope'] },
    }),
  });
  expect(response.status).toBe(201);
  const user = (await response.json()).data as { id: string };
  const decision = await authz
    .for({ principal: { type: 'user', id: user.id } })
    .authorize({ resource: FQC, action: 'submit' });
  const policy = databasePolicies(decision).fqcScreenings as RepositoryPolicy;
  expect(policy, '提交反馈没有给出初筛表的范围').toBeDefined();

  const ownId = await insertScreening(connection, user.id);
  const otherId = await insertScreening(connection, randomUUID());
  const repo = connection.repository('fqcScreenings').withPolicy(policy);

  // 本人的行、还没有被确认：改得到，行数是一。
  const own = await repo.updateMany({
    filter: (filter) =>
      filter.and([
        filter.string('id').eq(ownId),
        filter.string('reviewId').empty(),
      ]),
    values: { summary: '本人的草稿，模型版替换', updatedAt: new Date() },
  });
  expect(own.updatedCount, '本人的初筛行没有改到').toBe(1);
  expect(
    await connection.repository('fqcScreenings').findOne({ filter: { id: ownId } }),
  ).toMatchObject({ summary: '本人的草稿，模型版替换' });

  // 别人的行：同一个范围、同一个谓词，改到零行，那一行不变。
  const other = await repo.updateMany({
    filter: (filter) =>
      filter.and([
        filter.string('id').eq(otherId),
        filter.string('reviewId').empty(),
      ]),
    values: { summary: '别人的草稿不该被改', updatedAt: new Date() },
  });
  expect(other.updatedCount, '改到了别人的初筛行').toBe(0);
  expect(
    await connection.repository('fqcScreenings').findOne({ filter: { id: otherId } }),
  ).toMatchObject({ summary: '规则版摘要' });

  // 已经确认过的那一行（reviewId 非空）：谓词不匹配，改到零行。
  await connection
    .repository('fqcScreenings')
    .updateMany({
      filter: { id: ownId },
      values: { reviewId: randomUUID() },
    });
  const confirmed = await repo.updateMany({
    filter: (filter) =>
      filter.and([
        filter.string('id').eq(ownId),
        filter.string('reviewId').empty(),
      ]),
    values: { summary: '确认抢先之后不该再替换', updatedAt: new Date() },
  });
  expect(confirmed.updatedCount, '已经确认过的初筛行被改到了').toBe(0);

  // 同一份范围拿去读初筛表：被拒。
  await expect(
    repo.findMany(),
    '提交反馈的范围读得了初筛表',
  ).rejects.toThrow();
});
