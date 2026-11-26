// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isServiceAccount,
  userAdministrationServiceToken,
  type UserAdministrationService,
} from '@nocobase/app-plugin-authentication';
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

import {
  FEEDBACK_PAGE_ID,
  assertStaffAssignmentsSucceeded,
  upgradeR026,
  type R026UpgradeServices,
} from '../../cli/authz/upgrade-r026.js';
import { assignStaffBaseline } from '../../server/providers/staff-baseline.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-026 的升级命令：已经初始化的环境里 seed 不会补授权，靠这条命令把反馈单页、
 * 「提交反馈」「维护反馈单」补给三个角色，并给存量的人补 `staff`。
 *
 * 每个用例从同一份 seed 出发：先直接用 SQL 改写权限集表造「升级之前」的环境
 * （seed 对新环境才生效），再跑命令。断言的是有效权限（`can()`）与库里的形状，
 * 不只是授权文本。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const read = (...segments: string[]): string =>
  readFileSync(path.join(appRoot, ...segments), 'utf8');
/** 与 tests/project/quality-page-id.test.ts 同一写法：取源码里的页面授权 id。 */
const pageGrantIds = (source: string): string[] =>
  [...source.matchAll(/type:\s*'page',\s*id:\s*'([^']+)'/gu)].map(
    (match) => match[1] as string,
  );

const TARGETS = ['staff', 'quality_manager', 'quality_inspector'] as const;
const OTHER_ROLES = ['dept_manager', 'member', 'root'] as const;
const CUSTOM_ROLE = 'r026_upgrade_custom_viewer';
const NEW_ACTIONS = ['submit', 'maintain'];
const PASSWORD = 'R026-upgrade-123!';

interface JsonAction {
  action: string;
  policy?: { type: string; scopes?: Record<string, unknown> };
}
interface JsonGrant {
  resource: { type: string; id: string };
  actions: JsonAction[];
}
interface SetSnapshot {
  grants: JsonGrant[];
  revision: string;
  title: CreateTitle | undefined;
}
type CreateTitle = { key: string; ns: string };

type OldShape = 'strip' | 'conditional';

const grantsOf = (set: { grants: unknown }): JsonGrant[] =>
  JSON.parse(JSON.stringify(set.grants)) as JsonGrant[];

const isFeedbackPage = (grant: JsonGrant): boolean =>
  grant.resource.type === 'page' && grant.resource.id === FEEDBACK_PAGE_ID;
const isFqc = (grant: JsonGrant): boolean =>
  grant.resource.type === 'composite' && grant.resource.id === 'fqc';
const newGrantActions = (grant: JsonGrant): string[] =>
  grant.actions.map((entry) => entry.action).filter((action) => NEW_ACTIONS.includes(action));

/**
 * 造升级之前的环境：直接用 SQL 改写 grants 列（seed 与服务层都不会这样写，
 * 但存量库就是 seed 那个时刻的形状），revision 故意不动 —— 模拟旧环境。
 * `strip` 把三样新授权整条删掉；`conditional` 留下带 policy 的同名授权，
 * 框架会过滤它们，判据若只看动作名就会误判为「已有」。
 */
async function makeOld(
  connection: DatabaseConnection,
  authz: AppAuthorization,
  key: string,
  shape: OldShape,
): Promise<void> {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  const next: JsonGrant[] = [];
  for (const grant of grantsOf(set)) {
    if (isFeedbackPage(grant)) {
      if (shape === 'strip') {
        continue;
      }
      next.push({
        resource: { ...grant.resource },
        actions: [{ action: 'access', policy: { type: 'custom' } }],
      });
      continue;
    }
    if (isFqc(grant) && newGrantActions(grant).length > 0) {
      if (shape === 'strip') {
        continue;
      }
      next.push({
        resource: { ...grant.resource },
        actions: grant.actions.map((action) => ({
          ...action,
          policy: { type: 'custom' },
        })),
      });
      continue;
    }
    next.push(grant);
  }
  await connection.query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify(next) })
    .where('key', '=', key)
    .execute();
}

async function snapshot(
  authz: AppAuthorization,
  key: string,
): Promise<SetSnapshot> {
  const set = await authz.permissionSets.get(key);
  if (!set) {
    throw new Error(`permission set ${key} is missing`);
  }
  return {
    grants: grantsOf(set),
    revision: set.revision as string,
    title: set.title as CreateTitle | undefined,
  };
}

