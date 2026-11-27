import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-014 复刻波 0 加片：往来单位补字段。
 *
 * 只加可空列、不回填、不改已执行的 202611260009_create_partners：
 * - partners 补 7 列（两个分组码、销售员/采购员账号标识、收款三列）与 4 个普通索引；
 *   分组码的字典校验、员工的在职校验与联行号的字符集都在服务层，不建 CHECK。
 * - partnerAddresses 另立一张表，一个单位多条交货地址；默认地址与停用都在服务层维护，
 *   不加外键（同 partner_contacts 的做法）。
 *
 * `down` 先删新表再删列；索引单独一次 alter 先删干净，避免与 dropField 同批时
 * Postgres 删列连带删索引、随后显式 dropIndex 报不存在（照 202611260016_items_ext）。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260017_partners_ext',
  async up({ builder }) {
    await builder.alterCollection('partners', (collection) => {
      collection.string('customerGroupCode', { length: 32 }).nullable();
      collection.string('supplierGroupCode', { length: 32 }).nullable();
      collection.string('salespersonUserId', { length: 64 }).nullable();
      collection.string('buyerUserId', { length: 64 }).nullable();
      collection.string('payeeAccountNo', { length: 64 }).nullable();
      collection.string('payeeBankName', { length: 128 }).nullable();
      collection.string('payeeBankCode', { length: 32 }).nullable();
      collection.index('customerGroupCode', { name: 'ix_partners_customer_group' });
      collection.index('supplierGroupCode', { name: 'ix_partners_supplier_group' });
      collection.index('salespersonUserId', { name: 'ix_partners_salesperson' });
      collection.index('buyerUserId', { name: 'ix_partners_buyer' });
    });

    await builder.createCollection('partnerAddresses', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('partnerId', { length: 64 }).notNull();
      collection.string('address', { length: 512 }).notNull();
      collection.boolean('isDefault').notNull().defaultTo(false);
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_partner_addresses' });
      collection.index(['partnerId', 'status'], { name: 'ix_partner_addresses_partner' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('partnerAddresses');
    await builder.alterCollection('partners', (collection) => {
      collection.dropIndex('ix_partners_customer_group');
      collection.dropIndex('ix_partners_supplier_group');
      collection.dropIndex('ix_partners_salesperson');
      collection.dropIndex('ix_partners_buyer');
    });
    await builder.alterCollection('partners', (collection) => {
      collection.dropField('customerGroupCode');
      collection.dropField('supplierGroupCode');
      collection.dropField('salespersonUserId');
      collection.dropField('buyerUserId');
      collection.dropField('payeeAccountNo');
      collection.dropField('payeeBankName');
      collection.dropField('payeeBankCode');
    });
  },
});

export default migration;
