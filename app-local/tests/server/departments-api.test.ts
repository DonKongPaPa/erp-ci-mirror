import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { createAppTest } from '../helpers/test-app.js';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import {
  departmentServiceToken,
  type DepartmentService,
} from '../../server/providers/departments.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-012 第二部分的端点验收：建树、重名、成环、负责人、成员、停用、授权、
 * 暴露面、类型与编码、合并、批量调动、变动记录与整批回滚。
 *
 * 只在 Postgres 上成立的并发两条在 `departments-concurrency.test.ts`：本文件
 * 走 SQLite，能用接口做的都用接口做，内部服务直接取容器里的实现。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R012-dept-123!';

interface ApiErrorBody {
  error: {
    code: number;
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

interface DepartmentRow {
  id: string;
  title: string;
  parentId: string | null;
  managerId: string | null;
  active: boolean;
  sortOrder: number;
  kind: string;
  code: string;
  successorId: string | null;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TreeNode extends DepartmentRow {
  children: TreeNode[];
}

interface MembershipRow {
  id: string;
  departmentId: string;
  userId: string;
  isPrimary: boolean;
}

interface HistoryRow {
  id: string;
  userId: string;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  isPrimary: boolean;
  batchId: string;
  actorId: string;
}

interface MemberRow {
  userId: string;
  name: string | null;
  username: string | null;
  isPrimary: boolean;
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const expectJson = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> =>
  ((await expectJson(response, status)) as ApiErrorBody).error;

const expectDenied = async (
  response: Response,
  what: string,
): Promise<void> => {
  const error = await expectError(response, 403);
  expect(error.reason, `${what} 应当以 AUTHORIZATION_DENIED 被拒`).toBe(
    'AUTHORIZATION_DENIED',
  );
};

/** 每个测试用独立的名称与编码，测试之间共用一个库也不相撞。 */
const unique = (prefix: string): string =>
  `${prefix}-${randomUUID().slice(0, 8)}`;

const createDepartment = async (
  admin: TestSession,
  input: Record<string, unknown>,
): Promise<DepartmentRow> => {
  const response = await admin.fetch('/departments', json(input));
  return ((await expectJson(response, 201)) as { data: DepartmentRow }).data;
};

const createUser = async (
  admin: TestSession,
  roleScopes: Record<string, string[]> = { app: [] },
): Promise<{ id: string; name: string; username: string }> => {
  // 用户名只接受字母数字：不要用带连字符的 unique 前缀。
  const name = `r012user${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
  return (
    (await expectJson(response, 201)) as {
      data: { id: string; name: string; username: string };
    }
  ).data;
};

const treeNode = async (
  session: TestSession,
  id: string,
): Promise<TreeNode | undefined> => {
  const body = (await expectJson(
    await session.fetch('/departments/tree'),
    200,
  )) as { data: TreeNode[] };
  const walk = (nodes: readonly TreeNode[]): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) {
        return node;
      }
      const found = walk(node.children);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return walk(body.data);
};

const membershipsOf = async (
  connection: DatabaseConnection,
  userId: string,
): Promise<MembershipRow[]> =>
  await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany({ filter: { userId } });

const membersOfDepartment = async (
  connection: DatabaseConnection,
  departmentId: string,
): Promise<MembershipRow[]> =>
  await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany({ filter: { departmentId } });

const historyRows = async (
  connection: DatabaseConnection,
  filter: Partial<Pick<HistoryRow, 'fromDepartmentId' | 'batchId'>> = {},
): Promise<HistoryRow[]> =>
  await connection
    .repository<HistoryRow>('departmentMemberHistory')
    .findMany(Object.keys(filter).length === 0 ? {} : { filter });

test('R-012 验收7/8: the department resource is registered and business roles have neither action', async ({
  testApp,
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const collection of [
    'departments',
    'departmentMembers',
    'departmentMemberHistory',
  ]) {
    expect(
      authz.database.collections.has(collection),
      `${collection} 没有注册`,
    ).toBe(true);
  }
  expect(
    authz.compositeResources.getAction('departments', 'view'),
  ).toBeDefined();
  expect(
    authz.compositeResources.getAction('departments', 'manage'),
  ).toBeDefined();
  // 变动记录只追加：登记的动作里没有 update 与 delete，连 root 也不能经数据接口改它。
  const history = authz.database.collections
    .list()
    .find((collection) => collection.name === 'departmentMemberHistory');
  expect(history?.actions).toEqual(['read', 'create']);

  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  for (const role of [
    'quality_manager',
    'quality_inspector',
    'dept_manager',
    'staff',
  ]) {
    const user = await createUser(admin, { app: [role] });
    const context = authz.for({ principal: { type: 'user', id: user.id } });
    for (const action of ['view', 'manage']) {
      const decision = await context.authorize({
        resource: { type: 'composite', id: 'departments' },
        action,
      });
      expect(decision.effect, `${role} 不应当能 ${action} 部门`).toBe('deny');
    }
  }
});

test('R-012 验收1: a tree is built and /tree returns the complete hierarchy in order', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('tree');
  const root = await createDepartment(admin, {
    title: `公司-${suffix}`,
    code: `HQ-${suffix}`,
    kind: 'company',
  });
  // 同级排序：先建 sortOrder 2 的，再建 sortOrder 1 的，返回时 1 在前。
  const later = await createDepartment(admin, {
    title: `销售-${suffix}`,
    code: `SALES-${suffix}`,
    parentId: root.id,
    sortOrder: 2,
  });
  const earlier = await createDepartment(admin, {
    title: `人事-${suffix}`,
    code: `HR-${suffix}`,
    parentId: root.id,
    sortOrder: 1,
  });
  const grandchild = await createDepartment(admin, {
    title: `华东-${suffix}`,
    code: `EAST-${suffix}`,
    parentId: earlier.id,
    sortOrder: 1,
    kind: 'team',
  });

  const node = await treeNode(admin, root.id);
  expect(node, '/tree 里找不到根部门').toBeDefined();
  expect(node?.parentId).toBeNull();
  expect(node?.kind).toBe('company');
  expect(node?.children.map((child) => child.id)).toEqual([
    earlier.id,
    later.id,
  ]);
  expect(node?.children[0]?.children.map((child) => child.id)).toEqual([
    grandchild.id,
  ]);
  // 只有部门的字段：成员不在这里。
  expect(Object.keys(node ?? {}).sort()).toEqual([
    'active',
    'children',
    'code',
    'createdAt',
    'id',
    'kind',
    'managerId',
    'parentId',
    'sortOrder',
    'succeededAt',
    'successorId',
    'title',
    'updatedAt',
  ]);
});

test('R-012 验收2: a duplicate title under one parent is 409, the same title under another parent is accepted', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('title');
  const first = await createDepartment(admin, {
    title: `质量部-${suffix}`,
    code: `Q1-${suffix}`,
  });
  const conflict = await admin.fetch(
    '/departments',
    json({ title: `质量部-${suffix}`, code: `Q2-${suffix}` }),
  );
  expect((await expectError(conflict, 409)).reason).toBe('DUPLICATE_TITLE');

  const otherParent = await createDepartment(admin, {
    title: `制造中心-${suffix}`,
    code: `MFG-${suffix}`,
  });
  const accepted = await createDepartment(admin, {
    title: `质量部-${suffix}`,
    code: `Q3-${suffix}`,
    parentId: otherParent.id,
  });
  expect(accepted.parentId).toBe(otherParent.id);

  // 改成一个已存在的同级名称同样是 409。
  const sibling = await createDepartment(admin, {
    title: `另一个质量部-${suffix}`,
    code: `Q4-${suffix}`,
    parentId: otherParent.id,
  });
  const rename = await admin.fetch(
    `/departments/${sibling.id}`,
    json({ title: accepted.title }, 'PATCH'),
  );
  expect((await expectError(rename, 409)).reason).toBe('DUPLICATE_TITLE');

  // 根部门之间重名也算（数据库的唯一约束盖不到 parentId 为空的）。
  const rootClash = await admin.fetch(
    '/departments',
    json({ title: first.title, code: `Q5-${suffix}` }),
  );
  expect((await expectError(rootClash, 409)).reason).toBe('DUPLICATE_TITLE');
});

test('R-012 验收3: moving a department under its own descendant is 409 and the tree does not change', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('cycle');
  const root = await createDepartment(admin, {
    title: `根-${suffix}`,
    code: `ROOT-${suffix}`,
  });
  const child = await createDepartment(admin, {
    title: `子-${suffix}`,
    code: `CHILD-${suffix}`,
    parentId: root.id,
  });
  const grandchild = await createDepartment(admin, {
    title: `孙-${suffix}`,
    code: `GRAND-${suffix}`,
    parentId: child.id,
  });

  for (const parentId of [grandchild.id, root.id]) {
    const cycle = await admin.fetch(
      `/departments/${root.id}`,
      json({ parentId }, 'PATCH'),
    );
    expect((await expectError(cycle, 409)).reason).toBe('DEPARTMENT_CYCLE');
  }
  // 树不变。
  expect((await treeNode(admin, root.id))?.parentId).toBeNull();
  expect((await treeNode(admin, child.id))?.parentId).toBe(root.id);
  expect((await treeNode(admin, grandchild.id))?.parentId).toBe(child.id);

  // 正常的移动：子树跟着走。
  const otherRoot = await createDepartment(admin, {
    title: `另一个根-${suffix}`,
    code: `ROOT2-${suffix}`,
  });
  const moved = await admin.fetch(
    `/departments/${child.id}`,
    json({ parentId: otherRoot.id }, 'PATCH'),
  );
  expect(
    (await expectJson(moved, 200)) as { data: DepartmentRow },
  ).toMatchObject({
    data: { parentId: otherRoot.id },
  });
  const movedChild = await treeNode(admin, child.id);
  expect(movedChild?.parentId).toBe(otherRoot.id);
  expect(movedChild?.children.map((node) => node.id)).toEqual([grandchild.id]);
});

test('R-012 验收4: a manager must be a member, and the manager cannot be removed', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('manager');
  const department = await createDepartment(admin, {
    title: `部门-${suffix}`,
    code: `MGR-${suffix}`,
  });
  const member = await createUser(admin);
  const outsider = await createUser(admin);

  const added = await admin.fetch(
    `/departments/${department.id}/members`,
    json({ userIds: [member.id] }),
  );
  await expectJson(added, 200);

  // 不是本部门成员的人设负责人：422。
  const refused = await admin.fetch(
    `/departments/${department.id}`,
    json({ managerId: outsider.id }, 'PATCH'),
  );
  expect((await expectError(refused, 422)).reason).toBe('MANAGER_NOT_MEMBER');

  // 成员可以当负责人；负责人不能被移出。
  const accepted = await admin.fetch(
    `/departments/${department.id}`,
    json({ managerId: member.id }, 'PATCH'),
  );
  await expectJson(accepted, 200);
  const removeManager = await admin.fetch(
    `/departments/${department.id}/members/${member.id}`,
    json({}, 'DELETE'),
  );
  expect((await expectError(removeManager, 409)).reason).toBe(
    'MANAGER_CANNOT_BE_REMOVED',
  );
});

test('R-012 验收5: adding a member twice does not duplicate, primary moves, and the primary cannot be removed while other departments remain', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('member');
  const first = await createDepartment(admin, {
    title: `一-${suffix}`,
    code: `M1-${suffix}`,
  });
  const second = await createDepartment(admin, {
    title: `二-${suffix}`,
    code: `M2-${suffix}`,
  });
  const user = await createUser(admin);

  const firstAdd = (await expectJson(
    await admin.fetch(
      `/departments/${first.id}/members`,
      json({ userIds: [user.id, user.id] }),
    ),
    200,
  )) as { data: { added: string[]; skipped: string[] } };
  expect(firstAdd.data.added).toEqual([user.id]);
  const secondAdd = (await expectJson(
    await admin.fetch(
      `/departments/${first.id}/members`,
      json({ userIds: [user.id] }),
    ),
    200,
  )) as { data: { added: string[]; skipped: string[] } };
  expect(secondAdd.data.added).toEqual([]);
  expect(secondAdd.data.skipped).toEqual([user.id]);
  expect(await membersOfDepartment(connection, first.id)).toHaveLength(1);

  // 两个部门，先设一为主部门，再设二：主部门只剩一个。
  await admin.fetch(
    `/departments/${second.id}/members`,
    json({ userIds: [user.id] }),
  );
  await expectJson(
    await admin.fetch(
      `/departments/${first.id}/members/${user.id}/primary`,
      json({}),
    ),
    200,
  );
  let memberships = await membershipsOf(connection, user.id);
  expect(
    memberships
      .filter((membership) => membership.isPrimary)
      .map((row) => row.departmentId),
  ).toEqual([first.id]);

  await expectJson(
    await admin.fetch(
      `/departments/${second.id}/members/${user.id}/primary`,
      json({}),
    ),
    200,
  );
  memberships = await membershipsOf(connection, user.id);
  expect(
    memberships
      .filter((membership) => membership.isPrimary)
      .map((row) => row.departmentId),
  ).toEqual([second.id]);

  // 主部门还有别的部门在：不能直接移出。
  const refused = await admin.fetch(
    `/departments/${second.id}/members/${user.id}`,
    json({}, 'DELETE'),
  );
  expect((await expectError(refused, 409)).reason).toBe(
    'PRIMARY_DEPARTMENT_IN_USE',
  );

  // 先移出不是主部门的那个，再移出唯一的那一个。
  await expectJson(
    await admin.fetch(
      `/departments/${first.id}/members/${user.id}`,
      json({}, 'DELETE'),
    ),
    200,
  );
  await expectJson(
    await admin.fetch(
      `/departments/${second.id}/members/${user.id}`,
      json({}, 'DELETE'),
    ),
    200,
  );
  expect(await membershipsOf(connection, user.id)).toEqual([]);
});

test('R-012 验收6: deactivation needs an empty department, excludes it from the internal services, and the three moves are refused', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const service = app.container.resolve<DepartmentService>(
    departmentServiceToken,
  );
  const suffix = unique('deactivate');

  // 有成员不能停用。
  const busy = await createDepartment(admin, {
    title: `有成员-${suffix}`,
    code: `BUSY-${suffix}`,
  });
  const member = await createUser(admin);
  await admin.fetch(
    `/departments/${busy.id}/members`,
    json({ userIds: [member.id] }),
  );
  expect(
    (
      await expectError(
        await admin.fetch(`/departments/${busy.id}/deactivate`, json({})),
        409,
      )
    ).reason,
  ).toBe('DEPARTMENT_HAS_MEMBERS');

  // 有未停用子部门不能停用。
  const parent = await createDepartment(admin, {
    title: `父-${suffix}`,
    code: `PARENT-${suffix}`,
  });
  const child = await createDepartment(admin, {
    title: `子-${suffix}`,
    code: `CHILD-${suffix}`,
    parentId: parent.id,
  });
  expect(
    (
      await expectError(
        await admin.fetch(`/departments/${parent.id}/deactivate`, json({})),
        409,
      )
    ).reason,
  ).toBe('DEPARTMENT_HAS_ACTIVE_CHILDREN');

  // 先停用空的子部门，再停用父部门。
  await expectJson(
    await admin.fetch(`/departments/${child.id}/deactivate`, json({})),
    200,
  );
  await expectJson(
    await admin.fetch(`/departments/${parent.id}/deactivate`, json({})),
    200,
  );
  const deactivated = await treeNode(admin, parent.id);
  expect(deactivated?.active).toBe(false);
  // 内部服务不再计入它；名称仍能查到（业务记录会一直指着它）。
  await expect(service.subtreeIds(parent.id)).resolves.toEqual([]);
  await expect(service.departmentIdsOfUser(member.id)).resolves.toEqual([
    busy.id,
  ]);
  await expect(service.titlesByIds([parent.id])).resolves.toEqual({
    [parent.id]: parent.title,
  });

  // 三件被拒的事：往停用部门加成员、启用上级已停用的部门、把部门移到停用部门下面。
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${parent.id}/members`,
          json({ userIds: [member.id] }),
        ),
        409,
      )
    ).reason,
  ).toBe('DEPARTMENT_DEACTIVATED');
  expect(
    (
      await expectError(
        await admin.fetch(`/departments/${child.id}/activate`, json({})),
        409,
      )
    ).reason,
  ).toBe('PARENT_DEACTIVATED');
  const active = await createDepartment(admin, {
    title: `待移动-${suffix}`,
    code: `MOVE-${suffix}`,
  });
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${active.id}`,
          json({ parentId: parent.id }, 'PATCH'),
        ),
        409,
      )
    ).reason,
  ).toBe('PARENT_DEACTIVATED');

  // 能重新启用：先启用父部门，再启用子部门。
  const reactivatedParent = (await expectJson(
    await admin.fetch(`/departments/${parent.id}/activate`, json({})),
    200,
  )) as { data: DepartmentRow };
  expect(reactivatedParent.data.active).toBe(true);
  const reactivatedChild = (await expectJson(
    await admin.fetch(`/departments/${child.id}/activate`, json({})),
    200,
  )) as { data: DepartmentRow };
  expect(reactivatedChild.data.active).toBe(true);

  // 停用时可以指定继任者：记下继任者与时间，按编码能找到承接方；编码随之让出来。
  const retiring = await createDepartment(admin, {
    title: `退休-${suffix}`,
    code: `RETIRE-${suffix}`,
  });
  const heir = await createDepartment(admin, {
    title: `承接-${suffix}`,
    code: `HEIR-${suffix}`,
  });
  const retired = (await expectJson(
    await admin.fetch(
      `/departments/${retiring.id}/deactivate`,
      json({ successorId: heir.id }),
    ),
    200,
  )) as { data: DepartmentRow };
  expect(retired.data.successorId).toBe(heir.id);
  expect(typeof retired.data.succeededAt).toBe('string');
  await expect(service.byCode(retiring.code)).resolves.toBe(heir.id);
  // 已经指定继任者的部门不再占用编码。
  const recycled = await createDepartment(admin, {
    title: `复用编码-${suffix}`,
    code: retiring.code,
  });
  expect(recycled.code).toBe(retiring.code);
  // 继任者已停用时不能指定（不变量 5）。
  const otherRetiring = await createDepartment(admin, {
    title: `另一个退休-${suffix}`,
    code: `RETIRE2-${suffix}`,
  });
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${otherRetiring.id}/deactivate`,
          json({ successorId: retiring.id }),
        ),
        409,
      )
    ).reason,
  ).toBe('SUCCESSOR_DEACTIVATED');

  // 变动记录里没有停用/启用的行：这两件事不动成员关系。
  const history = await historyRows(connection);
  expect(
    history.filter(
      (row) =>
        row.fromDepartmentId === parent.id ||
        row.fromDepartmentId === child.id ||
        row.toDepartmentId === parent.id ||
        row.toDepartmentId === child.id,
    ),
  ).toEqual([]);
});

