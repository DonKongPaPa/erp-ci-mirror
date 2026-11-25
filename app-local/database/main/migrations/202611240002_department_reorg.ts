import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-012 部门管理第二部分：改组的字段与成员变动记录。
 *
 * 在 202611240001 的两张表上补四列，新增成员变动记录表，并补一道带条件的唯一索引：
 *
 * - departments 加类型、编码、继任者、并过去的时间。已有的行没有这三样，所以
 *   `kind` 与 `code` 带默认值：`kind` 默认 `department`，`code` 默认空串。
 *   编码的唯一（还没有继任者的部门之间）由服务层校验，不建唯一约束。
 * - departmentMemberHistory 只追加。`userId`、`batchId` 各建索引，不加外键。
 * - `departmentMembers` 上「每个用户至多一行主部门」由一句原生 SQL 建的部分唯一索引
 *   裁决。框架的 `unique()` 会把谓词编译成绑定参数（SQLite 拒绝，见第一条迁移的注释），
 *   构建器加不上；`WHERE is_primary` 这种裸列引用在 SQLite 与 Postgres 上语义一致。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611240002_department_reorg',
  async up({ builder, connection }) {
    await builder.alterCollection('departments', (collection) => {
      collection
        .enum('kind', { values: ['company', 'center', 'department', 'team'] })
        .notNull()
        .defaultTo('department');
      collection.string('code', { length: 64 }).notNull().defaultTo('');
      collection.string('successorId', { length: 64 }).nullable();
      collection.datetime('succeededAt').nullable();
      collection.index('code', { name: 'ix_departments_code' });
    });

    await builder.createCollection('departmentMemberHistory', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.string('fromDepartmentId', { length: 64 }).nullable();
      collection.string('toDepartmentId', { length: 64 }).nullable();
      collection.boolean('isPrimary').notNull().defaultTo(false);
      collection.string('batchId', { length: 64 }).notNull();
      collection.string('actorId', { length: 64 }).notNull();
      collection.datetime('createdAt').notNull();
      collection.primary('id', { name: 'pk_department_member_history' });
      collection.index('userId', { name: 'ix_department_member_history_user' });
      collection.index('batchId', { name: 'ix_department_member_history_batch' });
    });

    // 一个用户至多一行主部门。物理名是 snake_case（DefaultNamingStrategy 默认 underscored）。
    const knex = await connection.client<{
      raw(sql: string, bindings?: unknown[]): Promise<unknown>;
    }>();
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_department_members_primary_user ' +
        'ON department_members (user_id) WHERE is_primary',
    );
  },
  async down({ builder, connection }) {
    const knex = await connection.client<{
      raw(sql: string, bindings?: unknown[]): Promise<unknown>;
    }>();
    await knex.raw('DROP INDEX IF EXISTS uq_department_members_primary_user');

    await builder.dropCollection('departmentMemberHistory');
    await builder.alterCollection('departments', (collection) => {
      collection.dropField('kind');
      collection.dropField('code');
      collection.dropField('successorId');
      collection.dropField('succeededAt');
    });
  },
});

export default migration;
