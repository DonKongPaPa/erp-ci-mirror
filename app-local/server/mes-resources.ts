import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-023 W3-1：`mesSettings` 业务资源只有 view / maintain / priceView 三个动作。
 *
 * view 给五个设置页的只读列，不碰工价表；priceView 是窄读，只放开工价表的
 * unitPrice；maintain 只给 root，覆盖新增、改与停用。不登记删除，停用在 active。
 * 六个开关列与 currentReportLimit / previousReportLimit 原样读写，不解释语义。
 * 只声明、不赋权，也不做 ui.place（本片没有页面）。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const WORK_CENTER_READ = [
  'id', 'code', 'name', 'managerUserId', 'workerCount', 'active',
  'createdAt', 'updatedAt',
] as const;
const WORK_CENTER_WRITE = [
  'code', 'name', 'managerUserId', 'workerCount', 'active',
] as const;
const OPERATION_READ = [
  'id', 'code', 'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
  'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
  'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
  'createdAt', 'updatedAt',
] as const;
const OPERATION_WRITE = [
  'code', 'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
  'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
  'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
] as const;
const ROUTE_READ = [
  'id', 'docNo', 'name', 'productId', 'active', 'createdAt', 'updatedAt',
] as const;
const ROUTE_WRITE = ['docNo', 'name', 'productId', 'active'] as const;
const STEP_READ = ['id', 'routeId', 'operationId', 'stepNo', 'note'] as const;
const STEP_WRITE = ['routeId', 'operationId', 'stepNo', 'note'] as const;
const DEFECT_READ = ['id', 'code', 'name', 'active', 'createdAt'] as const;
const DEFECT_WRITE = ['code', 'name', 'active'] as const;
const RULE_READ = ['id', 'code', 'value', 'updatedAt'] as const;
const RULE_WRITE = ['value', 'updatedById', 'updatedAt'] as const;
/** 没有 priceView 时这一列由路由整键裁掉，不在响应里出现（不是 null）。 */
const PRICE_READ = [
  'id', 'itemId', 'operationId', 'unitPrice', 'note', 'updatedAt',
] as const;
const PRICE_WRITE = ['itemId', 'operationId', 'unitPrice', 'note'] as const;

const read = (collection: string, fields: readonly string[]) =>
  defineDatabasePermission((permission) =>
    permission.collection(collection).read(fields),
  );
const write = (
  collection: string,
  readFields: readonly string[],
  writeFields: readonly string[],
) =>
  defineDatabasePermission((permission) =>
    permission
      .collection(collection)
      .read(readFields)
      .create(writeFields)
      .update(writeFields),
  );

/** 动作清单写全，否则框架会把删除也登记上。 */
export const MES_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'workCenters', title: title('authorization.mesSettings.tables.workCenters'), actions: ['read', 'create', 'update'] },
  { name: 'operations', title: title('authorization.mesSettings.tables.operations'), actions: ['read', 'create', 'update'] },
  { name: 'processRoutes', title: title('authorization.mesSettings.tables.processRoutes'), actions: ['read', 'create', 'update'] },
  { name: 'processRouteSteps', title: title('authorization.mesSettings.tables.processRouteSteps'), actions: ['read', 'create', 'update'] },
  { name: 'defectItems', title: title('authorization.mesSettings.tables.defectItems'), actions: ['read', 'create', 'update'] },
  { name: 'reportRules', title: title('authorization.mesSettings.tables.reportRules'), actions: ['read', 'create', 'update'] },
  { name: 'operationPrices', title: title('authorization.mesSettings.tables.operationPrices'), actions: ['read', 'create', 'update'] },
];

export const mesSettings = defineCompositeResource('mesSettings', (resource) =>
  resource
    .title(title('authorization.mesSettings.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.mesSettings.actions.view'))
        .grant('workCenters', read('workCenters', WORK_CENTER_READ))
        .grant('operations', read('operations', OPERATION_READ))
        .grant('processRoutes', read('processRoutes', ROUTE_READ))
        .grant('processRouteSteps', read('processRouteSteps', STEP_READ))
        .grant('defectItems', read('defectItems', DEFECT_READ))
        .grant('reportRules', read('reportRules', RULE_READ)),
    )
    .action('maintain', (action) =>
      action
        .title(title('authorization.mesSettings.actions.maintain'))
        .grant('workCenters', write('workCenters', WORK_CENTER_READ, WORK_CENTER_WRITE))
        .grant('operations', write('operations', OPERATION_READ, OPERATION_WRITE))
        .grant('processRoutes', write('processRoutes', ROUTE_READ, ROUTE_WRITE))
        .grant('processRouteSteps', write('processRouteSteps', STEP_READ, STEP_WRITE))
        .grant('defectItems', write('defectItems', DEFECT_READ, DEFECT_WRITE))
        .grant('reportRules', write('reportRules', RULE_READ, RULE_WRITE))
        .grant('operationPrices', write('operationPrices', PRICE_READ, PRICE_WRITE)),
    )
    .action('priceView', (action) =>
      action
        .title(title('authorization.mesSettings.actions.priceView'))
        .grant('operationPrices', read('operationPrices', PRICE_READ)),
    ),
);
