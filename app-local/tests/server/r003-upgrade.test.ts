import { randomUUID } from 'node:crypto';

import type { AppAuthorization } from '@nocobase/app-plugin-authorization';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '../helpers/test-app.js';
import { expect, vi } from 'vitest';

import { upgradeR003 } from '../../cli/authz/upgrade-r003.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-003 的升级步骤（第一步，只做加法）。
 *
 * 已初始化的环境里 seed 不会补新角色授权：两个质量角色缺「处理工单」（工单表全量），
 * 质量主管缺「维护派单规则」（派单规则表全量）。命令只补这两样，已有授权逐条原样留着，
 * 别的角色一个字节不碰；判据是能展开的有效授权，不是动作名；写完幂等、带版本号、冲突不写。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R003-upgrade-123!';
const QUALITY = ['quality_manager', 'quality_inspector'] as const;
const FQC = { type: 'composite', id: 'fqc' } as const;
const TICKET_SCOPES = { fqcTickets: 'allRecords' };
const CONFIGURE_SCOPES = { fqcRoutingRules: 'allRecords' };

interface JsonAction {
  action: string;
  policy?: { type: string; scopes?: Record<string, unknown> };
}
interface JsonGrant {
  resource: { type: string; id: string };
  actions: JsonAction[];
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];

/** 模拟合并之前的环境：两个新动作一条授权都没有。 */
const stripNewActions = async (authz: AppAuthorization, key: string) => {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  const grants = grantsOf(set).filter(
    (grant) =>
      !(
        grant.resource.type === 'composite' &&
        grant.resource.id === 'fqc' &&
        grant.actions.some((action) =>
          ['ticket', 'configure'].includes(action.action),
        )
      ),
  );
  await authz.permissionSets.update(key, {
    key,
    ...(set.title === undefined ? {} : { title: set.title }),
    grants,
  });
};

/** 旧环境里只有带条件的假授权：框架过滤掉它，不能算「已有」。 */
const setConditionalAction = async (
  authz: AppAuthorization,
  key: string,
  action: string,
) => {
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
        resource: { ...FQC },
        actions: [
          {
            action,
            policy: { type: 'custom', scopes: TICKET_SCOPES },
          },
        ],
      },
    ],
  });
};

const createUser = async (
  admin: Awaited<ReturnType<typeof signIn>>,
  name: string,
  role: string,
) => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [role] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

/** 有效权限：composite 动作带数据范围时是 conditional，`can()` 只对 permit 为真。 */
const actionEffect = async (
  authz: AppAuthorization,
  userId: string,
  action: string,
) =>
  (
    await authz
      .for({ principal: { type: 'user', id: userId } })
      .authorize({ resource: FQC, action })
  ).effect;

const scopeOf = (grants: readonly JsonGrant[], action: string) =>
  grants
    .flatMap((grant) => grant.actions)
    .find((entry) => entry.action === action)?.policy?.scopes;

