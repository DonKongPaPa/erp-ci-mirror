import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-019 复刻波 0 加片：物料档案补字段。
 *
 * 只加可空列、不回填、不改已执行的 202611260010_create_items：
 * - items 补 11 列（11 个新键见 R-019.md「数据模型」），两个基准价列在库里固定存含税价；
 *   legacyCode 是已有列，这里只补普通索引，不补唯一约束（待补查 1/2）。
 * - itemCategories 补 sort（非空默认 0，给类目树顺序用）。
 *
 * 校验（上下限、辅助单位成对、换算率、提前期、类目深度）都在服务层，不建 CHECK；
 * 两个索引都是普通索引。`down` 先删索引再删列，逐项还原到这一条之前。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260016_items_ext',
  async up({ builder }) {
    await builder.alterCollection('items', (collection) => {
      collection.string('englishName', { length: 128 }).nullable();
      collection.decimal('stockMin', { precision: 18, scale: 4 }).nullable();
      collection.decimal('stockMax', { precision: 18, scale: 4 }).nullable();
      collection.decimal('basePurchasePrice', { precision: 18, scale: 4 }).nullable();
      collection.decimal('baseSalesPrice', { precision: 18, scale: 4 }).nullable();
      collection.string('barcode', { length: 64 }).nullable();
      collection.string('brand', { length: 64 }).nullable();
      collection.string('manufacturerModel', { length: 128 }).nullable();
      collection.string('auxUnitCode', { length: 16 }).nullable();
      collection.decimal('unitRatio', { precision: 18, scale: 6 }).nullable();
      collection.integer('purchaseLeadDays').nullable();
      collection.index('barcode', { name: 'ix_items_barcode' });
      collection.index('legacyCode', { name: 'ix_items_legacy_code' });
    });

    await builder.alterCollection('itemCategories', (collection) => {
      collection.integer('sort').notNull().defaultTo(0);
    });
  },
  async down({ builder }) {
    await builder.alterCollection('itemCategories', (collection) => {
      collection.dropField('sort');
    });
    // 索引先单独删：与 dropField 放在同一次 alter 里时，编译器会先删列，
    // 而 Postgres 删列会连带删掉它上面的索引，随后显式 dropIndex 反而报不存在。
    await builder.alterCollection('items', (collection) => {
      collection.dropIndex('ix_items_barcode');
      collection.dropIndex('ix_items_legacy_code');
    });
    await builder.alterCollection('items', (collection) => {
      collection.dropField('englishName');
      collection.dropField('stockMin');
      collection.dropField('stockMax');
      collection.dropField('basePurchasePrice');
      collection.dropField('baseSalesPrice');
      collection.dropField('barcode');
      collection.dropField('brand');
      collection.dropField('manufacturerModel');
      collection.dropField('auxUnitCode');
      collection.dropField('unitRatio');
      collection.dropField('purchaseLeadDays');
    });
  },
});

export default migration;
