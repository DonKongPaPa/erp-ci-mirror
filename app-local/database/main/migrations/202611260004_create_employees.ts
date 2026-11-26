import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-011 第一片：员工档案、变动记录、岗位字典与职级字典。
 *
 * 一条新迁移，不改已经执行过的八条。四张表都不加外键：框架对以 userId 为键的
 * 表只让建唯一约束或索引，关联由服务层按标识读（同部门表的做法）。
 *
 * - employees        档案。自有主键，userId 非空且唯一（第一版一个员工一个账号），
 *                    employeeNo 非空且唯一，reportsToUserId 建普通索引。
 * - employeeChanges  只追加的变动记录，按 userId 建索引，没有更新和删除接口。
 * - positions        岗位字典，id 就是编码；只停用不删除。
 * - jobGrades        职级字典，id 是 string(32)，比岗位多一列 rank；只停用不删除。
 *
 * 姓名、用户名、邮箱、账号是否停用都不进档案表：它们是账号的事实，显示时现取
 * （AGENTS.md 第 13 条，人员信息只做选择性暴露）。
 *
 * hiredOn / leftOn / occurredOn 是只到日的日期。构建器有 date 类型（@nocobase/db
 * 的 FieldType 与 fluent.date()，编译成 SQL DATE），不用 datetime 补零时分秒。
 * status 默认 active、字典的 active 默认真；sortOrder 与 rank 沿用部门表的
 * notNull + defaultTo(0)（设计只写了类型，没有写默认值，按相邻建法取）。
 *
 * down 按相反顺序显式删四张表：表没了，唯一约束与索引也一起没了，不留痕迹。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260004_create_employees',
  async up({ builder }) {
    await builder.createCollection('employees', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.string('employeeNo', { length: 16 }).notNull();
      collection.string('positionId', { length: 64 }).nullable();
      collection.string('gradeId', { length: 32 }).nullable();
      collection.string('reportsToUserId', { length: 64 }).nullable();
      collection.date('hiredOn').notNull();
      collection.date('leftOn').nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_employees' });
      collection.unique('userId', { name: 'uq_employees_user' });
      collection.unique('employeeNo', { name: 'uq_employees_no' });
      collection.index('reportsToUserId', { name: 'ix_employees_reports_to' });
    });

    await builder.createCollection('employeeChanges', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.string('kind', { length: 32 }).notNull();
      collection.string('fromValue', { length: 128 }).nullable();
      collection.string('toValue', { length: 128 }).nullable();
      collection.date('occurredOn').notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.string('actorId', { length: 64 }).notNull();
      collection.datetime('createdAt').notNull();
      collection.primary('id', { name: 'pk_employee_changes' });
      collection.index('userId', { name: 'ix_employee_changes_user' });
    });

    await builder.createCollection('positions', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('title', { length: 128 }).notNull();
      collection.boolean('active').notNull().defaultTo(true);
      collection.integer('sortOrder').notNull().defaultTo(0);
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_positions' });
    });

    await builder.createCollection('jobGrades', (collection) => {
      collection.string('id', { length: 32 }).notNull();
      collection.string('title', { length: 128 }).notNull();
      collection.integer('rank').notNull().defaultTo(0);
      collection.boolean('active').notNull().defaultTo(true);
      collection.datetime('createdAt').notNull();
      collection.datetime('updatedAt').notNull();
      collection.primary('id', { name: 'pk_job_grades' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('jobGrades');
    await builder.dropCollection('positions');
    await builder.dropCollection('employeeChanges');
    await builder.dropCollection('employees');
  },
});

export default migration;
