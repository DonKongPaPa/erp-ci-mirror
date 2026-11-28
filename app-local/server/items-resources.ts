import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-019 MVP 的物料主数据资源声明（只有声明，不注册、不查库、不赋权）。
 *
 * units、itemCategories、items 三张表没有账号、姓名、邮箱、部门等人员信息，
 * `items.createdById` 只是建单人的账号 id，不参与授权，也不在响应里展开成人员信息。
 * 它们合成一个 `items` 业务资源，view 读三张表、manage 建改三张表。
 * 注册在 providers/authorization-resources.ts；本片不给任何业务角色授权（默认只有 root）。
 *
 * 授权没有字段这一层，写权限只能限定到端点会写的列（同 shift-resources.ts）：
 * - `view` 读三张表的全部响应列；
 * - `manage` 读同样的列，建、改只写端点会收的列（编码与时间戳由服务端写）。
 *
 * 动作清单写全，不登记删除：物料只停用不删除，也没有删除端点。
 */
const NAMESPACE = 'app-local';

const itemsTitle = {
  key: 'authorization.items.tables.items',
  ns: NAMESPACE,
} as const;
const unitsTitle = {
  key: 'authorization.items.tables.units',
  ns: NAMESPACE,
} as const;
const categoriesTitle = {
  key: 'authorization.items.tables.categories',
  ns: NAMESPACE,
} as const;

const ITEM_READ_FIELDS = [
  'id',
  'code',
  'name',
  'spec',
  'itemType',
  'categoryCode',
  'unitCode',
  'status',
  'legacyCode',
  'note',
  'createdById',
  'createdAt',
  'updatedAt',
  // 复刻波 0 加片：9 个不带价格的列进基础读；两个基准价各自单独成动作。
  'englishName',
  'stockMin',
  'stockMax',
  'barcode',
  'brand',
  'manufacturerModel',
  'auxUnitCode',
  'unitRatio',
  'purchaseLeadDays',
  // R-070：来料必检开关默认关；打开只影响建入库单时的提示，不拦。
  'inspectionRequired',
] as const;
const ITEM_PURCHASE_PRICE_READ_FIELDS = [
  ...ITEM_READ_FIELDS,
  'basePurchasePrice',
] as const;
const ITEM_SALES_PRICE_READ_FIELDS = [
  ...ITEM_READ_FIELDS,
  'baseSalesPrice',
] as const;
const ITEM_CREATE_FIELDS = [
  'name',
  'spec',
  'itemType',
  'categoryCode',
  'unitCode',
  'legacyCode',
  'note',
  'englishName',
  'stockMin',
  'stockMax',
  'basePurchasePrice',
  'baseSalesPrice',
  'barcode',
  'brand',
  'manufacturerModel',
  'auxUnitCode',
  'unitRatio',
  'purchaseLeadDays',
] as const;
const ITEM_UPDATE_FIELDS = [
  'name',
  'spec',
  'itemType',
  'categoryCode',
  'unitCode',
  'status',
  'legacyCode',
  'note',
  'englishName',
  'stockMin',
  'stockMax',
  'basePurchasePrice',
  'baseSalesPrice',
  'barcode',
  'brand',
  'manufacturerModel',
  'auxUnitCode',
  'unitRatio',
  'purchaseLeadDays',
] as const;

const UNIT_READ_FIELDS = [
  'code',
  'name',
  'decimals',
  'status',
  'createdAt',
  'updatedAt',
] as const;
const UNIT_CREATE_FIELDS = ['code', 'name', 'decimals'] as const;
const UNIT_UPDATE_FIELDS = ['name', 'decimals', 'status'] as const;

const CATEGORY_READ_FIELDS = [
  'id',
  'code',
  'name',
  'parentId',
  'status',
  'createdAt',
  'updatedAt',
] as const;
const CATEGORY_CREATE_FIELDS = ['id', 'code', 'name', 'parentId'] as const;
const CATEGORY_UPDATE_FIELDS = ['name', 'parentId', 'status'] as const;

const readItems = defineDatabasePermission((permission) =>
  permission.collection('items').title(itemsTitle).read(ITEM_READ_FIELDS),
);
const manageItems = defineDatabasePermission((permission) =>
  permission
    .collection('items')
    .title(itemsTitle)
    .read(ITEM_READ_FIELDS)
    .create(ITEM_CREATE_FIELDS)
    .update(ITEM_UPDATE_FIELDS),
);
const readPurchasePrice = defineDatabasePermission((permission) =>
  permission
    .collection('items')
    .title(itemsTitle)
    .read(ITEM_PURCHASE_PRICE_READ_FIELDS),
);
const readSalesPrice = defineDatabasePermission((permission) =>
  permission
    .collection('items')
    .title(itemsTitle)
    .read(ITEM_SALES_PRICE_READ_FIELDS),
);
const readUnits = defineDatabasePermission((permission) =>
  permission.collection('units').title(unitsTitle).read(UNIT_READ_FIELDS),
);
const manageUnits = defineDatabasePermission((permission) =>
  permission
    .collection('units')
    .title(unitsTitle)
    .read(UNIT_READ_FIELDS)
    .create(UNIT_CREATE_FIELDS)
    .update(UNIT_UPDATE_FIELDS),
);
const readCategories = defineDatabasePermission((permission) =>
  permission
    .collection('itemCategories')
    .title(categoriesTitle)
    .read(CATEGORY_READ_FIELDS),
);
const manageCategories = defineDatabasePermission((permission) =>
  permission
    .collection('itemCategories')
    .title(categoriesTitle)
    .read(CATEGORY_READ_FIELDS)
    .create(CATEGORY_CREATE_FIELDS)
    .update(CATEGORY_UPDATE_FIELDS),
);

/** 动作清单必须写明，否则框架默认把删除也登记上。 */
export const ITEM_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'units',
    title: unitsTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'itemCategories',
    title: categoriesTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'items',
    title: itemsTitle,
    actions: ['read', 'create', 'update'],
  },
];

export const items = defineCompositeResource('items', (resource) =>
  resource
    .title({ key: 'authorization.items.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.items.actions.view', ns: NAMESPACE })
        .grant('items', readItems)
        .grant('units', readUnits)
        .grant('itemCategories', readCategories),
    )
    .action('manage', (action) =>
      action
        .title({ key: 'authorization.items.actions.manage', ns: NAMESPACE })
        .grant('items', manageItems)
        .grant('units', manageUnits)
        .grant('itemCategories', manageCategories),
    )
    // 旧系统的「采购价 / 销售价」两个权限点：各比 view 多读一列，互不交叉。
    .action('viewPurchasePrice', (action) =>
      action
        .title({ key: 'authorization.items.actions.viewPurchasePrice', ns: NAMESPACE })
        .grant('items', readPurchasePrice),
    )
    .action('viewSalesPrice', (action) =>
      action
        .title({ key: 'authorization.items.actions.viewSalesPrice', ns: NAMESPACE })
        .grant('items', readSalesPrice),
    ),
);
