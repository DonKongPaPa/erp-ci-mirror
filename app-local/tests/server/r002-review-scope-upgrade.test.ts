import { randomUUID } from 'node:crypto';

import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '../helpers/test-app.js';
import { expect, vi } from 'vitest';

import {
  upgradeR002,
  upgradeR002ReviewScope,
} from '../../cli/authz/upgrade-r002.js';
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

/** 某个资源上的动作名，没有这条授权时是空数组。 */
const grantActions = (
  grants: readonly JsonGrant[],
  type: string,
  id: string,
): string[] =>
  grants.find(
    (grant) => grant.resource.type === type && grant.resource.id === id,
  )?.actions.map((action) => action.action) ?? [];

/** 模拟合并之前的环境：两个质量角色没有知识库页面与 kb.knowledge 档位。 */
const stripKnowledgeAccess = async (
  authz: AppAuthorization,
  key: string,
): Promise<void> => {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  const grants = grantsOf(set).filter(
    (grant) =>
      !(
        (grant.resource.type === 'page' && grant.resource.id === 'knowledge') ||
        (grant.resource.type === 'kb' && grant.resource.id === 'kb.knowledge')
      ),
  );
  await authz.permissionSets.update(key, {
    key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants,
  });
};

/** 旧环境里只有带 policy 的知识库页面授权：框架会过滤它，不能算「已有」。 */
const setConditionalKnowledgePage = async (
  authz: AppAuthorization,
  key: string,
): Promise<void> => {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  await authz.permissionSets.update(key, {
    key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants: [
      ...grantsOf(set),
      {
        resource: { type: 'page', id: 'knowledge' },
        actions: [{ action: 'access', policy: { type: 'custom' } }],
      },
    ],
  });
};

/** 真正能打开页面的授权数：带 policy 的那条不算（grantBacked 过滤）。 */
const unconditionalPageAccessCount = (grants: readonly JsonGrant[]): number =>
  grants
    .filter(
      (grant) => grant.resource.type === 'page' && grant.resource.id === 'knowledge',
    )
    .flatMap((grant) => grant.actions)
    .filter(
      (action) => action.action === 'access' && action.policy === undefined,
    ).length;

/** 旧环境里只有带 policy 的 kb 档位：框架会过滤它，不能算「已有」。 */
const setConditionalKbGrant = async (
  authz: AppAuthorization,
  key: string,
  action: string,
): Promise<void> => {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  await authz.permissionSets.update(key, {
    key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants: [
      ...grantsOf(set),
      {
        resource: { type: 'kb', id: 'kb.knowledge' },
        actions: [{ action, policy: { type: 'custom' } }],
      },
    ],
  });
};

/** 真正生效的档位数：带 policy 的那条会被 `grantBacked` 过滤，不算。 */
const unconditionalKbActionCount = (
  grants: readonly JsonGrant[],
  action: string,
): number =>
  grants
    .filter(
      (grant) => grant.resource.type === 'kb' && grant.resource.id === 'kb.knowledge',
    )
    .flatMap((grant) => grant.actions)
    .filter(
      (entry) => entry.action === action && entry.policy === undefined,
    ).length;

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

test('R-002 升级：给两个质量角色补知识库页面与档位，别的角色不动，重跑不写', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripKnowledgeAccess(authz, 'quality_manager');
  await stripKnowledgeAccess(authz, 'quality_inspector');

  const beforeManager = grantsOf(
    (await authz.permissionSets.get('quality_manager'))!,
  );
  const beforeInspector = grantsOf(
    (await authz.permissionSets.get('quality_inspector'))!,
  );
  const deptBefore = grantsOf((await authz.permissionSets.get('dept_manager'))!);

  // 前置条件真的成立：升级前两个角色都没有知识库页面与 kb.knowledge 档位。
  for (const before of [beforeManager, beforeInspector]) {
    expect(grantActions(before, 'page', 'knowledge')).toEqual([]);
    expect(grantActions(before, 'kb', 'kb.knowledge')).toEqual([]);
  }

  const lines: string[] = [];
  const report = await upgradeR002(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.knowledgeAccess.changed.sort()).toEqual([...TARGETS].sort());
  expect(report.knowledgeAccess.unchanged).toEqual([]);
  expect(report.knowledgeAccess.missing).toEqual([]);

  const expectedActions: Record<string, string> = {
    quality_manager: 'manage.related',
    quality_inspector: 'propose.related',
  };
  for (const key of TARGETS) {
    const after = grantsOf((await authz.permissionSets.get(key))!);
    const before = key === 'quality_manager' ? beforeManager : beforeInspector;
    // 只加页面与档位两样：原有的授权逐条原样保留、条数只多两条。
    expect(after).toHaveLength(before.length + 2);
    for (const [index, grant] of before.entries()) {
      expect(after[index], `${key} 已有的授权被改了`).toEqual(grant);
    }
    // 行为断言：档位与 seed 给新环境的一致，质量主管管、质量员提案。
    expect(grantActions(after, 'page', 'knowledge')).toEqual(['access']);
    expect(grantActions(after, 'kb', 'kb.knowledge')).toEqual([
      expectedActions[key]!,
    ]);
    // 改前改后各一行日志。
    expect(
      lines.filter(
        (line) =>
          line.includes('[r002-knowledge]') &&
          line.includes(key) &&
          /before/u.test(line),
      ),
      `${key} 缺知识库升级的改前日志`,
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line.includes('[r002-knowledge]') &&
          line.includes(key) &&
          /after/u.test(line),
      ),
      `${key} 缺知识库升级的改后日志`,
    ).toHaveLength(1);
  }

  // 部门主管前后都不动，也没有被补上知识库页面或档位。
  expect(grantsOf((await authz.permissionSets.get('dept_manager'))!)).toEqual(
    deptBefore,
  );
  expect(grantActions(deptBefore, 'page', 'knowledge')).toEqual([]);
  expect(grantActions(deptBefore, 'kb', 'kb.knowledge')).toEqual([]);

  // 幂等：第二次不改、不写、不动版本号。
  const revisions = [
    (await authz.permissionSets.get('quality_manager'))?.revision,
    (await authz.permissionSets.get('quality_inspector'))?.revision,
  ];
  const second = await upgradeR002(authz, { info: () => undefined });
  expect(second.knowledgeAccess.changed).toEqual([]);
  expect(second.knowledgeAccess.unchanged.sort()).toEqual([...TARGETS].sort());
  expect(
    [
      (await authz.permissionSets.get('quality_manager'))?.revision,
      (await authz.permissionSets.get('quality_inspector'))?.revision,
    ],
    '第二次运行不该改动权限集的版本号',
  ).toEqual(revisions);
});