test('R-012 验收7: a user without departments.view or departments.manage is refused on every endpoint', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const nobodyUser = await createUser(admin, { app: [] });
  const nobody = await signIn(testApp, {
    username: nobodyUser.username,
    password: PASSWORD,
  });

  // 两个读端点。
  for (const path of ['/departments/tree', '/departments/any/members']) {
    await expectDenied(await nobody.fetch(path), `GET ${path}`);
  }

  // 全部写端点：请求体先过校验，才会走到授权那一步。
  const writes: [string, RequestInit][] = [
    [
      '/departments',
      json({ title: '被拒', code: `DENY-${randomUUID().slice(0, 8)}` }),
    ],
    ['/departments/any', json({ title: '改名' }, 'PATCH')],
    ['/departments/any/deactivate', json({})],
    ['/departments/any/activate', json({})],
    ['/departments/any/members', json({ userIds: ['u-1'] })],
    ['/departments/any/members/u-1', json({}, 'DELETE')],
    ['/departments/any/members/u-1/primary', json({})],
    ['/departments/any/merge', json({ targetId: 'other' })],
    [
      '/departments/members/transfer',
      json({ userIds: ['u-1'], fromDepartmentId: 'a', toDepartmentId: 'b' }),
    ],
  ];
  for (const [path, init] of writes) {
    await expectDenied(
      await nobody.fetch(path, init),
      `${init.method} ${path}`,
    );
  }
});

