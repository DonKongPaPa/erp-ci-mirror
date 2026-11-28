import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-019 复刻波 2：BOM 头与配件行两张新表。
 *
 * 只建表、不回填、不给 items 加列；不建外键、不建 CHECK，全部校验在服务层。
 * docNo 由 R-016 发号器在业务事务里发；version 由请求体给，同一 docNo 下唯一。
 * `uq_boms_default` 是部分唯一索引：同一成品只允许一条在用默认 BOM，停用后不再占位。
 * 时间戳带时区、精确到秒。`down` 逐项删两张表（索引随表删掉）。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260031_create_boms',
  async up({ builder, connection }) {
    await builder.createCollection('boms', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 32 }).notNull();
      collection.string('version', { length: 16 }).notNull();
      collection.string('productId', { length: 64 }).notNull();
      collection.boolean('isDefault').notNull().defaultTo(false);
      collection.date('effectiveFrom').notNull();
      collection.date('effectiveTo').nullable();
      collection.decimal('dailyOutput', { precision: 18, scale: 4 }).nullable();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.string('remark', { length: 1000 }).notNull().defaultTo('');
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_boms' });
      collection.unique(['docNo'], { name: 'uq_boms_doc_no' });
      collection.unique(['docNo', 'version'], { name: 'uq_boms_doc_no_version' });
      collection.index(['productId', 'effectiveFrom'], {
        name: 'ix_boms_product_effective',
      });
    });

    // 编译器的 predicate 会把 true / 'active' 变成绑定参数，Postgres 不允许在部分索引
    // 的 WHERE 里用参数（department_reorg 迁移里踩过）。这里用字面量写死条件。
    const knex = await connection.client<{
      raw(sql: string, bindings?: unknown[]): Promise<unknown>;
    }>();
    await knex.raw(
      `create unique index uq_boms_default on ?? (??) where ?? = true and ?? = 'active'`,
      ['boms', 'product_id', 'is_default', 'status'],
    );

    await builder.createCollection('bomLines', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('bomId', { length: 64 }).notNull();
      collection.integer('lineNo').notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.decimal('qty', { precision: 18, scale: 4 }).notNull();
      collection.decimal('lossRate', { precision: 18, scale: 6 })
        .notNull().defaultTo(0);
      collection.string('childBomId', { length: 64 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_bom_lines' });
      collection.index(['bomId'], { name: 'ix_bom_lines_bom' });
    });
  },
  async down({ builder, connection }) {
    const knex = await connection.client<{
      raw(sql: string, bindings?: unknown[]): Promise<unknown>;
    }>();
    await knex.raw('drop index if exists uq_boms_default');
    await builder.dropCollection('bomLines');
    await builder.dropCollection('boms');
  },
});

export default migration;