interface ServicesHost {
  readonly container: {
    resolve(token: typeof authorizationToken): AppAuthorization;
    resolve(token: typeof userManagementServiceToken): UserManagementService;
    resolve(
      token: typeof userAdministrationServiceToken,
    ): UserAdministrationService;
  };
}

const services = (
  app: ServicesHost,
  connection: DatabaseConnection,
): R026UpgradeServices => ({
  authorization: app.container.resolve(authorizationToken),
  connection,
});

const contextFor = (authz: AppAuthorization, userId: string) =>
  authz.for({ principal: { type: 'user', id: userId } });
const canPage = (authz: AppAuthorization, userId: string) =>
  contextFor(authz, userId).can({
    resource: { type: 'page', id: FEEDBACK_PAGE_ID },
    action: 'access',
  });
const canFqc = (authz: AppAuthorization, userId: string, action: string) =>
  contextFor(authz, userId).can({
    resource: { type: 'composite', id: 'fqc' },
    action,
  });

async function createPerson(
  users: UserManagementService,
  name: string,
  roles?: readonly string[],
): Promise<string> {
  const created = await users.create({
    name,
    email: `${name}@example.test`,
    password: PASSWORD,
    ...(roles === undefined ? {} : { roleScopes: { app: [...roles] } }),
  });
  return created.id;
}

const rolesOf = async (
  users: UserManagementService,
  userId: string,
): Promise<string[]> => {
  const user = await users.get(userId);
  return user?.roleScopes.app
    ? [...(user.roleScopes.app as string[])]
    : [];
};

const staffAssignmentCount = async (
  authz: AppAuthorization,
  userId: string,
): Promise<number> =>
  (await authz.permissionSets.listAssignments()).filter(
    (entry) =>
      entry.permissionSet === 'staff' &&
      entry.subject.type === 'user' &&
      entry.subject.id === userId,
  ).length;

/** 建人初始化器会给新建的人带 staff；撤掉它，模拟升级命令之前的存量账号。 */
const revokeStaff = async (
  authz: AppAuthorization,
  userId: string,
): Promise<void> => {
  const assignment = (await authz.permissionSets.listAssignments('staff')).find(
    (entry) =>
      entry.subject.type === 'user' && entry.subject.id === userId,
  );
  if (assignment) {
    await authz.permissionSets.revoke(assignment.id);
  }
};

test('R-026 升级：页面 id 与 seed 写的一致（守门，接 quality-page-id 的现成写法）', () => {
  const seedIds = pageGrantIds(
    read(
      'database',
      'main',
      'seeds',
      '202611240001_seed_business_permission_sets.ts',
    ),
  );
  expect(seedIds).toContain('feedback');
  const fromCommand = /FEEDBACK_PAGE_ID\s*=\s*'([^']+)'/u.exec(
    read('cli', 'authz', 'upgrade-r026.ts'),
  );
  expect(fromCommand?.[1], '命令里的页面 id 要能被守门测试读到').toBeDefined();
  expect(seedIds).toContain(fromCommand?.[1]);
  expect(FEEDBACK_PAGE_ID).toBe(fromCommand?.[1]);
});