test('R-002 升级：旧环境只有带 policy 的知识库页面授权时补无条件 access，角色能打开页面', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripKnowledgeAccess(authz, 'quality_manager');
  await setConditionalKnowledgePage(authz, 'quality_manager');

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r002conditionalpage', {
    app: ['quality_manager'],
  });
  // 每次新建上下文：authz.for() 会按当时的 grants 组装提供者，升级前后的判定要用新快照。
  const identity = { principal: { type: 'user', id: user.id } };
  const canOpen = () =>
    authz
      .for(identity)
      .can({ resource: { type: 'page', id: 'knowledge' }, action: 'access' });

  // 前置条件：带 policy 的那条被框架过滤，角色现在确实打不开页面。
  expect(await canOpen()).toBe(false);
  expect(
    unconditionalPageAccessCount(
      grantsOf((await authz.permissionSets.get('quality_manager'))!),
    ),
  ).toBe(0);

  const lines: string[] = [];
  const report = await upgradeR002(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.knowledgeAccess.changed).toContain('quality_manager');
  // 行为断言：升级后角色真的能打开页面，不是只看 grants 里有没有动作名。
  expect(await canOpen()).toBe(true);
  const after = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  expect(unconditionalPageAccessCount(after)).toBe(1);
  expect(
    after.some(
      (grant) =>
        grant.resource.type === 'page' &&
        grant.resource.id === 'knowledge' &&
        grant.actions.some((action) => action.policy?.type === 'custom'),
    ),
    '原有的带条件授权不该被删掉',
  ).toBe(true);
  expect(
    lines.some((line) => line.includes('[r002-knowledge] quality_manager after:')),
    '改后日志要能看到补上的无条件页面授权',
  ).toBe(true);

  // 幂等：第二次不重复加，版本号不动。
  const revision = (await authz.permissionSets.get('quality_manager'))?.revision;
  const second = await upgradeR002(authz, { info: () => undefined });
  expect(second.knowledgeAccess.changed).not.toContain('quality_manager');
  expect(
    unconditionalPageAccessCount(
      grantsOf((await authz.permissionSets.get('quality_manager'))!),
    ),
  ).toBe(1);
  expect((await authz.permissionSets.get('quality_manager'))?.revision).toBe(
    revision,
  );
});

test('R-002 升级：已有不带 policy 的知识库页面授权时不重复加', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  const before = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  // 前置条件：seed 给的页面授权本来就是无条件的，这条必须算「已有」。
  expect(unconditionalPageAccessCount(before)).toBe(1);
  const revision = (await authz.permissionSets.get('quality_manager'))?.revision;

  const report = await upgradeR002(authz, { info: () => undefined });
  expect(report.knowledgeAccess.changed).toEqual([]);
  expect(grantActions(before, 'page', 'knowledge')).toEqual(['access']);
  expect(
    unconditionalPageAccessCount(
      grantsOf((await authz.permissionSets.get('quality_manager'))!),
    ),
  ).toBe(1);
  expect((await authz.permissionSets.get('quality_manager'))?.revision).toBe(
    revision,
  );
});

