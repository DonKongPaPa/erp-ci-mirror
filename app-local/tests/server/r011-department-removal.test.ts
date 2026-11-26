import path from 'node:path';

import { createDatabaseTest } from '@nocobase/app-testing/server';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { DatabaseDepartmentMutations } from '../../server/providers/department-mutations.js';
import {
  DatabaseDepartmentService,
  DepartmentRuleError,
} from '../../server/providers/departments.js';

/**
 * R-011 S2b：`removeFromAllDepartments` 的验收（D:223、验收 15 后半）。
 * 一次调用、一个批次号、每个部门一行变动记录；负责人（含停用部门）一行不写；
 * 不在任何部门时返回空。测试只连 Postgres，真跑。
 */
const test = createDatabaseTest({
  migrations: [
    {
      packageName: 'r011-department-removal-test',
      directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
    },
  ],
});

const now = new Date('2026-11-26T00:00:00.000Z');
const ACTOR = 'r011-actor';
const USER = 'r011-leaver';

interface DeptRow {
  id: string;
  title: string;
  parentId: string | null;
  managerId: string | null;
  active: boolean;
  sortOrder: number;
  kind: string;
  code: string;
  successorId: string | null;
  succeededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemberRow {
  id: string;
  departmentId: string;
  userId: string;
  isPrimary: boolean;
  createdAt: Date;
}

interface HistoryRow {
  id: string;
  userId: string;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  isPrimary: boolean;
  batchId: string;
  actorId: string;
  createdAt: Date;
}

async function addDept(
  connection: DatabaseConnection,
  id: string,
  overrides: Partial<DeptRow> = {},
): Promise<void> {
  await connection.repository<DeptRow>('departments').createOne({
    values: {
      id,
      title: id,
      parentId: null,
      managerId: null,
      active: true,
      sortOrder: 0,
      kind: 'department',
      code: id,
      successorId: null,
      succeededAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
  });
}

async function addMember(
  connection: DatabaseConnection,
  departmentId: string,
  userId = USER,
  isPrimary = false,
): Promise<void> {
  await connection.repository<MemberRow>('departmentMembers').createOne({
    values: {
      id: `${departmentId}-${userId}`,
      departmentId,
      userId,
      isPrimary,
      createdAt: now,
    },
  });
}

function memberCount(connection: DatabaseConnection, userId: string) {
  return connection.repository<MemberRow>('departmentMembers').count({
    filter: { userId },
  });
}

function historyRows(connection: DatabaseConnection, userId: string) {
  return connection.repository<HistoryRow>('departmentMemberHistory').findMany({
    filter: { userId },
  });
}

test('R-011: one call removes every department and shares one batch id', async ({
  database,
  connection,
}) => {
  for (const id of ['a', 'b', 'c']) {
    await addDept(connection, id);
    await addMember(connection, id, USER, id === 'a');
  }
  const mutations = new DatabaseDepartmentMutations(database);

  const result = await mutations.removeFromAllDepartments(USER, ACTOR);

  expect(result.departmentIds).toEqual(['a', 'b', 'c']);
  expect(typeof result.batchId).toBe('string');
  expect(result.batchId).not.toBe('');
  expect(await memberCount(connection, USER)).toBe(0);
  const rows = await historyRows(connection, USER);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.batchId))).toEqual(new Set([result.batchId]));
  expect(rows.map((row) => row.fromDepartmentId).sort()).toEqual(['a', 'b', 'c']);
  expect(rows.every((row) => row.toDepartmentId === null)).toBe(true);
  expect(rows.every((row) => row.actorId === ACTOR)).toBe(true);
});

test('R-011: a manager of an active department is refused and nothing is written', async ({
  database,
  connection,
}) => {
  await addDept(connection, 'dept', { managerId: USER });
  await addMember(connection, 'dept', USER, true);
  const mutations = new DatabaseDepartmentMutations(database);

  await expect(
    mutations.removeFromAllDepartments(USER, ACTOR),
  ).rejects.toMatchObject({
    name: 'DepartmentRuleError',
    code: 'manager-cannot-be-removed',
  });
  expect(await memberCount(connection, USER)).toBe(1);
  expect(await historyRows(connection, USER)).toHaveLength(0);
});

test('R-011: a manager of a deactivated department is refused too', async ({
  database,
  connection,
}) => {
  // 停用的部门按不变量必须没有成员，但负责人字段仍可能留着（改组的历史）。
  await addDept(connection, 'old', { active: false, managerId: USER });
  await addDept(connection, 'live');
  await addMember(connection, 'live', USER, true);
  const mutations = new DatabaseDepartmentMutations(database);

  await expect(
    mutations.removeFromAllDepartments(USER, ACTOR),
  ).rejects.toBeInstanceOf(DepartmentRuleError);
  expect(await memberCount(connection, USER)).toBe(1);
  expect(await historyRows(connection, USER)).toHaveLength(0);
});

test('R-011: a user outside every department returns an empty batch and writes nothing', async ({
  database,
  connection,
}) => {
  await addDept(connection, 'other');
  const mutations = new DatabaseDepartmentMutations(database);

  const result = await mutations.removeFromAllDepartments(USER, ACTOR);

  expect(result).toEqual({ batchId: null, departmentIds: [] });
  expect(await historyRows(connection, USER)).toHaveLength(0);
});

test('R-011: removal joined to a caller transaction rolls back as one', async ({
  database,
  connection,
}) => {
  await addDept(connection, 'dept');
  await addMember(connection, 'dept', USER, true);
  const mutations = new DatabaseDepartmentMutations(database);

  await expect(
    connection.transaction(async (tx) => {
      await mutations.removeFromAllDepartments(USER, ACTOR, tx);
      throw new Error('force rollback');
    }),
  ).rejects.toThrow('force rollback');

  expect(await memberCount(connection, USER)).toBe(1);
  expect(await historyRows(connection, USER)).toHaveLength(0);
});


test('R-011 验收15 前半: the shared read service returns no members for a deactivated department', async ({
  database,
  connection,
}) => {
  await addDept(connection, 'closed', { active: false });
  await addDept(connection, 'open');
  await addMember(connection, 'closed', USER, true);
  const service = new DatabaseDepartmentService(database);

  expect(await service.memberIdsOf('closed')).toEqual([]);
  expect(await service.memberIdsOf('open')).toEqual([]);
  expect(await service.memberIdsOf('missing')).toEqual([]);
});
