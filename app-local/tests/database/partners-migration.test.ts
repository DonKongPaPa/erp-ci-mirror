import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-014 MVP：往来单位主档与联系人由迁移 202611260009 两张表建出。
 *
 * 字段类型逐项钉在物理结构上；code 全表唯一、status 默认 active、时间带时区
 * 都从真库读回验证。编码前缀 CU/SU 由服务端发号器生成，不进数据库默认值。
 */
const sources = [
  {
    packageName: 'partners-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const PARTNER_FIELDS = [
  'address',
  'code',
  'contactName',
  'createdAt',
  'createdById',
  'email',
  'id',
  'isCustomer',
  'isSupplier',
  'name',
  'note',
  'phone',
  'status',
  'taxId',
  'updatedAt',
];

const CONTACT_FIELDS = [
  'email',
  'id',
  'isPrimary',
  'name',
  'partnerId',
  'phone',
  'title',
];

describe('R-014 MVP：往来单位的迁移', () => {
  describeMigration('202611260009_create_partners', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const partners = await expectCollection('partners').toExist();
      expect(partners.primaryKey).toEqual(['id']);
      expect(Object.keys(partners.fields).sort()).toEqual(PARTNER_FIELDS);
      await expectCollection('partners').toHaveField('code', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('partners').toHaveField('name', {
        type: 'string',
        length: 128,
        nullable: false,
      });
      for (const field of ['isCustomer', 'isSupplier'] as const) {
        await expectCollection('partners').toHaveField(field, {
          type: 'boolean',
          nullable: false,
        });
      }
      await expectCollection('partners').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      for (const field of [
        'contactName',
        'phone',
        'email',
        'address',
        'taxId',
        'note',
        'createdById',
      ] as const) {
        await expectCollection('partners').toHaveField(field, {
          type: 'string',
          nullable: true,
        });
      }
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('partners').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('partners').toHaveIndex(['status', 'code']);
      await expectCollection('partners').toHaveIndex(['name']);
      expect(partners.indexes).toHaveLength(3);
      expect(partners.foreignKeys).toHaveLength(0);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'partners',
      });
      expect(
        [...(physical?.indexes.map((index) => index.name) ?? [])].sort(),
      ).toEqual(
        [
          'pk_partners',
          'uq_partners_code',
          'ix_partners_status_code',
          'ix_partners_name',
        ].sort(),
      );

      const contacts = await expectCollection('partnerContacts').toExist();
      expect(contacts.primaryKey).toEqual(['id']);
      expect(Object.keys(contacts.fields).sort()).toEqual(CONTACT_FIELDS);
      await expectCollection('partnerContacts').toHaveField('partnerId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('partnerContacts').toHaveField('name', {
        type: 'string',
        length: 128,
        nullable: false,
      });
      await expectCollection('partnerContacts').toHaveField('isPrimary', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('partnerContacts').toHaveIndex(['partnerId']);
      expect(contacts.foreignKeys).toHaveLength(0);

      // 这一条迁移只加这两张表：相对基线（截至 202611260008）没有别的新表。
      const BASELINE_TABLES = [
        'approval_records',
        'approval_rounds',
        'approvals',
        'code_sequences',
        'department_member_history',
        'department_members',
        'departments',
        'device_code',
        'employee_changes',
        'employees',
        'fqc_feedback_files',
        'fqc_feedback_reminders',
        'fqc_messages',
        'fqc_routing_rules',
        'fqc_screening_reviews',
        'fqc_screenings',
        'fqc_tickets',
        'job_grades',
        'lifecycle_effect_runs',
        'lifecycle_transitions',
        'mutation_receipts',
        'partner_contacts',
        'partners',
        'positions',
        'shifts',
      ];
      const tables: string[] = [];
      for await (const collection of connection.schemaInspector.scanPhysicalCollections({
        kinds: ['table'],
      })) {
        if (!collection.tableName.startsWith('__nocobase_')) {
          tables.push(collection.tableName);
        }
      }
      expect(tables.sort()).toEqual([...BASELINE_TABLES].sort());

      // 默认值、空表、唯一约束从真库读回。
      expect(
        await connection.repository<Record<string, unknown>>('partners').count(),
      ).toBe(0);
      await connection.query
        .insertInto('partners')
        .values({
          id: 'p1',
          code: 'CU000001',
          name: '客户甲',
          isCustomer: true,
          isSupplier: false,
          createdById: 'u1',
          createdAt: '2026-11-27T01:00:00.000Z',
          updatedAt: '2026-11-27T01:00:00.000Z',
        })
        .execute();
      const row = await connection.query
        .selectFrom('partners')
        .selectAll()
        .where('id', '=', 'p1')
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('active');
      expect(row.isCustomer).toBe(true);
      expect(row.isSupplier).toBe(false);
      expect(row.contactName).toBeNull();
      expect(row.createdById).toBe('u1');

      await expect(
        connection.query
          .insertInto('partners')
          .values({
            id: 'p2',
            code: 'CU000001',
            name: '重名编码',
            isCustomer: true,
            isSupplier: false,
            createdAt: '2026-11-27T02:00:00.000Z',
            updatedAt: '2026-11-27T02:00:00.000Z',
          })
          .execute(),
      ).rejects.toThrow();
      expect(
        await connection.repository<Record<string, unknown>>('partners').count(),
      ).toBe(1);

      await connection.query
        .insertInto('partner_contacts')
        .values({
          id: 'c1',
          partnerId: 'p1',
          name: '张三',
        })
        .execute();
      const contact = await connection.query
        .selectFrom('partner_contacts')
        .selectAll()
        .where('id', '=', 'c1')
        .executeTakeFirstOrThrow();
      expect(contact.isPrimary).toBe(false);
      expect(contact.title).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('partnerContacts').not.toExist();
      await expectCollection('partners').not.toExist();
    },
  });
});

