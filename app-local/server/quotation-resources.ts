import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-022 复刻波 1：报价单业务资源声明（只声明，不查库、不赋权）。
 *
 * 六个动作没有删除；价格不另开动作——报价上的价格本来就是要给客户看的，
 * 所以逐列声明响应里能出现的列：往来单位三列、经办人由服务层只回标识与姓名、
 * 物料摘要五列（没有基准采购价与销售价）、六个合计与行金额都声明。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const headerTitle = title('authorization.quotations.tables.orders');
const lineTitle = title('authorization.quotations.tables.lines');
const itemTitle = title('authorization.items.tables.items');
const warehouseTitle = title('authorization.inventory.tables.warehouses');
const partnerTitle = title('authorization.partners.tables.partners');
const dictTitle = title('authorization.bizDict.tables.entries');

const ACTIONS = ['view', 'create', 'update', 'confirm', 'convert', 'void'] as const;

/** 读列逐项列出；createdById 不在其中，任何读响应都不回。 */
const HEADER_READ = [
  'id', 'docNo', 'quoteDate', 'validUntil', 'warehouseId', 'customerId',
  'contactName', 'contactPhone', 'deliveryAddress', 'projectCode', 'settlementCode',
  'customerOrderNo', 'handlerUserId', 'discountAmount', 'totalQty',
  'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal',
  'status', 'convertedOrderId', 'createdAt', 'updatedAt',
] as const;
const HEADER_CREATE = [...HEADER_READ, 'createdById'] as const;
const HEADER_UPDATE = [
  'quoteDate', 'validUntil', 'warehouseId', 'customerId', 'contactName',
  'contactPhone', 'deliveryAddress', 'projectCode', 'settlementCode',
  'customerOrderNo', 'handlerUserId', 'discountAmount', 'status',
  'convertedOrderId', 'updatedAt',
] as const;
const LINE_READ = [
  'id', 'quotationId', 'itemId', 'qty', 'price', 'deliveryDate', 'taxRate',
  'taxExcludedPrice', 'taxExcludedAmount', 'taxAmount', 'taxIncludedAmount', 'note',
] as const;

const readHeader = defineDatabasePermission((permission) =>
  permission.collection('quotations').title(headerTitle).read(HEADER_READ),
);
const writeHeader = defineDatabasePermission((permission) =>
  permission
    .collection('quotations')
    .title(headerTitle)
    .read(['id', 'status', 'convertedOrderId'])
    .create(HEADER_CREATE)
    .update(HEADER_UPDATE),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('quotationLines').title(lineTitle).read(LINE_READ),
);
const writeLines = defineDatabasePermission((permission) =>
  permission
    .collection('quotationLines')
    .title(lineTitle)
    .read(['id', 'quotationId'])
    .create(LINE_READ)
    .delete(),
);
/** 摘要只回三列：没有联系人邮箱、地址与客户原始素材。 */
const readPartner = defineDatabasePermission((permission) =>
  permission.collection('partners').title(partnerTitle).read(['id', 'code', 'name']),
);
/** 物料摘要没有基准采购价与销售价。 */
const readItem = defineDatabasePermission((permission) =>
  permission.collection('items').title(itemTitle).read([
    'id', 'code', 'name', 'spec', 'unitCode',
  ]),
);
const readWarehouse = defineDatabasePermission((permission) =>
  permission.collection('warehouses').title(warehouseTitle).read([
    'id', 'code', 'name', 'status', 'note', 'createdAt', 'updatedAt',
  ]),
);
const readDict = defineDatabasePermission((permission) =>
  permission.collection('bizDictEntries').title(dictTitle).read(['dictType', 'code', 'name']),
);

export const QUOTATION_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'quotations', title: headerTitle, actions: ['read', 'create', 'update'] },
  { name: 'quotationLines', title: lineTitle, actions: ['read', 'create', 'delete'] },
];

/** 只有 sales 与 root 拿到这些动作；其它角色一个都没有，端点先授权后读内容。 */
export const quotations = defineCompositeResource('quotations', (resource) => {
  let result = resource.title(title('authorization.quotations.title'));
  for (const action of ACTIONS) {
    result = result.action(action, (definition) =>
      definition
        .title(title(`authorization.quotations.actions.${action}`))
        .grant('quotations', action === 'view' ? readHeader : writeHeader)
        .grant('quotationLines', action === 'view' ? readLines : writeLines)
        .grant('partners', readPartner)
        .grant('items', readItem)
        .grant('warehouses', readWarehouse)
        .grant('bizDictEntries', readDict),
    );
  }
  return result;
});
