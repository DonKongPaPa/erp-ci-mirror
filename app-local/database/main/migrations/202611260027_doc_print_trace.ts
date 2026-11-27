import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-076：单据打印痕迹。只给 stockDocs 加三列，全部可空或有默认 0，不回填历史单据；
 * 不改已执行的 202611260011_create_inventory.ts 与 202611260019_stock_docs_ext.ts。
 *
 * `down` 把三列删干净。打印次数是 integer，不是 decimal；时间列带时区（datetimeTz）。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260027_doc_print_trace',
  async up({ builder }) {
    await builder.alterCollection('stockDocs', (collection) => {
      collection.integer('printCount').notNull().defaultTo(0);
      collection.datetimeTz('lastPrintedAt').nullable();
      collection.string('lastPrintedBy', { length: 64 }).nullable();
    });
  },
  async down({ builder }) {
    await builder.alterCollection('stockDocs', (collection) => {
      collection.dropField('printCount');
      collection.dropField('lastPrintedAt');
      collection.dropField('lastPrintedBy');
    });
  },
});

export default migration;