test('R-003 升级（第一步）：只给两个质量角色补处理工单、给主管补维护派单规则，别的授权不动', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const key of QUALITY) {
    await stripNewActions(authz, key);
  }
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const manager = await createUser(admin, 'r003upgrademanager', 'quality_manager');
  const inspector = await createUser(
    admin,
    'r003upgradeinspector',
    'quality_inspector',
  );
  const deptUser = await createUser(admin, 'r003upgradedepartment', 'dept_manager');

  // 前置条件真的成立：升级前两个动作都拒绝，不是测试写了个空断言。
  expect(await actionEffect(authz, manager.id, 'ticket')).toBe('deny');
  expect(await actionEffect(authz, manager.id, 'configure')).toBe('deny');
  expect(await actionEffect(authz, inspector.id, 'ticket')).toBe('deny');

  const managerBefore = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  const inspectorBefore = grantsOf((await authz.permissionSets.get('quality_inspector'))!);
  const deptBefore = grantsOf((await authz.permissionSets.get('dept_manager'))!);

  const lines: string[] = [];
  const report = await upgradeR003(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.grants.changed.sort()).toEqual([...QUALITY].sort());
  expect(report.grants.unchanged).toEqual([]);
  expect(report.grants.missing).toEqual([]);

  // 行为断言：升级后有效权限真的放开了，工单/派单规则各自的范围正确。
  expect(await actionEffect(authz, manager.id, 'ticket')).toBe('conditional');
  expect(await actionEffect(authz, manager.id, 'configure')).toBe('conditional');
  expect(await actionEffect(authz, inspector.id, 'ticket')).toBe('conditional');
  expect(await actionEffect(authz, inspector.id, 'configure')).toBe('deny');
  expect(await actionEffect(authz, deptUser.id, 'ticket')).toBe('deny');
  expect(await actionEffect(authz, deptUser.id, 'configure')).toBe('deny');

  const managerAfter = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  const inspectorAfter = grantsOf((await authz.permissionSets.get('quality_inspector'))!);
  expect(managerAfter.slice(0, managerBefore.length)).toEqual(managerBefore);
  expect(inspectorAfter.slice(0, inspectorBefore.length)).toEqual(inspectorBefore);
  expect(scopeOf(managerAfter, 'ticket')).toEqual(TICKET_SCOPES);
  expect(scopeOf(managerAfter, 'configure')).toEqual(CONFIGURE_SCOPES);
  expect(scopeOf(inspectorAfter, 'ticket')).toEqual(TICKET_SCOPES);
  expect(scopeOf(inspectorAfter, 'configure')).toBeUndefined();
  expect(
    (await authz.permissionSets.get('dept_manager'))!.grants,
    '部门主管的授权一个字节都不能改',
  ).toEqual(deptBefore);

  for (const key of QUALITY) {
    expect(
      lines.filter(
        (line) => line.includes(`[r003] ${key} before:`),
      ),
      `${key} 缺少改前日志`,
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes(`[r003] ${key} after:`)),
      `${key} 缺少改后日志`,
    ).toHaveLength(1);
  }
});

test('R-003 升级：带条件的假授权不算已有，重跑幂等且不动版本号', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripNewActions(authz, 'quality_manager');
  await setConditionalAction(authz, 'quality_manager', 'ticket');

  const first = await upgradeR003(authz, { info: () => undefined });
  expect(first.grants.changed).toContain('quality_manager');
  const managerAfter = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  const ticketGrants = managerAfter.filter((grant) =>
    grant.actions.some((entry) => entry.action === 'ticket'),
  );
  expect(ticketGrants).toHaveLength(2); // 带条件那条原样留着，另补一条干净的
  expect(scopeOf(managerAfter, 'ticket')).toEqual(TICKET_SCOPES);

  const revisions = await Promise.all(
    QUALITY.map(async (key) => (await authz.permissionSets.get(key))?.revision),
  );
  const second = await upgradeR003(authz, { info: () => undefined });
  expect(second.grants.changed).toEqual([]);
  expect(second.grants.unchanged.sort()).toEqual([...QUALITY].sort());
  expect(
    await Promise.all(
      QUALITY.map(async (key) => (await authz.permissionSets.get(key))?.revision),
    ),
    '重跑不该改版本号',
  ).toEqual(revisions);
});

test('R-003 升级：读到之后角色被改过时冲突退出，一行都不写', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const key of QUALITY) {
    await stripNewActions(authz, key);
  }
  const before = await Promise.all(
    QUALITY.map(async (key) => grantsOf((await authz.permissionSets.get(key))!)),
  );
  const revisions = await Promise.all(
    QUALITY.map(async (key) => (await authz.permissionSets.get(key))?.revision),
  );
  let writtenRevision: unknown;
  const spy = vi
    .spyOn(authz.permissionSets, 'update')
    .mockImplementation(async (...args) => {
      writtenRevision = args[2];
      const { PermissionSetConflictError } = await import(
        '@nocobase/authorization/permission-sets'
      );
      throw new PermissionSetConflictError(String(args[0]));
    });
  try {
    await expect(upgradeR003(authz, { info: () => undefined })).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(writtenRevision, '写入必须带读到的版本号').toBe(revisions[0]);
  expect(
    await Promise.all(
      QUALITY.map(async (key) => grantsOf((await authz.permissionSets.get(key))!)),
    ),
    '冲突时什么都不能写',
  ).toEqual(before);
});