test('R-026 升级：旧环境只补三样新授权，别的角色逐项不变，重跑不写', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  for (const key of TARGETS) {
    await makeOld(connection, authz, key, 'strip');
  }
  await authz.permissionSets.create({
    key: CUSTOM_ROLE,
    grants: [
      {
        resource: { type: 'composite', id: 'fqc' },
        actions: [
          {
            action: 'view',
            policy: {
              type: 'composite',
              scopes: {
                fqcMessages: 'allRecords',
                fqcScreenings: 'allRecords',
                fqcTickets: 'allRecords',
                fqcScreeningReviews: 'allRecords',
              },
            },
          },
        ],
      },
    ],
  });

  const staffId = await createPerson(users, 'r026upgradestaff', ['staff']);
  const managerId = await createPerson(users, 'r026upgrademanager', [
    'quality_manager',
  ]);
  const inspectorId = await createPerson(users, 'r026upgradeinspector', [
    'quality_inspector',
  ]);

  // 前置条件真的成立：升级前有效权限为假。
  expect(await canPage(authz, staffId)).toBe(false);
  expect(await canFqc(authz, staffId, 'submit')).toBe(false);
  expect(await canFqc(authz, managerId, 'submit')).toBe(false);
  expect(await canFqc(authz, managerId, 'maintain')).toBe(false);
  expect(await canFqc(authz, inspectorId, 'maintain')).toBe(false);
  // 已有的「查看、处理」没有被旧环境的制作过程破坏。
  expect(await canFqc(authz, managerId, 'view')).toBe(true);
  expect(await canFqc(authz, managerId, 'handle')).toBe(true);

  const snapshots = new Map<string, SetSnapshot>();
  for (const key of [...TARGETS, ...OTHER_ROLES, CUSTOM_ROLE]) {
    snapshots.set(key, await snapshot(authz, key));
  }

  const lines: string[] = [];
  const report = await upgradeR026(services(app, connection), {
    info: (message) => lines.push(message),
  });
  expect(report.grants.changed.sort()).toEqual([...TARGETS].sort());
  expect(report.grants.unchanged).toEqual([]);
  expect(report.grants.missing).toEqual([]);
  expect(
    lines.some((line) => line.startsWith('[r026] === role grants ===')),
    '角色授权那一段要有段头',
  ).toBe(true);
  expect(
    lines.some(
      (line) => line.startsWith('[r026] added:') && line.includes('staff'),
    ),
  ).toBe(true);
  expect(
    lines.some((line) => line.startsWith('[r026] skipped (already current):')),
  ).toBe(true);

  for (const key of TARGETS) {
    const older = snapshots.get(key)!;
    const after = await snapshot(authz, key);
    // 只加不改：原有授权逐条不变，新授权各自成条。
    expect(after.grants.slice(0, older.grants.length)).toEqual(older.grants);
    const expectedNewCount = key === 'staff' ? 2 : 3;
    expect(after.grants, `${key} 新增的授权条数`).toHaveLength(
      older.grants.length + expectedNewCount,
    );
    expect(
      after.grants.filter(isFeedbackPage),
      `${key} 应得到一条无条件的反馈单页授权`,
    ).toEqual([
      {
        resource: { type: 'page', id: FEEDBACK_PAGE_ID },
        actions: [{ action: 'access' }],
      },
    ]);
    const submit = after.grants.find(
      (grant) => isFqc(grant) && grant.actions.some((a) => a.action === 'submit'),
    );
    expect(submit?.actions[0]?.policy, `${key} 提交反馈的范围`).toEqual({
      type: 'composite',
      scopes: { fqcMessages: 'recordsIOwn', fqcScreenings: 'recordsIOwn' },
    });
    if (key !== 'staff') {
      const maintain = after.grants.find(
        (grant) =>
          isFqc(grant) && grant.actions.some((a) => a.action === 'maintain'),
      );
      expect(maintain?.actions[0]?.policy, `${key} 维护反馈单的范围`).toEqual({
        type: 'composite',
        scopes: {
          fqcMessages: 'allRecords',
          fqcScreenings: 'allRecords',
          fqcTickets: 'allRecords',
        },
      });
    }
    expect(after.revision, `${key} 的版本号应前进`).not.toBe(older.revision);
    expect(
      lines.filter(
        (line) =>
          line.includes('[r026]') &&
          line.includes(key) &&
          /before/u.test(line),
      ),
      `${key} 缺改前日志`,
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line.includes('[r026]') &&
          line.includes(key) &&
          /after/u.test(line),
      ),
      `${key} 缺改后日志`,
    ).toHaveLength(1);
  }

  // 有效权限按 seed 的那一档放开（不是只比对授权文本）。
  expect(await canPage(authz, staffId)).toBe(true);
  expect(await canFqc(authz, staffId, 'submit')).toBe(true);
  expect(await canFqc(authz, staffId, 'maintain')).toBe(false);
  for (const id of [managerId, inspectorId]) {
    expect(await canPage(authz, id)).toBe(true);
    expect(await canFqc(authz, id, 'submit')).toBe(true);
    expect(await canFqc(authz, id, 'maintain')).toBe(true);
  }
  expect(await canFqc(authz, managerId, 'view')).toBe(true);
  expect(await canFqc(authz, managerId, 'handle')).toBe(true);

  for (const key of [...OTHER_ROLES, CUSTOM_ROLE]) {
    expect(await snapshot(authz, key), `${key} 整份授权不该被动`).toEqual(
      snapshots.get(key),
    );
  }

  // 幂等：第二次什么都不写，revision 也不动。
  const afterFirst = new Map<string, SetSnapshot>();
  for (const key of [...TARGETS, ...OTHER_ROLES, CUSTOM_ROLE]) {
    afterFirst.set(key, await snapshot(authz, key));
  }
  const second = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(second.grants.changed).toEqual([]);
  expect(second.grants.unchanged.sort()).toEqual([...TARGETS].sort());
  for (const key of afterFirst.keys()) {
    expect(await snapshot(authz, key), `${key} 重跑后不该变化`).toEqual(
      afterFirst.get(key),
    );
  }
});

