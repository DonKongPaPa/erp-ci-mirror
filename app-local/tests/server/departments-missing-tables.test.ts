import { createDatabaseTest } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

import { DatabaseDepartmentService } from '../../server/providers/departments.js';

/**
 * R-012：表不存在是部署问题（迁移没跑），与「表是空的」不同 —— 空表返回空、不抛错
 * 由 departments.test.ts 的验收9 钉着，这里钉另一半：服务抛错，不悄悄返回空。
 * 悄悄返回空会把一个部署问题伪装成「谁都没有权限」。
 *
 * 这里不跑任何迁移，库里的 departments / departmentMembers 都不存在。
 */
const test = createDatabaseTest({ migrations: [] });

describe('R-012 部门内部服务：表不存在时抛错', () => {
  test('八个读方法在表不存在时都抛错，错误点名那张表', async ({
    connection,
    database,
  }) => {
    // 先证明前提：两张表确实不在，否则下面每一条「抛错」都是在别的东西上抛的。
    for (const tableName of ['departments', 'department_members']) {
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName,
      });
      expect(physical, `${tableName} 不该存在`).toBeUndefined();
    }

    const service = new DatabaseDepartmentService(database);
    const calls: readonly [string, () => Promise<unknown>][] = [
      ['subtreeIds', () => service.subtreeIds('any')],
      ['departmentIdsOfUser', () => service.departmentIdsOfUser('anybody')],
      ['memberIdsOf', () => service.memberIdsOf('any')],
      ['managerOf', () => service.managerOf('any')],
      [
        'primaryDepartmentOf',
        () => service.primaryDepartmentOf('anybody'),
      ],
      ['titlesByIds', () => service.titlesByIds(['any'])],
      ['byCode', () => service.byCode('ANY')],
      ['resolveSuccessor', () => service.resolveSuccessor('any')],
    ];
    for (const [method, call] of calls) {
      // 逐个接住：哪个方法悄悄返回了值，断言信息里要点名它。
      const outcome = await call().then(
        (value) => ({ settled: 'returned' as const, value }),
        (error: unknown) => ({ settled: 'rejected' as const, error }),
      );
      expect(outcome.settled, `${method} 在表不存在时不该有返回值`).toBe(
        'rejected',
      );
      // 错误要点名那张不存在的表：笼统的失败分不清「迁移没跑」和别的毛病。
      expect(
        (outcome as { error: Error }).error.message,
        `${method} 的错误要点名不存在的表`,
      ).toMatch(/^Collection "(departments|departmentMembers)" does not exist\.$/);
    }
  });
});