/** 造一个旧环境里的投递权限集：带已经被声明收掉的 fqcTickets 范围。 */
const createOldIntakeSet = async (authz: AppAuthorization, key: string) => {
  await authz.permissionSets.create({
    key,
    grants: [
      {
        resource: { ...FQC },
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
};

const scopesOfAction = (
  grants: readonly JsonGrant[],
  action: string,
): Record<string, unknown> | undefined =>
  grants
    .flatMap((grant) => grant.actions)
    .find((entry) => entry.action === action)?.policy?.scopes;

test('R-003 升级②：删掉投递权限集里已声明收掉的 fqcTickets 范围，投递从被拒恢复', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const key = 'r003-old-intake';
  await createOldIntakeSet(authz, key);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r003intakeuser', 'staff');
  await authz.permissionSets.assign({
    subject: { type: 'user', id: user.id },
    permissionSet: key,
  });
  const identity = { principal: { type: 'user', id: user.id } };
  // 声明已经不认这个键：改之前整条授权被跳过，投递被拒是预期的。
  expect(
    (await authz.for(identity).authorize({ resource: FQC, action: 'intake' }))
      .effect,
  ).toBe('deny');

  const before = grantsOf((await authz.permissionSets.get(key))!);
  const lines: string[] = [];
  const report = await upgradeR003(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.intakeScopes.changed, '只改带这个键的投递权限集').toEqual([key]);
  expect(
    (await authz.for(identity).authorize({ resource: FQC, action: 'intake' }))
      .effect,
    '去掉失效的范围后投递恢复',
  ).toBe('conditional');
  const after = grantsOf((await authz.permissionSets.get(key))!);
  expect(scopesOfAction(after, 'intake')).toEqual({
    fqcMessages: 'allRecords',
    fqcScreenings: 'allRecords',
  });
  expect(after.length, '授权条数不变，只删一个键').toBe(before.length);
  expect(
    lines.filter((line) => line.includes(`[r003-intake] ${key} before:`)),
  ).toHaveLength(1);
  expect(
    lines.filter((line) => line.includes(`[r003-intake] ${key} after:`)),
  ).toHaveLength(1);

  const revision = (await authz.permissionSets.get(key))?.revision;
  const second = await upgradeR003(authz, { info: () => undefined });
  expect(second.intakeScopes.changed).toEqual([]);
  expect((await authz.permissionSets.get(key))?.revision).toBe(revision);
});

/** 模拟合并前环境：部门主管的「查看」还是三张表全量。 */
const widenDeptView = async (authz: AppAuthorization) => {
  const set = await authz.permissionSets.get('dept_manager');
  if (!set) {
    throw new Error('dept_manager permission set is missing');
  }
  const grants = grantsOf(set).map((grant) => {
    if (grant.resource.type !== 'composite' || grant.resource.id !== 'fqc') {
      return grant;
    }
    return {
      ...grant,
      actions: grant.actions.map((action) =>
        action.action === 'view'
          ? {
              ...action,
              policy: {
                type: 'composite',
                scopes: {
                  fqcMessages: 'allRecords',
                  fqcScreenings: 'allRecords',
                  fqcTickets: 'allRecords',
                },
              },
            }
          : action,
      ),
    };
  });
  await authz.permissionSets.update('dept_manager', {
    key: 'dept_manager',
    ...(set.title === undefined ? {} : { title: set.title }),
    grants,
  });
};

test('R-003 升级③：部门主管的「查看」收成只看本部门工单，别的角色不动', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await widenDeptView(authz);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r003deptview', 'dept_manager');
  const identity = { principal: { type: 'user', id: user.id } };
  const readOf = async (table: string) => {
    const decision = await authz
      .for(identity)
      .authorize({ resource: FQC, action: 'view' });
    return (
      (decision.conditions?.database?.[table] as { read?: unknown })?.read !==
        false
    );
  };
  expect(await readOf('fqcMessages'), '升级前读得到消息').toBe(true);
  const managerBefore = grantsOf((await authz.permissionSets.get('quality_manager'))!);

  const lines: string[] = [];
  const report = await upgradeR003(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.deptManagerView.changed).toEqual(['dept_manager']);
  const after = grantsOf((await authz.permissionSets.get('dept_manager'))!);
  expect(scopesOfAction(after, 'view')).toEqual({
    fqcTickets: 'org.myDepartmentsAndBelow',
  });
  expect(await readOf('fqcMessages'), '升级后读不到消息正文').toBe(false);
  expect(await readOf('fqcScreenings'), '升级后读不到初筛').toBe(false);
  expect(await readOf('fqcTickets'), '升级后仍看得到工单').toBe(true);
  expect(
    grantsOf((await authz.permissionSets.get('quality_manager'))!),
    '别的角色一个字节不碰',
  ).toEqual(managerBefore);
  expect(
    lines.filter((line) => line.includes('[r003-view] dept_manager before:')),
  ).toHaveLength(1);
  expect(
    lines.filter((line) => line.includes('[r003-view] dept_manager after:')),
  ).toHaveLength(1);

  const revision = (await authz.permissionSets.get('dept_manager'))?.revision;
  const second = await upgradeR003(authz, { info: () => undefined });
  expect(second.deptManagerView.changed).toEqual([]);
  expect(second.deptManagerView.unchanged).toEqual(['dept_manager']);
  expect((await authz.permissionSets.get('dept_manager'))?.revision).toBe(
    revision,
  );
});

/** 旧环境里两个质量角色的 handle 都没有派单规则的范围。 */
const stripHandleRouting = async (authz: AppAuthorization) => {
  for (const key of QUALITY) {
    const set = await authz.permissionSets.get(key);
    if (!set) {
      throw new Error(`permission set ${key} is missing`);
    }
    const grants = grantsOf(set).map((grant) => ({
      ...grant,
      actions: grant.actions.map((action) => {
        if (
          action.action !== 'handle' ||
          action.policy?.type !== 'composite' ||
          action.policy.scopes === undefined
        ) {
          return action;
        }
        const { fqcRoutingRules: _removed, ...rest } = action.policy.scopes;
        return { ...action, policy: { ...action.policy, scopes: rest } };
      }),
    }));
    await authz.permissionSets.update(key, {
      key,
      ...(set.title === undefined ? {} : { title: set.title }),
      grants,
    });
  }
};

const handleScopes = (grants: readonly JsonGrant[]) =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === 'fqc')
    .flatMap((grant) => grant.actions)
    .filter((action) => action.action === 'handle')
    .map((action) => action.policy?.scopes?.fqcRoutingRules);

test('R-003 复查：已有环境的处理动作补上派单规则范围，别的键一个字节不碰', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await stripHandleRouting(authz);
  const before = Object.fromEntries(
    await Promise.all(
      QUALITY.map(async (key) => [
        key,
        grantsOf((await authz.permissionSets.get(key))!),
      ]),
    ),
  ) as Record<string, JsonGrant[]>;
  for (const key of QUALITY) {
    expect(handleScopes(before[key]!)).toEqual([undefined]);
  }

  const lines: string[] = [];
  const report = await upgradeR003(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.handleRouting.changed.sort()).toEqual([...QUALITY].sort());
  for (const key of QUALITY) {
    const after = grantsOf((await authz.permissionSets.get(key))!);
    expect(after.slice(0, before[key]!.length), `${key} 的原授权被改了`).toEqual(
      before[key]!,
    );
    expect(handleScopes(after), `${key} 的处理没补上派单规则`).toContain(
      'allRecords',
    );
    expect(
      lines.filter((line) => line.includes(`[r003-handle] ${key} before:`)),
    ).toHaveLength(1);
  }

  const revisions = await Promise.all(
    QUALITY.map(async (key) => (await authz.permissionSets.get(key))?.revision),
  );
  const second = await upgradeR003(authz, { info: () => undefined });
  expect(second.handleRouting.changed).toEqual([]);
  expect(
    await Promise.all(
      QUALITY.map(async (key) => (await authz.permissionSets.get(key))?.revision),
    ),
  ).toEqual(revisions);
});