test('R-026 升级：带条件的页面授权与带条件的动作不算已有，can() 由假变真', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  for (const key of TARGETS) {
    await makeOld(connection, authz, key, 'conditional');
  }
  const staffId = await createPerson(users, 'r026condstaff', ['staff']);
  const managerId = await createPerson(users, 'r026condmanager', [
    'quality_manager',
  ]);

  // 前置条件：带 policy 的授权被框架过滤，页面与动作都还没有有效权限。
  expect(await canPage(authz, staffId)).toBe(false);
  expect(await canFqc(authz, staffId, 'submit')).toBe(false);
  expect(await canFqc(authz, managerId, 'submit')).toBe(false);
  expect(await canFqc(authz, managerId, 'maintain')).toBe(false);

  const report = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(report.grants.changed.sort()).toEqual([...TARGETS].sort());
  expect(await canPage(authz, staffId)).toBe(true);
  expect(await canFqc(authz, staffId, 'submit')).toBe(true);
  expect(await canFqc(authz, managerId, 'submit')).toBe(true);
  expect(await canFqc(authz, managerId, 'maintain')).toBe(true);

  // 带条件的旧授权留着，新增的是无条件的那一条。
  const after = grantsOf((await authz.permissionSets.get('quality_manager'))!);
  expect(
    after.some(
      (grant) =>
        isFeedbackPage(grant) &&
        grant.actions.some((action) => action.policy?.type === 'custom'),
    ),
    '原有的带条件页面授权不该被删',
  ).toBe(true);
  expect(after.filter(isFeedbackPage)).toHaveLength(2);
  expect(
    after.filter(
      (grant) =>
        isFqc(grant) &&
        grant.actions.some(
          (action) => action.action === 'submit' && action.policy?.type === 'custom',
        ),
    ),
  ).toHaveLength(1);

  const second = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(second.grants.changed).toEqual([]);
});

test('R-026 升级：读到之后别人改了角色，什么都不写并报读后被改过', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz, TARGETS[0], 'strip');
  const before = new Map<string, SetSnapshot>();
  for (const key of TARGETS) {
    before.set(key, await snapshot(authz, key));
  }

  const setsApi = authz.permissionSets;
  const realUpdate = setsApi.update.bind(setsApi);
  let raced = false;
  const spy = vi.spyOn(setsApi, 'update').mockImplementation(
    async (key, input, expectedRevision) => {
      if (!raced && key === TARGETS[0]) {
        raced = true;
        const current = await setsApi.get(key);
        if (!current) {
          throw new Error(`permission set ${key} is missing`);
        }
        // 模拟管理员在角色编辑器里同时保存。
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
      upgradeR026(services(app, connection), {
        info: (message) => lines.push(message),
      }),
    ).rejects.toMatchObject({ name: 'PermissionSetConflictError' });
    expect(
      lines.some(
        (line) =>
          line.includes(TARGETS[0]) &&
          line.includes('读后被改过') &&
          line.includes('重载重跑'),
      ),
      '冲突日志要写明读后被改过、重载重跑',
    ).toBe(true);
    const racedAfter = await snapshot(authz, TARGETS[0]);
    expect(racedAfter.title).toEqual({ key: 'concurrent.edit', ns: 'app-local' });
    expect(racedAfter.grants).toEqual(before.get(TARGETS[0])!.grants);
    for (const key of TARGETS.slice(1)) {
      expect(await snapshot(authz, key), `${key} 不该被写`).toEqual(
        before.get(key),
      );
    }
  } finally {
    spy.mockRestore();
  }
});

