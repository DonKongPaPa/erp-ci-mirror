import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-078 报表中心底座：报表定义、常用报表与导出留痕三张新表。
 *
 * 时间戳带时区、精确到秒；不建外键、不建 CHECK，全部校验在服务层。
 * 定义由种子写入，业务角色没有建改端点；留痕只追加，不提供改与删。
 * `down` 逐项删三表，索引随表删除。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260032_reports',
  async up({ builder }) {
    await builder.createCollection('reportDefinitions', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('key', { length: 64 }).notNull();
      collection.string('titleKey', { length: 128 }).notNull();
      collection.string('category', { length: 16 }).notNull();
      collection.text('dimensions').notNull();
      collection.text('measures').notNull();
      collection.text('columns').notNull();
      collection.text('baseActions').notNull();
      collection.string('source', { length: 64 }).notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_report_definitions' });
      collection.unique(['key'], { name: 'uq_report_definitions_key' });
    });

    await builder.createCollection('reportFavorites', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.string('reportKey', { length: 64 }).notNull();
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_report_favorites' });
      collection.unique(['userId', 'reportKey'], { name: 'uq_report_favorites_user_report' });
    });

    await builder.createCollection('reportExportTraces', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('userId', { length: 64 }).notNull();
      collection.string('reportKey', { length: 64 }).notNull();
      collection.datetimeTz('at', { precision: 0 }).notNull();
      collection.string('format', { length: 8 }).notNull();
      collection.string('filtersHash', { length: 64 }).notNull();
      collection.integer('rowCount').notNull();
      collection.primary('id', { name: 'pk_report_export_traces' });
      collection.index(['userId', 'at'], { name: 'ix_report_export_traces_user_at' });
      collection.index(['reportKey', 'at'], { name: 'ix_report_export_traces_report_at' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('reportExportTraces');
    await builder.dropCollection('reportFavorites');
    await builder.dropCollection('reportDefinitions');
  },
});

export default migration;