test('R-012 验收8: the member endpoint returns the identifier, name, username and primary flag only', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('expose');
  const department = await createDepartment(admin, {
    title: `暴露面-${suffix}`,
    code: `EXPOSE-${suffix}`,
  });
  const member = await createUser(admin);
  await admin.fetch(
    `/departments/${department.id}/members`,
    json({ userIds: [member.id] }),
  );

  const body = (await expectJson(
    await admin.fetch(`/departments/${department.id}/members`),
    200,
  )) as {
    data: MemberRow[];
    meta: { page: number; pageSize: number; total: number };
  };
  expect(body.data).toHaveLength(1);
  // 三列之外只有这一个布尔：成员关系的事实，不是个人属性。邮箱仍然不回。
  expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
    'isPrimary',
    'name',
    'userId',
    'username',
  ]);
  expect(body.data[0]).toEqual({
    userId: member.id,
    name: member.name,
    username: member.username,
    isPrimary: false,
  });
  expect(JSON.stringify(body)).not.toContain('@example.test');
  expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });

  // 设为主部门之后，标记跟着变。
  const primary = await admin.fetch(
    `/departments/${department.id}/members/${member.id}/primary`,
    json({}),
  );
  expect(primary.status, `${await primary.clone().text()}`).toBe(200);
  const updated = (await expectJson(
    await admin.fetch(`/departments/${department.id}/members`),
    200,
  )) as { data: MemberRow[] };
  expect(updated.data).toHaveLength(1);
  expect(updated.data[0]?.isPrimary).toBe(true);
});

