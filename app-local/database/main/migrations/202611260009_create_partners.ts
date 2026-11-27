import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-014 MVP：往来单位主档与联系人，排在未合并的 202611260008_create_code_sequences 之后。
 *
 * 客户与供应商一张表，用 isCustomer / isSupplier 区分；两者都是时由服务层按客户口径发 CU 号。
 * code 全表唯一（发号器在事务里领号），status 默认在用，时间列带时区（R-017 / R-025 的 datetimeTz）。
 * 联系人以 partnerId 归属，不加外键；服务层校验所属单位存在且在用。
 * 索引 (status, code) 供默认列表、(name) 供搜索；code 另有唯一约束。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260009_create_partners',
  async up({ builder }) {
    await builder.createCollection('partners', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 32 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.boolean('isCustomer').notNull();
      collection.boolean('isSupplier').notNull();
      collection.string('status', { length: 16 }).notNull().defaultTo('active');
      collection.string('contactName', { length: 128 }).nullable();
      collection.string('phone', { length: 64 }).nullable();
      collection.string('email', { length: 254 }).nullable();
      collection.string('address', { length: 512 }).nullable();
      collection.string('taxId', { length: 64 }).nullable();
      collection.string('note', { length: 2000 }).nullable();
      collection.string('createdById', { length: 64 }).nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('id', { name: 'pk_partners' });
      collection.unique('code', { name: 'uq_partners_code' });
      collection.index(['status', 'code'], { name: 'ix_partners_status_code' });
      collection.index('name', { name: 'ix_partners_name' });
    });

    await builder.createCollection('partnerContacts', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('partnerId', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('title', { length: 128 }).nullable();
      collection.string('phone', { length: 64 }).nullable();
      collection.string('email', { length: 254 }).nullable();
      collection.boolean('isPrimary').notNull().defaultTo(false);
      collection.primary('id', { name: 'pk_partner_contacts' });
      collection.index('partnerId', { name: 'ix_partner_contacts_partner' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('partnerContacts');
    await builder.dropCollection('partners');
  },
});

export default migration;
