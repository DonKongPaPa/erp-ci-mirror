import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-023 W3-1 轻 MES 基础设置：七张新表。
 *
 * 只建自己的表，不碰别的模块；不建外键、不建数据库 CHECK，规则在服务端。
 * 时间戳带时区、精确到秒；数量 decimal(18,4)、单价 decimal(18,2)。
 * 工序的六个开关/限制列建成可空同名列，原样读写，语义补查前不进任何流转规则。
 * 工价只留 unitPrice 字段，不计算工资。
 * 迁移只管表结构；reportRules 的四行默认值由新种子 202611280032 写入。
 */

const migration: MigrationDefinition = defineMigration({
  name: '202611260035_mes_basics',
  async up({ builder }) {
    await builder.createCollection('workCenters', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('managerUserId', { length: 64 }).nullable();
      collection.integer('workerCount').nullable();
      collection.boolean('active').notNull().defaultTo(true);
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_work_centers' });
      collection.unique(['code'], { name: 'uq_work_centers_code' });
      collection.index(['active', 'code'], { name: 'ix_work_centers_active' });
    });

    await builder.createCollection('operations', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('defaultWorkCenterId', { length: 64 }).nullable();
      collection.integer('sortOrder').notNull().defaultTo(0);
      collection.decimal('unitHourlyCapacity', { precision: 18, scale: 4 }).nullable();
      // 六个现行列语义未查到：可空、原样读写，不进规则。
      collection.boolean('equipmentRequired').nullable();
      collection.boolean('handoverConfirm').nullable();
      collection.boolean('inspectionFree').nullable();
      collection.boolean('autoComplete').nullable();
      collection.string('currentReportLimit', { length: 64 }).nullable();
      collection.string('previousReportLimit', { length: 64 }).nullable();
      collection.string('displayStatus', { length: 32 }).notNull().defaultTo('active');
      collection.boolean('active').notNull().defaultTo(true);
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_operations' });
      collection.unique(['code'], { name: 'uq_operations_code' });
      collection.index(['active', 'sortOrder', 'code'], { name: 'ix_operations_active_sort' });
    });

    await builder.createCollection('processRoutes', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('docNo', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.string('productId', { length: 64 }).notNull();
      collection.boolean('active').notNull().defaultTo(true);
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_process_routes' });
      collection.unique(['docNo'], { name: 'uq_process_routes_doc_no' });
      collection.index(['productId'], { name: 'ix_process_routes_product' });
    });

    await builder.createCollection('processRouteSteps', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('routeId', { length: 64 }).notNull();
      collection.string('operationId', { length: 64 }).notNull();
      collection.integer('stepNo').notNull();
      collection.string('note', { length: 500 }).nullable();
      collection.primary('id', { name: 'pk_process_route_steps' });
      collection.unique(['routeId', 'operationId'], { name: 'uq_route_steps' });
      collection.index(['routeId', 'stepNo'], { name: 'ix_route_steps_route' });
    });

    await builder.createCollection('defectItems', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('name', { length: 128 }).notNull();
      collection.boolean('active').notNull().defaultTo(true);
      collection.datetimeTz('createdAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_defect_items' });
      collection.unique(['code'], { name: 'uq_defect_items_code' });
    });

    await builder.createCollection('reportRules', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('code', { length: 64 }).notNull();
      collection.string('value', { length: 128 }).notNull();
      collection.string('updatedById', { length: 64 }).nullable();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_report_rules' });
      collection.unique(['code'], { name: 'uq_report_rules_code' });
    });

    await builder.createCollection('operationPrices', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('itemId', { length: 64 }).notNull();
      collection.string('operationId', { length: 64 }).notNull();
      collection.decimal('unitPrice', { precision: 18, scale: 2 }).nullable();
      collection.string('note', { length: 500 }).nullable();
      collection.string('updatedById', { length: 64 }).nullable();
      collection.datetimeTz('updatedAt', { precision: 0 }).notNull();
      collection.primary('id', { name: 'pk_operation_prices' });
      collection.unique(['itemId', 'operationId'], { name: 'uq_operation_prices' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('operationPrices');
    await builder.dropCollection('reportRules');
    await builder.dropCollection('defectItems');
    await builder.dropCollection('processRouteSteps');
    await builder.dropCollection('processRoutes');
    await builder.dropCollection('operations');
    await builder.dropCollection('workCenters');
  },
});

export default migration;