test('R-012 验收11: a missing code is 422, a code in use is 409, and a kind outside the four is 422', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('code');
  await createDepartment(admin, {
    title: `占码-${suffix}`,
    code: `TAKEN-${suffix}`,
  });

  const missing = await admin.fetch(
    '/departments',
    json({ title: `没编码-${suffix}` }),
  );
  expect((await expectError(missing, 422)).reason).toBe('CODE_REQUIRED');

  const duplicate = await admin.fetch(
    '/departments',
    json({ title: `同码-${suffix}`, code: `TAKEN-${suffix}` }),
  );
  expect((await expectError(duplicate, 409)).reason).toBe('DUPLICATE_CODE');

  const badKind = await admin.fetch(
    '/departments',
    json({
      title: `错类型-${suffix}`,
      code: `KIND-${suffix}`,
      kind: 'division',
    }),
  );
  expect((await expectError(badKind, 422)).reason).toBe(
    'INVALID_DEPARTMENT_KIND',
  );

  for (const kind of ['company', 'center', 'department', 'team']) {
    const created = await createDepartment(admin, {
      title: `类型-${kind}-${suffix}`,
      code: `KIND-${kind}-${suffix}`,
      kind,
    });
    expect(created.kind).toBe(kind);
  }
});

test('R-012 验收12: merging moves every member, clears the source manager, deactivates the source and records the successor', async ({
  testApp,
  app,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const service = app.container.resolve<DepartmentService>(
    departmentServiceToken,
  );
  const suffix = unique('merge');
  const target = await createDepartment(admin, {
    title: `目标-${suffix}`,
    code: `TARGET-${suffix}`,
  });
  const source = await createDepartment(admin, {
    title: `源-${suffix}`,
    code: `SOURCE-${suffix}`,
  });

  const primaryMember = await createUser(admin);
  const partTimeMember = await createUser(admin);
  const bothMember = await createUser(admin);
  const manager = await createUser(admin);

  await admin.fetch(
    `/departments/${source.id}/members`,
    json({
      userIds: [primaryMember.id, partTimeMember.id, bothMember.id, manager.id],
    }),
  );
  await admin.fetch(
    `/departments/${target.id}/members`,
    json({ userIds: [bothMember.id] }),
  );
  await admin.fetch(
    `/departments/${source.id}/members/${primaryMember.id}/primary`,
    json({}),
  );
  await admin.fetch(
    `/departments/${source.id}`,
    json({ managerId: manager.id }, 'PATCH'),
  );
  const merged = (await expectJson(
    await admin.fetch(
      `/departments/${source.id}/merge`,
      json({ targetId: target.id }),
    ),
    200,
  )) as { data: { moved: number; removed: number; department: DepartmentRow } };
  expect(merged.data.moved).toBe(3);
  expect(merged.data.removed).toBe(1);

  // 1. 主部门成员到目标仍是主部门；2. 兼职仍是兼职。
  const primaryAfter = (await membershipsOf(connection, primaryMember.id)).find(
    (row) => row.departmentId === target.id,
  );
  expect(primaryAfter?.isPrimary).toBe(true);
  const partTimeAfter = (
    await membershipsOf(connection, partTimeMember.id)
  ).find((row) => row.departmentId === target.id);
  expect(partTimeAfter?.isPrimary).toBe(false);
  // 3. 已经在目标部门的只删掉源部门那一行。
  expect(await membershipsOf(connection, bothMember.id)).toEqual([
    expect.objectContaining({ departmentId: target.id, isPrimary: false }),
  ]);
  // 4. 源部门负责人清空。
  const sourceAfter = await treeNode(admin, source.id);
  expect(sourceAfter?.managerId).toBeNull();
  // 5. 源部门停用并记下继任者与时间。
  expect(sourceAfter?.active).toBe(false);
  expect(sourceAfter?.successorId).toBe(target.id);
  expect(typeof sourceAfter?.succeededAt).toBe('string');
  // 合并后按源部门的编码能找到目标部门。
  await expect(service.byCode(source.code)).resolves.toBe(target.id);

  // 每个被移动的成员一行变动记录，共用一个批次号。按源部门过滤，不依赖返回顺序。
  const after = (await historyRows(connection)).filter(
    (row) => row.fromDepartmentId === source.id,
  );
  expect(after).toHaveLength(4);
  expect(new Set(after.map((row) => row.batchId)).size).toBe(1);
  expect(after.every((row) => row.fromDepartmentId === source.id)).toBe(true);
  expect(
    after.find((row) => row.userId === bothMember.id)?.toDepartmentId,
  ).toBeNull();

  // 源部门还有未停用的子部门：409，一个成员都不动。
  const blocked = await createDepartment(admin, {
    title: `带子部门-${suffix}`,
    code: `BLOCKED-${suffix}`,
  });
  await createDepartment(admin, {
    title: `子-${suffix}`,
    code: `BLOCKEDCHILD-${suffix}`,
    parentId: blocked.id,
  });
  const blockedMember = await createUser(admin);
  await admin.fetch(
    `/departments/${blocked.id}/members`,
    json({ userIds: [blockedMember.id] }),
  );
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${blocked.id}/merge`,
          json({ targetId: target.id }),
        ),
        409,
      )
    ).reason,
  ).toBe('MERGE_SOURCE_HAS_ACTIVE_CHILDREN');
  expect(await membersOfDepartment(connection, blocked.id)).toHaveLength(1);
  expect((await treeNode(admin, blocked.id))?.active).toBe(true);

  // 目标就是自己、目标已停用：422。
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${blocked.id}/merge`,
          json({ targetId: blocked.id }),
        ),
        422,
      )
    ).reason,
  ).toBe('MERGE_TARGET_SELF');
  const closed = await createDepartment(admin, {
    title: `已停用-${suffix}`,
    code: `CLOSED-${suffix}`,
  });
  await admin.fetch(`/departments/${closed.id}/deactivate`, json({}));
  expect(
    (
      await expectError(
        await admin.fetch(
          `/departments/${blocked.id}/merge`,
          json({ targetId: closed.id }),
        ),
        422,
      )
    ).reason,
  ).toBe('MERGE_TARGET_DEACTIVATED');
});

