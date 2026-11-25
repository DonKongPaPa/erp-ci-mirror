import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

/**
 * R-012 部门管理：一条迁移建部门树与部门成员两张表。
 *
 * 断言的是物理结构，不是迁移声明的返回值：字段、可空性、索引与唯一约束都要在
 * 空库上真的建出来。部门表不加外键，成员关系由服务层校验；这里只验证
 * (departmentId, userId) 唯一。主部门唯一由服务层保证 —— 设计允许的带条件唯一
 * 索引被框架的 predicate 编译方式挡住（见迁移注释），数据库层没有这一道。
 */
describeMigration('202611240001_create_departments', {
  sources: [
    {
      packageName: 'departments-migration-test',
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
      'createdAt',
      'id',
      'managerId',
      'parentId',
      'sortOrder',
      'title',
      'updatedAt',
    ]);
    for (const field of [
      'id',
      'title',
      'active',
      'sortOrder',
      'createdAt',
      'updatedAt',
    ]) {
      await expectCollection('departments').toHaveField(field, {
        nullable: false,
      });
    }
    for (const field of ['parentId', 'managerId']) {
      await expectCollection('departments').toHaveField(field, {
        nullable: true,
      });
    }
    await expectCollection('departments').toHaveIndex(['parentId']);
    await expectCollection('departments').toHaveIndex(['managerId']);

    const members = await expectCollection('departmentMembers').toExist();
    expect(members.primaryKey).toEqual(['id']);
    expect(Object.keys(members.fields).sort()).toEqual([
      'createdAt',
      'departmentId',
      'id',
      'isPrimary',
      'userId',
    ]);
    for (const field of [
      'id',
      'departmentId',
      'userId',
      'isPrimary',
      'createdAt',
    ]) {
      await expectCollection('departmentMembers').toHaveField(field, {
        nullable: false,
      });
    }
    await expectCollection('departmentMembers').toHaveIndex(
      ['departmentId', 'userId'],
      { unique: true },
    );
    await expectCollection('departmentMembers').toHaveIndex(['userId']);

    const now = new Date();
    const department = {
      title: '质量部',
      parentId: null,
      managerId: null,
      active: true,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    await connection.query
      .insertInto('departments')
      .values({ id: 'department-1', ...department })
      .execute();
    // 主键重复要被拒。
    await expect(
      connection.query
        .insertInto('departments')
        .values({ id: 'department-1', ...department, title: '另一个部门' })
        .execute(),
    ).rejects.toThrow();
    // 不同上级下同名可以：部门表不建名称唯一约束，重名由服务层校验。
    await connection.query
      .insertInto('departments')
      .values({ id: 'department-2', ...department, parentId: 'department-1' })
      .execute();

    const membership = {
      userId: 'user-1',
      isPrimary: false,
      createdAt: now,
    };
    await connection.query
      .insertInto('departmentMembers')
      .values({ id: 'member-1', departmentId: 'department-1', ...membership })
      .execute();
    // (departmentId, userId) 重复要被拒。
    await expect(
      connection.query
        .insertInto('departmentMembers')
        .values({ id: 'member-2', departmentId: 'department-1', ...membership })
        .execute(),
    ).rejects.toThrow();
    // 兼职部门：同一用户可以出现在多个部门。
    await connection.query
      .insertInto('departmentMembers')
      .values({ id: 'member-2', departmentId: 'department-2', ...membership })
      .execute();
  },
  down: async ({ expectCollection }) => {
    await expectCollection('departmentMembers').not.toExist();
    await expectCollection('departments').not.toExist();
  },
});
