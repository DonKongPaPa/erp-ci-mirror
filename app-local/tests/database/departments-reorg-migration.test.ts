import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-012 验收18：第二条迁移钉住字段的类型、长度与默认值。
 *
 * SQLite 不强制长度与默认值，所以这里除了走 `toHaveField` 的比较，还要读物理列定义，
 * 逐个比对这些定义 —— 否则迁移里把 `length: 64` 改成 128、或把 `defaultTo('department')`
 * 删掉，测试都不会红。
 *
 * 「一个用户至多一行主部门」的那道部分唯一索引不在 Collection 元数据里（原生 SQL 建的），
 * 靠插入两行断言它被拒，不靠索引清单的断言。
 */
describe('R-012 验收18：第二条迁移的字段类型、长度与默认值', () => {
  describeMigration('202611240002_department_reorg', {
    sources: [
      {
        packageName: 'department-reorg-migration-test',
        directory: path.resolve(
          import.meta.dirname,
          '../../database/main/migrations',
        ),
      },
    ],
    up: async ({ connection, expectCollection }) => {
      const departments = await expectCollection('departments').toExist();
      expect(departments.primaryKey).toEqual(['id']);
      expect(Object.keys(departments.fields).sort()).toEqual([
        'active',
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
      // enum 是定长 255 的字符串列，不是原生枚举类型：类型、可空性与长度一起钉，
      // 标签清单在下面的 Collection 元数据里。
      await expectCollection('departments').toHaveField('kind', {
        type: 'enum',
        nullable: false,
        length: 255,
      });
      await expectCollection('departments').toHaveField('code', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('departments').toHaveField('successorId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('departments').toHaveField('succeededAt', {
        type: 'datetime',
        nullable: true,
      });
      await expectCollection('departments').toHaveIndex(['code']);

      const history = await expectCollection('departmentMemberHistory').toExist();
      expect(history.primaryKey).toEqual(['id']);
      expect(Object.keys(history.fields).sort()).toEqual([
        'actorId',
        'batchId',
        'createdAt',
        'fromDepartmentId',
        'id',
        'isPrimary',
        'toDepartmentId',
        'userId',
      ]);
      for (const field of ['id', 'userId', 'isPrimary', 'batchId', 'actorId', 'createdAt']) {
        await expectCollection('departmentMemberHistory').toHaveField(field, {
          nullable: false,
        });
      }
      for (const field of ['fromDepartmentId', 'toDepartmentId']) {
        await expectCollection('departmentMemberHistory').toHaveField(field, {
          type: 'string',
          length: 64,
          nullable: true,
        });
      }
      await expectCollection('departmentMemberHistory').toHaveIndex(['userId']);
      await expectCollection('departmentMemberHistory').toHaveIndex(['batchId']);

      // 默认值不在 Collection 快照里：读物理列定义。
      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'departments',
      });
      expect(physical, 'departments 表不在').toBeDefined();
      const column = (name: string) =>
        physical?.columns.find((entry) => entry.columnName === name);
      expect(column('kind')?.default?.value, 'kind 的默认值应当是 department').toBe(
        'department',
      );
      // enum 在 Postgres 上不是原生枚举类型，是定长的字符串列：钉住物理长度。
      expect(column('kind')?.length, 'kind 的物理长度应当是 255').toBe(255);
      expect(column('code')?.default?.value, 'code 的默认值应当是空串').toBe('');
      // 标签清单只在 Collection 元数据里（物理列是不带枚举的字符串列）：顺序也钉住。
      const definition = await connection.collections.get('departments');
      expect(
        definition?.fields.find((field) => field.name === 'kind')?.values,
      ).toEqual(['company', 'center', 'department', 'team']);
      expect(column('successor_id')?.nullable).toBe(true);
      expect(column('succeeded_at')?.nullable).toBe(true);

      const physicalHistory =
        await connection.schemaInspector.getPhysicalCollection({
          tableName: 'department_member_history',
        });
      const isPrimary = physicalHistory?.columns.find(
        (entry) => entry.columnName === 'is_primary',
      );
      // SQLite 把 boolean 的默认值报成字符串 '0'，Postgres 报成 false / 'false'。
      expect(
        ['0', 'false', false, 0].includes(isPrimary?.default?.value as never),
        `isPrimary 的默认值应当是 false，实际是 ${String(isPrimary?.default?.value)}`,
      ).toBe(true);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('departmentMemberHistory').not.toExist();
      for (const field of ['kind', 'code', 'successorId', 'succeededAt']) {
        await expectCollection('departments').not.toHaveField(field);
      }
    },
  });
});

// 部分唯一索引的行为由 describeMigration 之外的一条测试钉住：down 之后它会消失，
// 所以放在 up 断言里重复插入也可以，但这里单独一条更容易看清它在挡什么。
describe('R-012 验收16：一个用户至多一行主部门由数据库裁决', () => {
  describeMigration('202611240002_department_reorg', {
    sources: [
      {
        packageName: 'department-primary-index-test',
        directory: path.resolve(
          import.meta.dirname,
          '../../database/main/migrations',
        ),
      },
    ],
    up: async ({ connection }) => {
      const now = new Date();
      // 这个回调会在回滚后的第二次 up 再跑一遍；部门行不会被回滚删掉（只有列与
      // 变动记录表被回滚），所以每次都用新的标识，避免主键相撞。
      const suffix = randomUUID().slice(0, 8);
      const first = `department-a-${suffix}`;
      const second = `department-b-${suffix}`;
      const userId = `user-${suffix}`;
      // 两个部门，同一个用户：只有部分唯一索引能拒绝第二行主部门。
      for (const id of [first, second]) {
        await connection.query
          .insertInto('departments')
          .values({
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
          })
          .execute();
      }
      const membership = {
        userId,
        isPrimary: false,
        createdAt: now,
      };
      await connection.query
        .insertInto('departmentMembers')
        .values({
          id: `member-a-${suffix}`,
          departmentId: first,
          ...membership,
        })
        .execute();
      // 同一用户的兼职行可以有多行。
      await connection.query
        .insertInto('departmentMembers')
        .values({
          id: `member-b-${suffix}`,
          departmentId: second,
          ...membership,
        })
        .execute();

      await connection.query
        .updateTable('departmentMembers')
        .set({ isPrimary: true })
        .where('id', '=', `member-a-${suffix}`)
        .execute();
      await expect(
        connection.query
          .updateTable('departmentMembers')
          .set({ isPrimary: true })
          .where('id', '=', `member-b-${suffix}`)
          .execute(),
      ).rejects.toThrow();
    },
  });
});