test('R-012 验收12: a member already in the target keeps the primary flag when the source row was primary', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('merge-primary');
  const target = await createDepartment(admin, {
    title: `目标-${suffix}`,
    code: `TARGET-${suffix}`,
  });
  const source = await createDepartment(admin, {
    title: `源-${suffix}`,
    code: `SOURCE-${suffix}`,
  });
  const user = await createUser(admin);
  await admin.fetch(
    `/departments/${source.id}/members`,
    json({ userIds: [user.id] }),
  );
  await admin.fetch(
    `/departments/${target.id}/members`,
    json({ userIds: [user.id] }),
  );
  // 分配前：源部门那一行是主部门，目标部门那一行是兼职。
  await expectJson(
    await admin.fetch(
      `/departments/${source.id}/members/${user.id}/primary`,
      json({}),
    ),
    200,
  );
  const before = await membershipsOf(connection, user.id);
  expect(
    before.find((row) => row.departmentId === source.id)?.isPrimary,
    '分配前源部门那一行应当是主部门',
  ).toBe(true);
  expect(
    before.find((row) => row.departmentId === target.id)?.isPrimary,
    '分配前目标部门那一行应当是兼职',
  ).toBe(false);

  const merged = (await expectJson(
    await admin.fetch(
      `/departments/${source.id}/merge`,
      json({ targetId: target.id }),
    ),
    200,
  )) as { data: { moved: number; removed: number } };
  expect(merged.data).toMatchObject({ moved: 0, removed: 1 });

  // 分配后：只剩目标部门那一行，且它接任主部门。
  const after = await membershipsOf(connection, user.id);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    departmentId: target.id,
    isPrimary: true,
  });
  // 变动记录跟着说清楚：从源部门到目标部门，变动之后是主部门。
  const history = (await historyRows(connection)).filter(
    (row) => row.userId === user.id && row.fromDepartmentId === source.id,
  );
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    toDepartmentId: target.id,
    isPrimary: true,
  });
});