/** 旧环境里部门主管还有第二条宽 view 授权（框架允许重复动作）。 */
const addSecondWideView = async (authz: AppAuthorization) => {
  const set = await authz.permissionSets.get('dept_manager');
  if (!set) {
    throw new Error('dept_manager permission set is missing');
  }
  await authz.permissionSets.update('dept_manager', {
    key: 'dept_manager',
    ...(set.title === undefined ? {} : { title: set.title }),
    grants: [
      ...grantsOf(set),
      {
        resource: { ...FQC },
        actions: [
          {
            action: 'view',
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
};

const allViewScopes = (grants: readonly JsonGrant[]) =>
  grants
    .filter((grant) => grant.resource.type === 'composite' && grant.resource.id === 'fqc')
    .flatMap((grant) => grant.actions)
    .filter((action) => action.action === 'view')
    .map((action) => action.policy?.type === 'composite' ? action.policy.scopes : undefined);

test('R-003 复查：部门主管有多条宽 view 授权时逐条收窄，重跑幂等', async ({
  app,
  testApp,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await widenDeptView(authz);
  await addSecondWideView(authz);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const user = await createUser(admin, 'r003dupdeptview', 'dept_manager');
  const identity = { principal: { type: 'user', id: user.id } };
  const readOf = async (table: string) => {
    const decision = await authz
      .for(identity)
      .authorize({ resource: FQC, action: 'view' });
    return (
      (decision.conditions?.database?.[table] as { read?: unknown })?.read !==
      false
    );
  };
  expect(await readOf('fqcMessages'), '升级前消息正文读得到').toBe(true);

  const report = await upgradeR003(authz, { info: () => undefined });
  expect(report.deptManagerView.changed).toEqual(['dept_manager']);
  expect(report.deptManagerView.invalid).toEqual([]);
  expect(allViewScopes(grantsOf((await authz.permissionSets.get('dept_manager'))!))).toEqual([
    { fqcTickets: 'org.myDepartmentsAndBelow' },
    { fqcTickets: 'org.myDepartmentsAndBelow' },
  ]);
  expect(await readOf('fqcMessages'), '升级后消息正文读不到').toBe(false);
  expect(await readOf('fqcScreenings'), '升级后初筛读不到').toBe(false);
  expect(await readOf('fqcTickets'), '升级后工单仍可读').toBe(true);

  const revision = (await authz.permissionSets.get('dept_manager'))?.revision;
  const second = await upgradeR003(authz, { info: () => undefined });
  expect(second.deptManagerView.changed).toEqual([]);
  expect((await authz.permissionSets.get('dept_manager'))?.revision).toBe(
    revision,
  );
});

test('R-003 复查：部门主管任一条 view 形状非法时整份标 invalid，一行都不写', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await widenDeptView(authz);
  await addSecondWideView(authz);
  const set = await authz.permissionSets.get('dept_manager');
  const grants = grantsOf(set!);
  // 只把第二条 view 变成没有范围的非法形状：第一条仍是宽授权。整份必须拒绝，
  // 不能只收窄第一条就报 changed；也不能在非法条目上直接改 policy 崩溃后写库。
  let seen = 0;
  for (const grant of grants) {
    for (const action of grant.actions) {
      if (action.action === 'view' && seen++ === 1) {
        delete action.policy;
      }
    }
  }
  expect(seen, '前置条件：确实有两条 view 动作').toBe(2);
  await authz.permissionSets.update('dept_manager', {
    key: 'dept_manager',
    ...(set!.title === undefined ? {} : { title: set!.title }),
    grants,
  });
  const before = grantsOf((await authz.permissionSets.get('dept_manager'))!);
  const revision = (await authz.permissionSets.get('dept_manager'))?.revision;

  const lines: string[] = [];
  const report = await upgradeR003(authz, {
    info: (message) => lines.push(message),
  });
  expect(report.deptManagerView.invalid).toEqual(['dept_manager']);
  expect(report.deptManagerView.changed).toEqual([]);
  expect(grantsOf((await authz.permissionSets.get('dept_manager'))!)).toEqual(
    before,
  );
  expect((await authz.permissionSets.get('dept_manager'))?.revision).toBe(
    revision,
  );
  expect(
    lines.some(
      (line) =>
        line.includes('[r003-view]') &&
        line.includes('declaration mismatch'),
    ),
    '日志要点名非法形状',
  ).toBe(true);
});

test('R-003 复查：validateGrant 的任何报错都阻断，不被正则过滤', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await createOldIntakeSet(authz, 'r003-invalid-intake');
  const before = grantsOf((await authz.permissionSets.get('r003-invalid-intake'))!);
  const validate = vi
    .spyOn(authz.compositeResources, 'validateGrant')
    .mockReturnValue('Unknown data scope: injected by test');
  try {
    const report = await upgradeR003(authz, { info: () => undefined });
    expect(report.intakeScopes.invalid).toContain('r003-invalid-intake');
    expect(report.intakeScopes.changed).not.toContain('r003-invalid-intake');
  } finally {
    validate.mockRestore();
  }
  expect(grantsOf((await authz.permissionSets.get('r003-invalid-intake'))!)).toEqual(
    before,
  );
});
