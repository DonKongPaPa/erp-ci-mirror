import { randomUUID } from 'node:crypto';

import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import { upgradeR002ReviewScope } from '../../cli/authz/upgrade-r002.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-002 的升级步骤：确认记录表的范围「没配就是拒绝」，已初始化的环境由一条显式命令
 * 补上。
 *
 * 只在两个质量角色的 `fqc` 授权上补 `fqcScreeningReviews: 'allRecords'`：别的角色、
 * 别的键、别的值一律不动。命令幂等：第二次跑不写库、不动版本号；改前改后各记一行。
 * 升级之前确认端点是拒绝的（预期，不是缺陷）；跑过之后同一个账号能确认。
 */
const test = createAppTest({
  // 每个用例一台干净的应用：用例会剥掉 seed 角色的范围再跑升级，必须从同一个起点开始。
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R002-upgrade-123!';
const REVIEW_TABLE = 'fqcScreeningReviews';
const TARGETS = ['quality_manager', 'quality_inspector'];

interface JsonGrant {
  resource: { type: string; id: string };
  actions: {
    action: string;
    policy?: { type: string; scopes?: Record<string, unknown> };
  }[];
}

const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];

/** 模拟合并之前的环境：两个质量角色的 `fqc` 授权里没有确认记录表的范围键。 */
const stripReviewScope = async (
  authz: AppAuthorization,
  key: string,
): Promise<void> => {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  const grants = grantsOf(set);
  for (const grant of grants) {
    if (grant.resource.type !== 'composite' || grant.resource.id !== 'fqc') {
      continue;
    }
    for (const action of grant.actions) {
      if (action.policy?.type === 'composite' && action.policy.scopes) {
        delete action.policy.scopes[REVIEW_TABLE];
      }
    }
  }
  await authz.permissionSets.update(key, {
    key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants,
  });
};

/** `fqc` 的某个动作上，确认记录表的范围值。 */
const reviewScopeOf = async (
  authz: AppAuthorization,
  key: string,
  actionName: string,
): Promise<unknown> => {
  const set = await authz.permissionSets.get(key);
  const grant = grantsOf(set as { grants: unknown }).find(
    (entry) =>
      entry.resource.type === 'composite' && entry.resource.id === 'fqc',
  );
  const action = grant?.actions.find((entry) => entry.action === actionName);
  return action?.policy?.scopes?.[REVIEW_TABLE];
};

const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

test('R-002 升级：只给两个质量角色补上确认记录表的全量范围，别的角色与键不动', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripReviewScope(authz, 'quality_manager');
  await stripReviewScope(authz, 'quality_inspector');

  const managerBefore = await authz.permissionSets.get('quality_manager');
  const inspectorBefore = await authz.permissionSets.get('quality_inspector');
  const deptBefore = await authz.permissionSets.get('dept_manager');
  const staffBefore = await authz.permissionSets.get('staff');

  const lines: string[] = [];
  const logger = { info: (message: string) => lines.push(message) };
  const report = await upgradeR002ReviewScope(authz, logger);

  expect(report.changed.sort()).toEqual([...TARGETS].sort());
  expect(report.unchanged, '第一次运行不该有「不用改」的角色').toEqual([]);
  expect(report.missing).toEqual([]);

  for (const key of TARGETS) {
    for (const action of ['view', 'handle']) {
      expect(
        await reviewScopeOf(authz, key, action),
        `${key} 的 ${action} 应当补上 ${REVIEW_TABLE}: allRecords`,
      ).toBe('allRecords');
    }
    // 别的范围键与别的授权原样保留。
    const before = grantsOf(
      key === 'quality_manager' ? managerBefore! : inspectorBefore!,
    );
    const after = grantsOf((await authz.permissionSets.get(key))!);
    for (const [index, grant] of after.entries()) {
      if (grant.resource.type !== 'composite' || grant.resource.id !== 'fqc') {
        expect(grant, `${key} 的非 fqc 授权被改了`).toEqual(before[index]);
        continue;
      }
      for (const [actionIndex, action] of grant.actions.entries()) {
        const previous = before[index]?.actions[actionIndex];
        for (const [scope, value] of Object.entries(
          action.policy?.scopes ?? {},
        )) {
          if (scope === REVIEW_TABLE) {
            continue;
          }
          expect(value, `${key} 的 ${action.action}.${scope} 被改了`).toEqual(
            previous?.policy?.scopes?.[scope],
          );
        }
        // 原来的范围键一个都没少。
        expect(Object.keys(action.policy?.scopes ?? {})).toEqual(
          expect.arrayContaining(Object.keys(previous?.policy?.scopes ?? {})),
        );
      }
    }
  }

  // 别的角色整份授权不动。
  expect(grantsOf((await authz.permissionSets.get('dept_manager'))!)).toEqual(
    grantsOf(deptBefore!),
  );
  expect(grantsOf((await authz.permissionSets.get('staff'))!)).toEqual(
    grantsOf(staffBefore!),
  );
  expect(
    await reviewScopeOf(authz, 'dept_manager', 'view'),
    '部门主管不该被这条命令补上确认记录的范围',
  ).toBeUndefined();

  // 改前改后各一行日志。
  for (const key of TARGETS) {
    expect(
      lines.filter((line) => line.includes(key) && /before/u.test(line)),
      `${key} 缺改前那一行日志`,
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes(key) && /after/u.test(line)),
      `${key} 缺改后那一行日志`,
    ).toHaveLength(1);
  }

  // 幂等：第二次不改、不写、不动版本号。
  const revisions = [
    (await authz.permissionSets.get('quality_manager'))?.revision,
    (await authz.permissionSets.get('quality_inspector'))?.revision,
  ];
  const secondLines: string[] = [];
  const second = await upgradeR002ReviewScope(authz, {
    info: (message: string) => secondLines.push(message),
  });
  expect(second.changed).toEqual([]);
  expect(second.unchanged.sort()).toEqual([...TARGETS].sort());
  expect(
    [
      (await authz.permissionSets.get('quality_manager'))?.revision,
      (await authz.permissionSets.get('quality_inspector'))?.revision,
    ],
    '第二次运行不该改动权限集的版本号',
  ).toEqual(revisions);
});