test('R-026 升级：逐角色写，没有跨角色事务，中途失败重跑可补', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const key of TARGETS) {
    await makeOld(connection, authz, key, 'strip');
  }
  const setsApi = authz.permissionSets;
  const realUpdate = setsApi.update.bind(setsApi);
  let thrown = false;
  const spy = vi.spyOn(setsApi, 'update').mockImplementation(
    async (key, input, expectedRevision) => {
      if (!thrown && key === TARGETS[1]) {
        thrown = true;
        throw new Error('synthetic mid-run failure');
      }
      return realUpdate(key, input, expectedRevision);
    },
  );
  try {
    await expect(
      upgradeR026(services(app, connection), { info: () => undefined }),
    ).rejects.toThrow('synthetic mid-run failure');
    expect(
      (await snapshot(authz, TARGETS[0])).grants.filter(isFeedbackPage),
      '失败之前写下的角色已经补上',
    ).toHaveLength(1);
    expect(
      (await snapshot(authz, TARGETS[1])).grants.filter(isFeedbackPage),
      '失败的那个角色没写进去',
    ).toHaveLength(0);
    expect(
      (await snapshot(authz, TARGETS[2])).grants.filter(isFeedbackPage),
      '失败之后的角色没写进去',
    ).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }

  const again = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(again.grants.changed.sort()).toEqual([...TARGETS.slice(1)].sort());
  for (const key of TARGETS) {
    expect(
      (await snapshot(authz, key)).grants.filter(isFeedbackPage),
      `${key} 重跑后补齐`,
    ).toHaveLength(1);
  }
});

test('R-026 升级：存量的人补 staff，服务账号不补，已有不重复，重跑不重复', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const administration = app.container.resolve(userAdministrationServiceToken);
  // seed 下三个目标角色的新授权都在；这一步只该动用户指派。
  const fresh = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(fresh.grants.changed).toEqual([]);

  const person = await createPerson(users, 'r026newcomer');
  const already = await createPerson(users, 'r026already', ['staff']);
  const serviceAccount = await administration.createServiceAccount({
    name: 'r026-intake-bot',
  });
  const deleted = await createPerson(users, 'r026deleted');
  // 新建的「人」由建人初始化器带 staff；撤掉后才是「升级之前的存量账号」。
  await revokeStaff(authz, person);
  await revokeStaff(authz, deleted);
  await connection.query
    .updateTable('user')
    .set({ deletedAt: new Date() })
    .where('id', '=', deleted)
    .execute();
  expect(isServiceAccount(serviceAccount)).toBe(true);

  // 前置条件：存量的人没有 staff，服务账号没有任何角色。
  expect(await rolesOf(users, person)).toEqual(['member']);
  expect(await rolesOf(users, already)).toEqual(['staff']);
  expect(await rolesOf(users, serviceAccount.id)).toEqual([]);
  expect(await staffAssignmentCount(authz, deleted)).toBe(0);

  // 这一步不改任何权限集的 grants，版本不该动。
  const grantsBefore = new Map<string, SetSnapshot>();
  for (const key of [...TARGETS, ...OTHER_ROLES]) {
    grantsBefore.set(key, await snapshot(authz, key));
  }

  const staffLines: string[] = [];
  const report = await upgradeR026(services(app, connection), {
    info: (message) => staffLines.push(message),
  });
  expect(
    staffLines.some((line) => line.startsWith('[r026-staff] === staff assignments ===')),
    'staff 指派那一段要有段头',
  ).toBe(true);
  expect(
    staffLines.some(
      (line) => /^\[r026-staff\] assigned 1: /u.test(line) && line.includes(person),
    ),
    '补指派了几个要单独成一行',
  ).toBe(true);
  expect(
    staffLines.some(
      (line) =>
        line.startsWith('[r026-staff] skipped (already had staff) ') &&
        line.includes(already),
    ),
    '跳过了几个要单独成一行，已有 staff 的账号写在里面',
  ).toBe(true);
  expect(report.staff.assigned).toContain(person);
  expect(report.staff.assigned).not.toContain(already);
  expect(report.staff.assigned).not.toContain(serviceAccount.id);
  expect(report.staff.assigned).not.toContain(deleted);
  expect(report.staff.already).toContain(already);
  expect(
    (await authz.permissionSets.listAssignments('staff')).some(
      (assignment) => assignment.id === `user:${person}:staff`,
    ),
    '赋值键应当是 user:<id>:staff',
  ).toBe(true);
  expect(await rolesOf(users, person)).toEqual(expect.arrayContaining(['member', 'staff']));
  expect(await rolesOf(users, already)).toEqual(['staff']);
  expect(await rolesOf(users, serviceAccount.id)).toEqual([]);
  expect(await staffAssignmentCount(authz, person)).toBe(1);
  expect(await staffAssignmentCount(authz, already)).toBe(1);
  expect(await staffAssignmentCount(authz, serviceAccount.id)).toBe(0);
  expect(await staffAssignmentCount(authz, deleted)).toBe(0);
  for (const key of grantsBefore.keys()) {
    expect(await snapshot(authz, key), `${key} 的 grants 与 revision 不该被 staff 那一步动过`).toEqual(
      grantsBefore.get(key),
    );
  }

  const second = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(second.staff.assigned).toEqual([]);
  expect(await staffAssignmentCount(authz, person)).toBe(1);
  expect(await rolesOf(users, person)).toEqual(
    expect.arrayContaining(['member', 'staff']),
  );
  expect(await staffAssignmentCount(authz, serviceAccount.id)).toBe(0);
  expect(await staffAssignmentCount(authz, deleted)).toBe(0);
});