test('R-012 验收13: a batch transfer moves everyone, keeps the primary flag, and rejects the whole batch otherwise', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('transfer');
  const from = await createDepartment(admin, {
    title: `从-${suffix}`,
    code: `FROM-${suffix}`,
  });
  const to = await createDepartment(admin, {
    title: `到-${suffix}`,
    code: `TO-${suffix}`,
  });
  const primary = await createUser(admin);
  const partTime = await createUser(admin);
  const both = await createUser(admin);
  const untouched = await createUser(admin);
  const manager = await createUser(admin);

  await admin.fetch(
    `/departments/${from.id}/members`,
    json({
      userIds: [primary.id, partTime.id, both.id, untouched.id, manager.id],
    }),
  );
  await admin.fetch(
    `/departments/${to.id}/members`,
    json({ userIds: [both.id] }),
  );
  await admin.fetch(
    `/departments/${from.id}/members/${primary.id}/primary`,
    json({}),
  );
  await admin.fetch(
    `/departments/${from.id}`,
    json({ managerId: manager.id }, 'PATCH'),
  );

  const transferred = (await expectJson(
    await admin.fetch(
      '/departments/members/transfer',
      json({
        userIds: [primary.id, partTime.id, both.id],
        fromDepartmentId: from.id,
        toDepartmentId: to.id,
      }),
    ),
    200,
  )) as { data: { moved: number; removed: number } };
  expect(transferred.data).toEqual({ moved: 2, removed: 1 });

  // 主部门的标记跟着走。
  expect(
    (await membershipsOf(connection, primary.id)).filter(
      (row) => row.departmentId === to.id,
    )[0]?.isPrimary,
  ).toBe(true);
  expect(
    (await membershipsOf(connection, partTime.id)).filter(
      (row) => row.departmentId === to.id,
    )[0]?.isPrimary,
  ).toBe(false);
  // 已经在目标部门的只删源部门那一行。
  expect(await membershipsOf(connection, both.id)).toEqual([
    expect.objectContaining({ departmentId: to.id }),
  ]);

  const before = await historyRows(connection);
  // 有人不在源部门：整批拒绝，一个都不动。
  const foreigner = await createUser(admin);
  expect(
    (
      await expectError(
        await admin.fetch(
          '/departments/members/transfer',
          json({
            userIds: [untouched.id, foreigner.id],
            fromDepartmentId: from.id,
            toDepartmentId: to.id,
          }),
        ),
        409,
      )
    ).reason,
  ).toBe('TRANSFER_USER_NOT_MEMBER');
  expect(
    (await membershipsOf(connection, untouched.id)).map(
      (row) => row.departmentId,
    ),
  ).toEqual([from.id]);
  expect(await historyRows(connection)).toEqual(before);

  // 这批人包含源部门的负责人：整批拒绝。
  expect(
    (
      await expectError(
        await admin.fetch(
          '/departments/members/transfer',
          json({
            userIds: [untouched.id, manager.id],
            fromDepartmentId: from.id,
            toDepartmentId: to.id,
          }),
        ),
        409,
      )
    ).reason,
  ).toBe('TRANSFER_INCLUDES_MANAGER');
  expect(
    (await membershipsOf(connection, untouched.id)).map(
      (row) => row.departmentId,
    ),
  ).toEqual([from.id]);
});

