// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';
import type { Knex } from 'knex';

/**
 * R-023 W3-1：七张基础设置表的列、主键、唯一约束与索引逐项钉在真 Postgres 的物理结构上。
 * 六个开关/限制列建成可空，没有外键与 CHECK；reportRules 四行默认值逐项读回。
 * down 只删这七张表。
 */
const sources = [
  {
    packageName: 'mes-basics-migration-test',
    directory: path.resolve(import.meta.dirname, '../../database/main/migrations'),
  },
];

const WORK_CENTER_FIELDS = [
  'id', 'code', 'name', 'managerUserId', 'workerCount', 'active',
  'createdById', 'createdAt', 'updatedAt',
].sort();
const OPERATION_FIELDS = [
  'id', 'code', 'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
  'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
  'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
  'createdById', 'createdAt', 'updatedAt',
].sort();
const ROUTE_FIELDS = [
  'id', 'docNo', 'name', 'productId', 'active', 'createdById', 'createdAt', 'updatedAt',
].sort();
const STEP_FIELDS = ['id', 'routeId', 'operationId', 'stepNo', 'note'].sort();
const DEFECT_FIELDS = ['id', 'code', 'name', 'active', 'createdAt'].sort();
const RULE_FIELDS = ['id', 'code', 'value', 'updatedById', 'updatedAt'].sort();
const PRICE_FIELDS = [
  'id', 'itemId', 'operationId', 'unitPrice', 'note', 'updatedById', 'updatedAt',
].sort();

const SIX_SWITCHES = [
  'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
  'currentReportLimit', 'previousReportLimit',
] as const;