test('R-026 升级：角色不存在时记一行跳过，不抛错', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  await makeOld(connection, authz, 'quality_manager', 'strip');
  await connection.query
    .deleteFrom('authorizationPermissionSets')
    .where('key', '=', 'quality_inspector')
    .execute();
  const lines: string[] = [];
  const report = await upgradeR026(services(app, connection), {
    info: (message) => lines.push(message),
  });
  expect(report.grants.missing).toEqual(['quality_inspector']);
  expect(
    lines.some(
      (line) =>
        line.includes('[r026] quality_inspector') && line.includes('not found'),
    ),
  ).toBe(true);
  expect(
    lines.some((line) => line.includes('[r026] quality_manager') && /after/u.test(line)),
  ).toBe(true);
});


test('R-026 升级：已有范围键不合法的 submit 授权时补一条能被框架展开的', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  await makeOld(connection, authz, 'staff', 'strip');
  const set = await authz.permissionSets.get('staff');
  // 形状看着像 seed 的 composite 授权，但范围键没声明：框架展开不了，不算「已有」。
  const invalid = {
    resource: { type: 'composite', id: 'fqc' },
    actions: [
      {
        action: 'submit',
        policy: { type: 'composite', scopes: { fqcNoSuchTable: 'recordsIOwn' } },
      },
    ],
  };
  await connection.query
    .updateTable('authorizationPermissionSets')
    .set({ grants: JSON.stringify([...grantsOf(set!), invalid]) })
    .where('key', '=', 'staff')
    .execute();
  const staffId = await createPerson(users, 'r026badscope', ['staff']);
  expect(
    await canFqc(authz, staffId, 'submit'),
    '前置条件：这条范围键不合法的授权放不开 submit',
  ).toBe(false);

  const report = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(report.grants.changed).toContain('staff');
  const after = grantsOf((await authz.permissionSets.get('staff'))!);
  const submits = after.filter(
    (grant) =>
      isFqc(grant) && grant.actions.some((entry) => entry.action === 'submit'),
  );
  expect(submits, '旧的不合法授权留着，另加一条合法的').toHaveLength(2);
  expect(
    submits.some(
      (grant) =>
        grant.actions[0]?.policy?.scopes?.fqcMessages === 'recordsIOwn' &&
        grant.actions[0]?.policy?.scopes?.fqcScreenings === 'recordsIOwn',
    ),
    '新增的那条要能被框架展开（范围键是声明过的）',
  ).toBe(true);
  expect(await canFqc(authz, staffId, 'submit')).toBe(true);
});

