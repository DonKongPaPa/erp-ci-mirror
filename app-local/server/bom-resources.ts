import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-019 波 2 的 BOM 资源声明：两张表合成一个 `boms` 业务资源。
 * 只声明、不赋权 —— 默认只有 root；读动作由新种子给 craft 与 planning，
 * 维护动作四个端点（建、改、停用、展开里的写不算）都只给 root。
 *
 * `createdById` 是审计列，不在任何读字段里；授权也没有字段这一层，
 * 金额列另由 items.viewPurchasePrice 在路由上裁掉（见 routes/boms.ts）。
 * 不登记删除：BOM 用停用与版本失效代替。
 */
const NAMESPACE = 'app-local';

const bomsTitle = { key: 'authorization.boms.tables.boms', ns: NAMESPACE } as const;
const linesTitle = { key: 'authorization.boms.tables.lines', ns: NAMESPACE } as const;

const BOM_READ_FIELDS = [
  'id', 'docNo', 'version', 'productId', 'isDefault', 'effectiveFrom',
  'effectiveTo', 'dailyOutput', 'status', 'remark', 'createdAt', 'updatedAt',
] as const;
const LINE_READ_FIELDS = [
  'id', 'bomId', 'lineNo', 'itemId', 'qty', 'lossRate', 'childBomId', 'note',
] as const;
const BOM_WRITE_FIELDS = [
  'version', 'productId', 'isDefault', 'effectiveFrom', 'effectiveTo',
  'dailyOutput', 'remark',
] as const;
const LINE_WRITE_FIELDS = [
  'bomId', 'lineNo', 'itemId', 'qty', 'lossRate', 'childBomId', 'note',
] as const;

const readBoms = defineDatabasePermission((permission) =>
  permission.collection('boms').title(bomsTitle).read(BOM_READ_FIELDS),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('bomLines').title(linesTitle).read(LINE_READ_FIELDS),
);
const writeBoms = defineDatabasePermission((permission) =>
  permission
    .collection('boms')
    .title(bomsTitle)
    .read(BOM_READ_FIELDS)
    .create(BOM_WRITE_FIELDS)
    .update(BOM_WRITE_FIELDS),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('bomLines')
    .title(linesTitle)
    .read(LINE_READ_FIELDS)
    .create(LINE_WRITE_FIELDS)
    .update(LINE_WRITE_FIELDS),
);

/** 动作清单写全：框架默认会把删除也登记上。 */
export const BOM_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'boms', title: bomsTitle, actions: ['read', 'create', 'update'] },
  { name: 'bomLines', title: linesTitle, actions: ['read', 'create', 'update'] },
];

export const boms = defineCompositeResource('boms', (resource) =>
  resource
    .title({ key: 'authorization.boms.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.boms.actions.view', ns: NAMESPACE })
        .grant('boms', readBoms)
        .grant('bomLines', readLines),
    )
    .action('explode', (action) =>
      action
        .title({ key: 'authorization.boms.actions.explode', ns: NAMESPACE })
        .grant('boms', readBoms)
        .grant('bomLines', readLines),
    )
    .action('create', (action) =>
      action
        .title({ key: 'authorization.boms.actions.create', ns: NAMESPACE })
        .grant('boms', writeBoms)
        .grant('bomLines', writeLines),
    )
    .action('update', (action) =>
      action
        .title({ key: 'authorization.boms.actions.update', ns: NAMESPACE })
        .grant('boms', writeBoms)
        .grant('bomLines', writeLines),
    )
    .action('void', (action) =>
      action
        .title({ key: 'authorization.boms.actions.void', ns: NAMESPACE })
        .grant('boms', writeBoms),
    ),
);