describe('R-023 W3-1 基础设置的迁移', () => {
  describeMigration('202611260035_mes_basics', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const workCenters = await expectCollection('workCenters').toExist();
      expect(Object.keys(workCenters.fields).sort(), '工作中心的列').toEqual(WORK_CENTER_FIELDS);
      expect(workCenters.primaryKey).toEqual(['id']);
      expect(workCenters.foreignKeys).toHaveLength(0);
      await expectCollection('workCenters').toHaveIndex(['code'], { unique: true });
      await expectCollection('workCenters').toHaveIndex(['active', 'code']);

      const operations = await expectCollection('operations').toExist();
      expect(Object.keys(operations.fields).sort(), '工序的列').toEqual(OPERATION_FIELDS);
      expect(operations.primaryKey).toEqual(['id']);
      expect(operations.foreignKeys).toHaveLength(0);
      await expectCollection('operations').toHaveIndex(['code'], { unique: true });
      await expectCollection('operations').toHaveIndex(['active', 'sortOrder', 'code']);
      const knex = await connection.client<Knex>();
      const decimalOf = async (table: string, column: string) => {
        const result = await knex.raw<{ rows?: { numeric_precision: number; numeric_scale: number }[] }>(
          `select numeric_precision, numeric_scale from information_schema.columns
            where table_name = ? and column_name = ?`,
          [table, column],
        );
        return {
          precision: Number(result.rows?.[0]?.numeric_precision),
          scale: Number(result.rows?.[0]?.numeric_scale),
        };
      };
      expect(await decimalOf('operations', 'unit_hourly_capacity')).toEqual({
        precision: 18, scale: 4,
      });
      for (const field of SIX_SWITCHES) {
        await expectCollection('operations').toHaveField(field, { nullable: true });
      }

      const routes = await expectCollection('processRoutes').toExist();
      expect(Object.keys(routes.fields).sort(), '工艺流程的列').toEqual(ROUTE_FIELDS);
      expect(routes.primaryKey).toEqual(['id']);
      expect(routes.foreignKeys).toHaveLength(0);
      await expectCollection('processRoutes').toHaveIndex(['docNo'], { unique: true });
      await expectCollection('processRoutes').toHaveIndex(['productId']);

      const steps = await expectCollection('processRouteSteps').toExist();
      expect(Object.keys(steps.fields).sort(), '工序行的列').toEqual(STEP_FIELDS);
      expect(steps.primaryKey).toEqual(['id']);
      expect(steps.foreignKeys).toHaveLength(0);
      await expectCollection('processRouteSteps').toHaveIndex(['routeId', 'operationId'], {
        unique: true,
      });
      await expectCollection('processRouteSteps').toHaveIndex(['routeId', 'stepNo']);

      const defects = await expectCollection('defectItems').toExist();
      expect(Object.keys(defects.fields).sort(), '不良品项的列').toEqual(DEFECT_FIELDS);
      expect(defects.primaryKey).toEqual(['id']);
      expect(defects.foreignKeys).toHaveLength(0);
      await expectCollection('defectItems').toHaveIndex(['code'], { unique: true });

      const rules = await expectCollection('reportRules').toExist();
      expect(Object.keys(rules.fields).sort(), '报工规则的列').toEqual(RULE_FIELDS);
      expect(rules.primaryKey).toEqual(['id']);
      expect(rules.foreignKeys).toHaveLength(0);
      await expectCollection('reportRules').toHaveIndex(['code'], { unique: true });

      const prices = await expectCollection('operationPrices').toExist();
      expect(Object.keys(prices.fields).sort(), '工价的列').toEqual(PRICE_FIELDS);
      expect(prices.primaryKey).toEqual(['id']);
      expect(prices.foreignKeys).toHaveLength(0);
      await expectCollection('operationPrices').toHaveIndex(['itemId', 'operationId'], {
        unique: true,
      });
      expect(await decimalOf('operation_prices', 'unit_price')).toEqual({
        precision: 18, scale: 2,
      });
      const types = await knex.raw<{ rows?: { column_name: string; data_type: string }[] }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'work_centers'`,
      );
      expect(
        Object.fromEntries((types.rows ?? []).map((row) => [row.column_name, row.data_type])),
      ).toMatchObject({ created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' });

      const physical = async (tableName: string) => {
        const found = await connection.schemaInspector.getPhysicalCollection({ tableName });
        return [...(found?.indexes.map((index) => index.name) ?? [])].sort();
      };
      expect(await physical('work_centers')).toEqual([
        'ix_work_centers_active', 'pk_work_centers', 'uq_work_centers_code',
      ]);
      expect(await physical('operations')).toEqual([
        'ix_operations_active_sort', 'pk_operations', 'uq_operations_code',
      ]);
      expect(await physical('process_routes')).toEqual([
        'ix_process_routes_product', 'pk_process_routes', 'uq_process_routes_doc_no',
      ]);
      expect(await physical('process_route_steps')).toEqual([
        'ix_route_steps_route', 'pk_process_route_steps', 'uq_route_steps',
      ]);
      expect(await physical('defect_items')).toEqual([
        'pk_defect_items', 'uq_defect_items_code',
      ]);
      expect(await physical('report_rules')).toEqual([
        'pk_report_rules', 'uq_report_rules_code',
      ]);
      expect(await physical('operation_prices')).toEqual([
        'pk_operation_prices', 'uq_operation_prices',
      ]);

      // 迁移只管表结构：reportRules 建成空表，四行默认值由 032 种子写入。
      expect(await connection.query.selectFrom('report_rules').selectAll().execute())
        .toHaveLength(0);

      // 唯一约束真库生效；六个开关列可空、原样读写，不写进任何规则。
      const now = '2026-11-28T01:00:00.000Z';
      const operationId = randomUUID();
      const insertOperation = (code: string) => connection.query
        .insertInto('operations').values({
          id: operationId, code, name: 'Op', sortOrder: 0,
          createdById: 'r023-migration-test', createdAt: now, updatedAt: now,
        }).execute();
      await insertOperation('OP-R023-001');
      await expect(insertOperation('OP-R023-001'), '工序编号唯一').rejects.toThrow();
      const op = await connection.query.selectFrom('operations').selectAll()
        .where('id', '=', operationId).executeTakeFirstOrThrow();
      for (const field of SIX_SWITCHES) {
        expect(op[field], `${field} 应可空`).toBeNull();
      }
      await connection.query.updateTable('operations')
        .set({ equipmentRequired: true, currentReportLimit: '3' })
        .where('id', '=', operationId).execute();
      const changed = await connection.query.selectFrom('operations').selectAll()
        .where('id', '=', operationId).executeTakeFirstOrThrow();
      expect(changed.equipmentRequired).toBe(true);
      expect(changed.currentReportLimit).toBe('3');

      // 工序行唯一约束：同一工艺里同一工序只能出现一次。
      const routeId = randomUUID();
      await connection.query.insertInto('process_routes').values({
        id: routeId, docNo: 'GY-R023-0001', name: 'Route', productId: randomUUID(),
        active: true, createdById: 'r023-migration-test', createdAt: now, updatedAt: now,
      }).execute();
      const insertStep = () => connection.query.insertInto('process_route_steps').values({
        id: randomUUID(), routeId, operationId, stepNo: 1, note: null,
      }).execute();
      await insertStep();
      await expect(insertStep(), '工艺行 (routeId, operationId) 唯一').rejects.toThrow();
    },
    down: async ({ expectCollection }) => {
      for (const name of [
        'workCenters', 'operations', 'processRoutes', 'processRouteSteps',
        'defectItems', 'reportRules', 'operationPrices',
      ]) {
        await expectCollection(name).not.toExist();
      }
    },
  });
});