test('R-002 升级：读到版本后别人改了角色，报错退出且不写', async ({ app }) => {
  const authz = app.container.resolve(authorizationToken);
  await stripKnowledgeAccess(authz, 'quality_manager');

  const setsApi = authz.permissionSets;
  const realUpdate = setsApi.update.bind(setsApi);
  let raced = false;
  const spy = vi.spyOn(setsApi, 'update').mockImplementation(
    async (key, input, expectedRevision) => {
      if (!raced && key === 'quality_manager') {
        raced = true;
        const current = await setsApi.get(key);
        if (!current) {
          throw new Error(`permission set ${key} is missing`);
        }
        // 模拟管理员在角色编辑器里同时保存：版本号先前进了一步。
        await realUpdate(key, {
          key,
          title: { key: 'concurrent.edit', ns: 'app-local' },
          grants: current.grants,
        });
      }
      return realUpdate(key, input, expectedRevision);
    },
  );

  try {
    const lines: string[] = [];
    await expect(
      upgradeR002(authz, { info: (message) => lines.push(message) }),
    ).rejects.toMatchObject({ name: 'PermissionSetConflictError' });
    expect(
      lines.some(
        (line) =>
          line.includes('[r002-knowledge] quality_manager') &&
          line.includes('revision') &&
          line.includes('nothing written'),
      ),
      '冲突时要说明是版本变了、这一步没写',
    ).toBe(true);

    // 命令没覆盖别人的改动：标题保持管理员写的，知识库授权没被补上。
    const after = await authz.permissionSets.get('quality_manager');
    expect(after?.title).toEqual({ key: 'concurrent.edit', ns: 'app-local' });
    expect(grantActions(grantsOf(after!), 'page', 'knowledge')).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test('R-002 升级：质量主管只有带 policy 的 manage.related 时补无条件的，can() 由假变真', async ({
  app,
  testApp,
}) => {
  const role = 'quality_manager';
  const action = 'manage.related';
  const authz = app.container.resolve(authorizationToken);
  await stripKnowledgeAccess(authz, role);
  await setConditionalKbGrant(authz, role, action);

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r002condmanage', { app: [role] });
  const canManage = () =>
    authz
      .for({ principal: { type: 'user', id: user.id } })
      .can({ resource: { type: 'kb', id: 'kb.knowledge' }, action });

  // 前置条件：带 policy 的档位被框架过滤，角色现在确实没有有效档位。
  expect(await canManage()).toBe(false);
  expect(
    unconditionalKbActionCount(
      grantsOf((await authz.permissionSets.get(role))!),
      action,
    ),
  ).toBe(0);

  const report = await upgradeR002(authz, { info: () => undefined });
  expect(report.knowledgeAccess.changed).toContain(role);
  // 行为断言：升级后 can() 真的放开，不是只看 grants 里有动作名。
  expect(await canManage()).toBe(true);
  const after = grantsOf((await authz.permissionSets.get(role))!);
  expect(unconditionalKbActionCount(after, action)).toBe(1);
  expect(
    after.some(
      (grant) =>
        grant.resource.type === 'kb' &&
        grant.resource.id === 'kb.knowledge' &&
        grant.actions.some(
          (entry) => entry.action === action && entry.policy?.type === 'custom',
        ),
    ),
    '原有的带条件档位不该被删掉',
  ).toBe(true);

  // 幂等：第二次不重复加，版本不动。
  const revision = (await authz.permissionSets.get(role))?.revision;
  const second = await upgradeR002(authz, { info: () => undefined });
  expect(second.knowledgeAccess.changed).not.toContain(role);
  expect(
    unconditionalKbActionCount(
      grantsOf((await authz.permissionSets.get(role))!),
      action,
    ),
  ).toBe(1);
  expect((await authz.permissionSets.get(role))?.revision).toBe(revision);
});

test('R-002 升级：质量员只有带 policy 的 propose.related 时补无条件的，can() 由假变真', async ({
  app,
  testApp,
}) => {
  const role = 'quality_inspector';
  const action = 'propose.related';
  const authz = app.container.resolve(authorizationToken);
  await stripKnowledgeAccess(authz, role);
  await setConditionalKbGrant(authz, role, action);

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r002condinspect', { app: [role] });
  const canPropose = () =>
    authz
      .for({ principal: { type: 'user', id: user.id } })
      .can({ resource: { type: 'kb', id: 'kb.knowledge' }, action });

  // 前置条件：带 policy 的档位被框架过滤，角色现在确实没有有效档位。
  expect(await canPropose()).toBe(false);
  expect(
    unconditionalKbActionCount(
      grantsOf((await authz.permissionSets.get(role))!),
      action,
    ),
  ).toBe(0);

  const report = await upgradeR002(authz, { info: () => undefined });
  expect(report.knowledgeAccess.changed).toContain(role);
  // 行为断言：升级后 can() 真的放开，不是只看 grants 里有动作名。
  expect(await canPropose()).toBe(true);
  expect(
    unconditionalKbActionCount(
      grantsOf((await authz.permissionSets.get(role))!),
      action,
    ),
  ).toBe(1);

  // 幂等：第二次不重复加。
  const revision = (await authz.permissionSets.get(role))?.revision;
  const second = await upgradeR002(authz, { info: () => undefined });
  expect(second.knowledgeAccess.changed).not.toContain(role);
  expect(
    unconditionalKbActionCount(
      grantsOf((await authz.permissionSets.get(role))!),
      action,
    ),
  ).toBe(1);
  expect((await authz.permissionSets.get(role))?.revision).toBe(revision);
});