test('R-012 验收14: every membership change appends a history row and one batch shares one batch id', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('history');
  const department = await createDepartment(admin, {
    title: `记录-${suffix}`,
    code: `HIST-${suffix}`,
  });
  const other = await createDepartment(admin, {
    title: `记录二-${suffix}`,
    code: `HIST2-${suffix}`,
  });
  const user = await createUser(admin);

  await admin.fetch(
    `/departments/${department.id}/members`,
    json({ userIds: [user.id] }),
  );
  await admin.fetch(
    `/departments/${other.id}/members`,
    json({ userIds: [user.id] }),
  );
  await admin.fetch(
    `/departments/${other.id}/members/${user.id}/primary`,
    json({}),
  );
  await admin.fetch(
    `/departments/${department.id}/members/${user.id}`,
    json({}, 'DELETE'),
  );

  const rows = (await historyRows(connection)).filter(
    (row) =>
      row.userId === user.id &&
      (row.fromDepartmentId === department.id ||
        row.fromDepartmentId === other.id ||
        row.toDepartmentId === department.id ||
        row.toDepartmentId === other.id),
  );
  expect(rows).toHaveLength(4);
  // 加入：from 为空；移出：to 为空；改主部门：from 是旧主部门（没有旧的则为空）、
  // to 是新主部门。顺序按 findMany 的返回，不假定插入顺序，逐条找。
  const findRow = (
    from: string | null,
    to: string | null,
    isPrimary: boolean,
  ) =>
    rows.find(
      (row) =>
        row.fromDepartmentId === from &&
        row.toDepartmentId === to &&
        row.isPrimary === isPrimary,
    );
  expect(findRow(null, department.id, false)).toMatchObject({
    userId: user.id,
  });
  expect(findRow(null, other.id, false)).toMatchObject({ userId: user.id });
  expect(findRow(null, other.id, true)).toMatchObject({ userId: user.id });
  expect(findRow(department.id, null, false)).toMatchObject({
    userId: user.id,
  });
  // 单次操作也各有一个批次号；同一次操作的行共用同一个。
  expect(rows.every((row) => row.batchId.length > 0)).toBe(true);
  expect(new Set(rows.map((row) => row.batchId)).size).toBe(4);
  expect(rows.every((row) => row.actorId.length > 0)).toBe(true);

  // 一次批量调动：同一次操作的行批次号一致。
  const batch = (await expectJson(
    await admin.fetch(
      '/departments/members/transfer',
      json({
        userIds: [user.id],
        fromDepartmentId: other.id,
        toDepartmentId: department.id,
      }),
    ),
    200,
  )) as { data: { moved: number } };
  expect(batch.data.moved).toBe(1);
  const batchRows = (await historyRows(connection)).filter(
    (row) =>
      row.fromDepartmentId === other.id && row.toDepartmentId === department.id,
  );
  expect(batchRows).toHaveLength(1);
  expect(batchRows[0]).toMatchObject({ userId: user.id });
});

