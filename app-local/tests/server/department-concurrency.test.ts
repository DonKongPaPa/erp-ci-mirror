import path from 'node:path';

import { createDatabaseTest } from '@nocobase/app-testing/server';
import {
  isUniqueConstraintViolation,
  type DatabaseConnection,
} from '@nocobase/db';
import { expect } from 'vitest';

import { departmentApiError } from '../../server/routes/departments.js';
import { DatabaseDepartmentMutations } from '../../server/providers/department-mutations.js';
import { DepartmentRuleError } from '../../server/providers/departments.js';

/**
 * R-012 第二部分的并发与回滚。
 *
 * 测试只连 Postgres：第 16 条的并发一半与第 17 条都要靠两连接竞争与咨询锁，
 * SQLite 单写者复现不出来。R-056 之后本机与 CI 同方言，这些用例一律真跑，
 * 不再按方言跳过。原因写在测试名与注释里。
 *
 * 第 15 条（整批回滚）往事务里注入一次写失败，断言成员关系、变动记录与部门的
 * 停用状态都和操作前一样。
 */
const test = createDatabaseTest({
  migrations: [
    {
      packageName: 'department-concurrency-test',
      directory: path.resolve(
        import.meta.dirname,
        '../../database/main/migrations',
      ),
    },
  ],
});

const now = new Date('2026-11-25T00:00:00.000Z');

interface DepartmentRow {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly kind: string;
  readonly code: string;
  readonly successorId: string | null;
  readonly succeededAt: Date | null;
}

interface MembershipRow {
  readonly id: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly isPrimary: boolean;
}

interface HistoryRow {
  readonly id: string;
  readonly userId: string;
  readonly fromDepartmentId: string | null;
  readonly toDepartmentId: string | null;
}

async function addDepartment(
  connection: DatabaseConnection,
  row: Pick<DepartmentRow, 'id' | 'title'> &
    Partial<Omit<DepartmentRow, 'id' | 'title'>>,
): Promise<void> {
  await connection.repository<DepartmentRow>('departments').createOne({
    values: {
      parentId: null,
      managerId: null,
      active: true,
      sortOrder: 0,
      kind: 'department',
      code: row.id,
      successorId: null,
      succeededAt: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    },
  });
}

async function addMember(
  connection: DatabaseConnection,
  row: Pick<MembershipRow, 'id' | 'departmentId' | 'userId'> &
    Partial<Omit<MembershipRow, 'id' | 'departmentId' | 'userId'>>,
): Promise<void> {
  await connection.repository<MembershipRow>('departmentMembers').createOne({
    values: { isPrimary: false, createdAt: now, ...row },
  });
}

/**
 * 在「清掉旧主部门」之后、「设新主部门」之前挂一道闸：通知测试已到达，等测试放行。
 *
 * 主部门并发的测试需要真正的重叠：第二个事务的快照与清除必须在第一个事务提交之前
 * 执行，否则它会把第一个刚设好的主部门改回非主，再顺序地设自己的，正确地成功
 * （这是服务层「设主部门会替换旧主部门」的正常行为，不是并发冲突）。CI 上第一版
 * 测试就是这样：两个事务的语句落在同一个时间线上，第二个在第一个提交之后才写。
 */
