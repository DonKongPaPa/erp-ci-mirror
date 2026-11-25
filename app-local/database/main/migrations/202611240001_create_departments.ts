import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-012 部门管理：部门树与部门成员。
 *
 * 两张表都不加外键：框架对以 userId 为键的表要求只建索引或唯一约束，
 * 部门的上下级与成员关系由服务层校验（server/providers/departments.ts）。
 *
 * - departments       部门树。父指针成树，整棵树载入内存解析
 * - departmentMembers 部门成员。(departmentId, userId) 唯一
 *
 * 一个用户至多一个主部门，由服务层在事务里保证。设计提到「数据库层能加带条件的
 * 唯一索引就加」：核对过，框架的 unique() 把 predicate 编译成绑定参数，SQLite 直接
 * 拒绝（parameters prohibited in partial index WHERE clauses），所以这里没有加。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611240001_create_departments',
  async up({ builder }) {
    await builder.createCollection('departments', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('title', { length: 128 }).notNull();
      collection.string('parentId', { length: 64 }).nullable();
      collection.string('managerId', { length: 64 }).nullable();
      collection.boolean('active').notNull().defaultTo(true);
      collection.integer('sortOrder').notNull().defaultTo(0);
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_departments' });
      collection.index('parentId', { name: 'ix_departments_parent' });
      collection.index('managerId', { name: 'ix_departments_manager' });
    });

    await builder.createCollection('departmentMembers', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('departmentId', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.boolean('isPrimary').notNull().defaultTo(false);
      collection.datetime('createdAt').notNull();
      collection.primary('id', { name: 'pk_department_members' });
      collection.unique(['departmentId', 'userId'], {
        name: 'uq_department_members_department_user',
      });
      collection.index('userId', { name: 'ix_department_members_user' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('departmentMembers');
    await builder.dropCollection('departments');
  },
});

export default migration;