test('R-002 升级：升级之前确认是拒绝的，跑过命令之后同一个账号能确认', async ({
  testApp,
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await createUser(admin, 'r002upgrademanager', { app: ['quality_manager'] });
  const session = await signIn(testApp, {
    username: 'r002upgrademanager',
    password: PASSWORD,
  });
  const now = new Date('2026-11-20T10:00:00');
  const screeningId = randomUUID();
  await connection.repository('fqcScreenings').createOne({
    values: {
      id: screeningId,
      messageId: randomUUID(),
      category: 'dimension',
      severity: 'major',
      suggestedOwner: 'quality-dimension',
      summary: '升级前的草稿',
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
  await stripReviewScope(authz, 'quality_manager');

  // 升级之前：确认记录表的读被折成拒绝，确认端点 403（预期）。
  const before = await session.fetch(
    `/quality/screenings/${screeningId}/review`,
    json({}),
  );
  const beforeText = await before.text();
  expect(before.status, `${beforeText}`).toBe(403);
  // 升级前确认记录表没有读范围：端点走不到写完，在读回确认记录时被仓库层拒，
  // 返回 403 READ_FORBIDDEN（业务动作 fqc.handle 本身还在，所以不是 AUTHORIZATION_DENIED）。
  expect(
    (JSON.parse(beforeText) as { error: { reason: string } }).error.reason,
  ).toBe('READ_FORBIDDEN');
  expect(
    await connection.repository('fqcScreeningReviews').count(),
    '被拒的确认不该写行',
  ).toBe(0);

  await upgradeR002ReviewScope(authz, { info: () => undefined });

  const after = await session.fetch(
    `/quality/screenings/${screeningId}/review`,
    json({ departmentId: 'department-r002' }),
  );
  const afterText = await after.text();
  expect(after.status, `${afterText}`).toBe(200);
  const body = JSON.parse(afterText) as {
    data: { outcome: string; reviewId: string };
  };
  expect(body.data.outcome).toBe('reviewed');
  expect(await connection.repository('fqcScreeningReviews').count()).toBe(1);
  const review = await connection
    .repository('fqcScreeningReviews')
    .findOne({ filter: { id: body.data.reviewId } });
  expect(review, '响应里的 reviewId 应当指向库里那一行').toBeDefined();
  expect(review?.screeningId).toBe(screeningId);
});