/** R-014 加片：7 个新列 + 4 个索引 + 新表 partnerAddresses 逐项钉住。 */
const EXT_PARTNER_FIELDS = [
  ...PARTNER_FIELDS,
  'buyerUserId',
  'customerGroupCode',
  'payeeAccountNo',
  'payeeBankCode',
  'payeeBankName',
  'salespersonUserId',
  'supplierGroupCode',
].sort();

const ADDRESS_FIELDS = [
  'address',
  'createdAt',
  'id',
  'isDefault',
  'partnerId',
  'status',
  'updatedAt',
];

const EXT_STRING_FIELDS = [
  ['customerGroupCode', 32],
  ['supplierGroupCode', 32],
  ['salespersonUserId', 64],
  ['buyerUserId', 64],
  ['payeeAccountNo', 64],
  ['payeeBankName', 128],
  ['payeeBankCode', 32],
] as const;

const EXT_INDEX_FIELDS = [
  'customerGroupCode',
  'supplierGroupCode',
  'salespersonUserId',
  'buyerUserId',
] as const;

describe('R-014 加片：往来单位补字段的迁移', () => {
  describeMigration('202611260017_partners_ext', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const partners = await expectCollection('partners').toExist();
      expect(Object.keys(partners.fields).sort()).toEqual(EXT_PARTNER_FIELDS);
      for (const [field, length] of EXT_STRING_FIELDS) {
        await expectCollection('partners').toHaveField(field, {
          type: 'string',
          length,
          nullable: true,
        });
      }
      for (const field of EXT_INDEX_FIELDS) {
        await expectCollection('partners').toHaveIndex([field]);
      }
      expect(partners.indexes).toHaveLength(7);

      const physical = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'partners',
      });
      expect([...(physical?.indexes.map((index) => index.name) ?? [])].sort()).toEqual(
        [
          'pk_partners',
          'uq_partners_code',
          'ix_partners_status_code',
          'ix_partners_name',
          'ix_partners_customer_group',
          'ix_partners_supplier_group',
          'ix_partners_salesperson',
          'ix_partners_buyer',
        ].sort(),
      );

      const addresses = await expectCollection('partnerAddresses').toExist();
      expect(addresses.primaryKey).toEqual(['id']);
      expect(Object.keys(addresses.fields).sort()).toEqual(ADDRESS_FIELDS);
      await expectCollection('partnerAddresses').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('partnerAddresses').toHaveField('partnerId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('partnerAddresses').toHaveField('address', {
        type: 'string',
        length: 512,
        nullable: false,
      });
      await expectCollection('partnerAddresses').toHaveField('isDefault', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('partnerAddresses').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      for (const field of ['createdAt', 'updatedAt'] as const) {
        await expectCollection('partnerAddresses').toHaveField(field, {
          type: 'datetimeTz',
          nullable: false,
        });
      }
      await expectCollection('partnerAddresses').toHaveIndex(['partnerId', 'status']);
      expect(addresses.foreignKeys).toHaveLength(0);
      const physicalAddresses = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'partner_addresses',
      });
      expect(
        [...(physicalAddresses?.indexes.map((index) => index.name) ?? [])].sort(),
      ).toEqual(['pk_partner_addresses', 'ix_partner_addresses_partner'].sort());

      // 默认值与存量空列从真库读回；up 会在 down 前后各跑一次，标识现取。
      const now = '2026-11-27T03:00:00.000Z';
      const partnerId = randomUUID();
      await connection.query
        .insertInto('partners')
        .values({
          id: partnerId,
          code: `CU${randomUUID().replaceAll('-', '').slice(0, 10)}`,
          name: '测试客户',
          isCustomer: true,
          isSupplier: false,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      const partner = await connection.query
        .selectFrom('partners')
        .selectAll()
        .where('id', '=', partnerId)
        .executeTakeFirstOrThrow();
      for (const [field] of EXT_STRING_FIELDS) {
        expect(partner[field], `${field} 存量行应为空`).toBeNull();
      }

      const addressId = randomUUID();
      await connection.query
        .insertInto('partner_addresses')
        .values({
          id: addressId,
          partnerId,
          address: '测试地址',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      const address = await connection.query
        .selectFrom('partner_addresses')
        .selectAll()
        .where('id', '=', addressId)
        .executeTakeFirstOrThrow();
      expect(address.isDefault).toBe(false);
      expect(address.status).toBe('active');
    },
    down: async ({ expectCollection }) => {
      const partners = await expectCollection('partners').toExist();
      expect(Object.keys(partners.fields).sort()).toEqual(PARTNER_FIELDS);
      for (const [field] of EXT_STRING_FIELDS) {
        await expectCollection('partners').not.toHaveField(field);
      }
      for (const field of EXT_INDEX_FIELDS) {
        await expectCollection('partners').not.toHaveIndex([field]);
      }
      await expectCollection('partnerAddresses').not.toExist();
    },
  });
});