test('R-026 升级：单个账号指派失败不影响后面的，日志点名且命令非零退出', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const first = await createPerson(users, 'r026failfirst');
  const second = await createPerson(users, 'r026failsecond');
  const third = await createPerson(users, 'r026failthird');
  for (const id of [first, second, third]) {
    await revokeStaff(authz, id);
  }
  for (const id of [first, second, third]) {
    expect(await staffAssignmentCount(authz, id)).toBe(0);
  }

  const setsApi = authz.permissionSets;
  const realAssign = setsApi.assign.bind(setsApi);
  const spy = vi.spyOn(setsApi, 'assign').mockImplementation(async (input) => {
    if (input.subject.type === 'user' && input.subject.id === first) {
      throw new Error('synthetic assign failure');
    }
    return realAssign(input);
  });
  try {
    const lines: string[] = [];
    const report = await upgradeR026(services(app, connection), {
      info: (message) => lines.push(message),
    });
    expect(report.staff.failed.map((entry) => entry.userId)).toEqual([first]);
    expect(report.staff.failed[0]?.reason).toContain('synthetic assign failure');
    expect(report.staff.assigned).toEqual(expect.arrayContaining([second, third]));
    expect(
      lines.some(
        (line) =>
          line.includes(first) &&
          line.includes('FAILED') &&
          line.includes('synthetic assign failure'),
      ),
      '失败日志要带账号 id 与原因',
    ).toBe(true);
    expect(
      lines.some(
        (line) => line.startsWith('[r026-staff] failed 1:') && line.includes(first),
      ),
      '汇总里要列出失败的账号',
    ).toBe(true);
    expect(() => assertStaffAssignmentsSucceeded(report)).toThrow(
      /staff assignment\(s\) failed/u,
    );
  } finally {
    spy.mockRestore();
  }

  const again = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(again.staff.assigned).toContain(first);
  expect(again.staff.failed).toEqual([]);
}, 120_000);

test('R-026 升级：与建人初始化器并发指派同一账号时不失败、不重复', async ({
  app,
  connection,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const person = await createPerson(users, 'r026racer');
  await revokeStaff(authz, person);
  expect(await staffAssignmentCount(authz, person)).toBe(0);

  const setsApi = authz.permissionSets;
  const realAssign = setsApi.assign.bind(setsApi);
  let raced = false;
  const spy = vi.spyOn(setsApi, 'assign').mockImplementation(async (input) => {
    if (
      !raced &&
      input.subject.type === 'user' &&
      input.subject.id === person
    ) {
      raced = true;
      // 用初始化器自己的函数先插同一条赋值；传一个不经过 spy 的薄代理避免递归。
      const proxy = {
        permissionSets: {
          assign: realAssign,
          listAssignments: setsApi.listAssignments.bind(setsApi),
        },
      } as unknown as Pick<AppAuthorization, 'permissionSets'>;
      await assignStaffBaseline(proxy, person, { error: () => undefined });
    }
    return realAssign(input);
  });
  try {
    const report = await upgradeR026(services(app, connection), {
      info: () => undefined,
    });
    expect(report.staff.failed).toEqual([]);
    expect(report.staff.already).toContain(person);
    expect(await staffAssignmentCount(authz, person)).toBe(1);
  } finally {
    spy.mockRestore();
  }
}, 120_000);

test('R-026 升级：跨 100 一页的边界不漏账号', async ({ app, connection }) => {
  const authz = app.container.resolve(authorizationToken);
  const users = app.container.resolve(userManagementServiceToken);
  const ids: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    ids.push(await createPerson(users, `r026page${String(index).padStart(3, '0')}`));
  }
  // 建人初始化器给新账号带了 staff；撤掉全部，模拟升级之前的存量环境。
  for (const assignment of await authz.permissionSets.listAssignments('staff')) {
    if (assignment.subject.type === 'user') {
      await authz.permissionSets.revoke(assignment.id);
    }
  }
  expect(await staffAssignmentCount(authz, ids[100]!)).toBe(0);

  const report = await upgradeR026(services(app, connection), {
    info: () => undefined,
  });
  expect(report.staff.failed).toEqual([]);
  expect(report.staff.assigned).toEqual(expect.arrayContaining(ids));
  for (const id of [ids[0]!, ids[50]!, ids[100]!]) {
    expect(await staffAssignmentCount(authz, id), `${id} 漏了`).toBe(1);
  }
}, 180_000);