test('R-012 验收15: a rejected merge or transfer leaves memberships, history and the department state untouched', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const suffix = unique('rollback');
  const from = await createDepartment(admin, {
    title: `回滚从-${suffix}`,
    code: `RB1-${suffix}`,
  });
  const to = await createDepartment(admin, {
    title: `回滚到-${suffix}`,
    code: `RB2-${suffix}`,
  });
  const first = await createUser(admin);
  const second = await createUser(admin);
  const manager = await createUser(admin);
  await admin.fetch(
    `/departments/${from.id}/members`,
    json({ userIds: [first.id, second.id, manager.id] }),
  );
  await admin.fetch(
    `/departments/${from.id}`,
    json({ managerId: manager.id }, 'PATCH'),
  );

  const beforeMemberships = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany();
  const beforeHistory = await historyRows(connection);

  // 批量调动里包含源部门的负责人：预检拒绝，一行都不动。
  expect(
    (
      await expectError(
        await admin.fetch(
          '/departments/members/transfer',
          json({
            userIds: [first.id, manager.id],
            fromDepartmentId: from.id,
            toDepartmentId: to.id,
          }),
        ),
        409,
      )
    ).reason,
  ).toBe('TRANSFER_INCLUDES_MANAGER');
  expect(
    await connection.repository<MembershipRow>('departmentMembers').findMany(),
  ).toEqual(beforeMemberships);
  expect(await historyRows(connection)).toEqual(beforeHistory);

  // 合并的源部门还有未停用的子部门：409，成员关系、变动记录、停用状态都不变。
  const source = await createDepartment(admin, {
    title: `合并回滚-${suffix}`,
    code: `RB3-${suffix}`,
  });
  await createDepartment(admin, {
    title: `合并回滚子-${suffix}`,
    code: `RB4-${suffix}`,
    parentId: source.id,
  });
  await admin.fetch(
    `/departments/${source.id}/members`,
    json({ userIds: [second.id] }),
  );
  await admin.fetch(
    `/departments/${from.id}/members/${second.id}`,
    json({}, 'DELETE'),
  );
  const afterMergeSetup = await historyRows(connection);
  const beforeMergeMemberships = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany();
  expect(
    await expectError(
      await admin.fetch(
        `/departments/${source.id}/merge`,
        json({ targetId: to.id }),
      ),
      409,
    ),
  ).toMatchObject({ reason: 'MERGE_SOURCE_HAS_ACTIVE_CHILDREN' });
  expect(await historyRows(connection)).toEqual(afterMergeSetup);
  expect(
    await connection.repository<MembershipRow>('departmentMembers').findMany(),
  ).toEqual(beforeMergeMemberships);
  expect(
    (await membershipsOf(connection, second.id)).map((row) => row.departmentId),
  ).toEqual([source.id]);
  expect((await treeNode(admin, source.id))?.active).toBe(true);
});

test('R-012: a cookie write without Origin is refused before it reaches the handler', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/departments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `没有来源-${unique('origin')}`,
      code: `NOORIGIN-${unique('origin')}`,
    }),
  });
  // 框架的 `auth.required()` 对带 cookie 的非 GET 请求校验来源；缺了就是 403。
  expect((await expectError(response, 403)).reason).toBe('INVALID_CSRF_ORIGIN');
});