function gateMemberUpdate(
  tx: DatabaseConnection,
  hooks: { readonly reached: () => void; readonly wait: Promise<void> },
): DatabaseConnection {
  let gated = false;
  const wrapRepository = (
    repository: ReturnType<DatabaseConnection['repository']>,
  ) =>
    new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'updateOne' && !gated) {
          return async (...args: unknown[]) => {
            gated = true;
            hooks.reached();
            await hooks.wait;
            return await (value as (...inner: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'repository') {
        return (name: string) =>
          name === 'departmentMembers'
            ? wrapRepository(target.repository(name))
            : target.repository(name);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** 把事务连接包一层：第 failOn 次成员行写入抛错，用来制造「中途失败」。 */
function failingMembersConnection(
  tx: DatabaseConnection,
  failOn: number,
): DatabaseConnection {
  let writes = 0;
  const wrapRepository = (
    repository: ReturnType<DatabaseConnection['repository']>,
  ) =>
    new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'updateOne' || property === 'deleteOne') {
          return async (...args: unknown[]) => {
            writes += 1;
            if (writes >= failOn) {
              throw new Error('injected failure');
            }
            return await (value as (...inner: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'repository') {
        return (name: string) =>
          name === 'departmentMembers'
            ? wrapRepository(target.repository(name))
            : target.repository(name);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('R-012 验收16: a second primary row for one user is refused by the database', async ({
  connection,
}) => {
  await addDepartment(connection, { id: 'dept-a', title: '部门 A' });
  await addDepartment(connection, { id: 'dept-b', title: '部门 B' });
  await addMember(connection, {
    id: 'member-a',
    departmentId: 'dept-a',
    userId: 'user-1',
    isPrimary: true,
  });
  // 同一用户的兼职行可以有多行；主部门一行都不能再多。
  await addMember(connection, {
    id: 'member-b',
    departmentId: 'dept-b',
    userId: 'user-1',
  });
  await expect(
    addMember(connection, {
      id: 'member-b-primary',
      departmentId: 'dept-b',
      userId: 'user-1',
      isPrimary: true,
    }),
  ).rejects.toThrow();
  // 数据库层面没有写进去。
  const rows = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany({ filter: { userId: 'user-1' } });
  expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
});

test('R-012 验收16（仅 Postgres）：two sessions setting a primary at once leave one row and the loser gets a unique conflict', async ({
  database,
  connection,
}) => {
  // SQLite 是单写者，两个事务不会并行；这里需要真正的两连接竞争，所以只在
  // Postgres 上跑。第二个事务会阻塞在部分唯一索引上，第一个提交后它拿到唯一冲突。
  await addDepartment(connection, { id: 'dept-a', title: '部门 A' });
  await addDepartment(connection, { id: 'dept-b', title: '部门 B' });
  await addMember(connection, {
    id: 'member-a',
    departmentId: 'dept-a',
    userId: 'user-1',
  });
  await addMember(connection, {
    id: 'member-b',
    departmentId: 'dept-b',
    userId: 'user-1',
  });
  const mutations = new DatabaseDepartmentMutations(database);

  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondReached = Promise.withResolvers<void>();
  const allowSecondWrite = Promise.withResolvers<void>();
  const first = database.transaction(async (tx) => {
    await mutations.setPrimaryDepartment('dept-a', 'user-1', 'actor-1', tx);
    firstWritten.resolve();
    await releaseFirst.promise;
  });
  await firstWritten.promise;

  // 第二个事务：先读快照、再清旧主部门（此时第一个事务还没提交，它看不到那行主部门），
  // 然后停在设新主部门之前。等第一个事务提交之后再放行 —— 这时它的写入会撞上
  // 部分唯一索引。这样才是两个会话真正重叠的样子，而不是先后执行。
  const second = database
    .transaction(async (tx) => {
      await mutations.setPrimaryDepartment(
        'dept-b',
        'user-1',
        'actor-2',
        gateMemberUpdate(tx, {
          reached: () => secondReached.resolve(),
          wait: allowSecondWrite.promise,
        }),
      );
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  await secondReached.promise;
  releaseFirst.resolve();
  await first;
  allowSecondWrite.resolve();

  const failure = await second;
  expect(
    isUniqueConstraintViolation(failure),
    `第二个会话应当撞上主部门的部分唯一索引，实际是 ${String(failure)}`,
  ).toBe(true);
  const rows = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany({ filter: { userId: 'user-1' } });
  expect(rows.filter((row) => row.isPrimary).map((row) => row.departmentId)).toEqual([
    'dept-a',
  ]);
});

test('R-012 验收16: the primary department conflict is answered as 409', () => {
  const duplicate = Object.assign(new Error('duplicate key value'), {
    code: '23505',
  });
  const mapped = departmentApiError(duplicate);
  expect(mapped?.code, '唯一冲突应当映射成 409').toBe(409);
  expect(mapped?.reason).toBe('PRIMARY_DEPARTMENT_CONFLICT');
});

test('R-012 验收17（仅 Postgres）：two opposite moves do not both succeed and the tree has no cycle', async ({
  database,
  connection,
}) => {
  // 咨询锁只在 Postgres 上有；SQLite 单写者，两条相反的移动必然串行，测不到竞争。
  await addDepartment(connection, { id: 'node-a', title: 'A' });
  await addDepartment(connection, { id: 'node-b', title: 'B' });
  const mutations = new DatabaseDepartmentMutations(database);

  const firstWritten = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = database.transaction(async (tx) => {
    await mutations.updateDepartment('node-a', { parentId: 'node-b' }, tx);
    firstWritten.resolve();
    await release.promise;
  });
  await firstWritten.promise;

  const second = database
    .transaction(async (tx) => {
      await mutations.updateDepartment('node-b', { parentId: 'node-a' }, tx);
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  release.resolve();
  await first;

  const failure = await second;
  expect(failure).toBeInstanceOf(DepartmentRuleError);
  expect((failure as DepartmentRuleError).code).toBe('department-cycle');
  // 树里没有环：A 挂在 B 下，B 仍是根。
  const rows = await connection
    .repository<DepartmentRow>('departments')
    .findMany();
  expect(rows.find((row) => row.id === 'node-a')?.parentId).toBe('node-b');
  expect(rows.find((row) => row.id === 'node-b')?.parentId).toBeNull();
});

test('R-012 并发：两个会话建同名同码的部门只有一个成功（仅 Postgres）', async ({
  database,
  connection,
}) => {
  // 建部门也纳入结构变更的咨询锁：第二个事务等锁之后重新读快照，重名校验把它挡下。
  // SQLite 是单写者，这条竞争复现不出来，所以只在 Postgres 上跑。
  const mutations = new DatabaseDepartmentMutations(database);
  const firstWritten = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = database.transaction(async (tx) => {
    await mutations.createDepartment(
      { title: '并发部门', code: 'CONCURRENT-CODE' },
      tx,
    );
    firstWritten.resolve();
    await release.promise;
  });
  await firstWritten.promise;

  const second = database
    .transaction(async (tx) => {
      await mutations.createDepartment(
        { title: '并发部门', code: 'CONCURRENT-CODE' },
        tx,
      );
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  release.resolve();
  await first;

  const failure = await second;
  expect(failure).toBeInstanceOf(DepartmentRuleError);
  expect((failure as DepartmentRuleError).code).toBe('duplicate-title');
  const rows = await connection
    .repository<DepartmentRow>('departments')
    .findMany({ filter: { title: '并发部门' } });
  expect(rows).toHaveLength(1);
});

test('R-012 验收15: a merge that fails part way rolls memberships and history back', async ({
  database,
  connection,
}) => {
  await addDepartment(connection, { id: 'target', title: '目标' });
  await addDepartment(connection, { id: 'source', title: '源' });
  await addMember(connection, {
    id: 'move-1',
    departmentId: 'source',
    userId: 'user-1',
  });
  await addMember(connection, {
    id: 'move-2',
    departmentId: 'source',
    userId: 'user-2',
    isPrimary: true,
  });
  await addMember(connection, {
    id: 'stay',
    departmentId: 'target',
    userId: 'user-3',
  });
  const mutations = new DatabaseDepartmentMutations(database);

  await expect(
    database.transaction(async (tx) => {
      // 第二个成员行写入时失败：第一次移动已经发生，事务要整体回滚。
      await mutations.mergeDepartments(
        'source',
        'target',
        'actor',
        failingMembersConnection(tx, 2),
      );
    }),
  ).rejects.toThrow('injected failure');

  const memberships = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany();
  expect(
    memberships.map((row) => [row.id, row.departmentId]).sort(),
  ).toEqual([
    ['move-1', 'source'],
    ['move-2', 'source'],
    ['stay', 'target'],
  ]);
  expect(
    await connection.repository<HistoryRow>('departmentMemberHistory').count(),
  ).toBe(0);
  const source = await connection
    .repository<DepartmentRow>('departments')
    .findOne({ filter: { id: 'source' } });
  expect(source?.active, '失败的合并不能把源部门停用').toBe(true);
  expect(source?.successorId).toBeNull();
});

test('R-012 验收15: a transfer that fails part way rolls the whole batch back', async ({
  database,
  connection,
}) => {
  await addDepartment(connection, { id: 'from', title: '从' });
  await addDepartment(connection, { id: 'to', title: '到' });
  await addMember(connection, {
    id: 'move-1',
    departmentId: 'from',
    userId: 'user-1',
  });
  await addMember(connection, {
    id: 'move-2',
    departmentId: 'from',
    userId: 'user-2',
  });
  const mutations = new DatabaseDepartmentMutations(database);

  await expect(
    database.transaction(async (tx) => {
      await mutations.transferMembers(
        {
          userIds: ['user-1', 'user-2'],
          fromDepartmentId: 'from',
          toDepartmentId: 'to',
        },
        'actor',
        failingMembersConnection(tx, 2),
      );
    }),
  ).rejects.toThrow('injected failure');

  const memberships = await connection
    .repository<MembershipRow>('departmentMembers')
    .findMany();
  expect(memberships.map((row) => row.departmentId)).toEqual(['from', 'from']);
  expect(
    await connection.repository<HistoryRow>('departmentMemberHistory').count(),
  ).toBe(0);
});
