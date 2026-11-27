import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-014 MVP 的业务资源声明：客户与供应商各一份，共用 partners / partner_contacts 两张表。
 *
 * 销售只持 customers 的三个动作，采购只持 suppliers 的三个动作；root 不受限。
 * 这样「销售读不到供应商」是授权本身的事实，不是端点记得过滤（照 R-013 的权限收窄）。
 * 数据范围初期用全部（R-013 裁定），所以授权里不带 policy。
 *
 * 授权没有字段这一层，写权限只列到端点真会写的列（同 shift-resources.ts）：
 * - `view` 读主档十四列（没有 createdById 这个人员列）与联系人七列；
 * - `create` 只建主档，建列是服务写进去的全列（编码由发号器给，建单人是调用者）；
 * - `update` 读两表、改主档的可改列、建改联系人；编码、客户/供应商标志、建单人都不在改列里。
 *
 * 动作清单写全，不登记删除：往来单位只停用不删除。两张表不进角色编辑器（没有 placement），
 * 只供 customers / suppliers 的业务动作展开。
 */
const NAMESPACE = 'app-local';

const partnersTitle = {
  key: 'authorization.partners.tables.partners',
  ns: NAMESPACE,
} as const;
const contactsTitle = {
  key: 'authorization.partners.tables.contacts',
  ns: NAMESPACE,
} as const;

/** 读响应逐列拼装；createdById 是人员标识，任何读动作都不回。 */
const PARTNER_READ_FIELDS = [
  'id',
  'code',
  'name',
  'isCustomer',
  'isSupplier',
  'status',
  'contactName',
  'phone',
  'email',
  'address',
  'taxId',
  'note',
  'createdAt',
  'updatedAt',
] as const;

/** 服务建行真会写的列；编码与建单人由服务端写，仍要在建列里。 */
const PARTNER_CREATE_FIELDS = [
  ...PARTNER_READ_FIELDS,
  'createdById',
] as const;

/** PATCH 能改的列：不含 code、isCustomer、isSupplier、createdById。 */
const PARTNER_UPDATE_FIELDS = [
  'name',
  'status',
  'contactName',
  'phone',
  'email',
  'address',
  'taxId',
  'note',
  'updatedAt',
] as const;

const CONTACT_READ_FIELDS = [
  'id',
  'partnerId',
  'name',
  'title',
  'phone',
  'email',
  'isPrimary',
] as const;
const CONTACT_UPDATE_FIELDS = ['name', 'title', 'phone', 'email', 'isPrimary'] as const;

const viewPartners = defineDatabasePermission((permission) =>
  permission
    .collection('partners')
    .title(partnersTitle)
    .read(PARTNER_READ_FIELDS),
);

const viewContacts = defineDatabasePermission((permission) =>
  permission
    .collection('partnerContacts')
    .title(contactsTitle)
    .read(CONTACT_READ_FIELDS),
);

const createPartners = defineDatabasePermission((permission) =>
  permission
    .collection('partners')
    .title(partnersTitle)
    .read(PARTNER_READ_FIELDS)
    .create(PARTNER_CREATE_FIELDS),
);

/**
 * 改：主档读 + 改，联系人读 + 建 + 改。读不能省 —— 加完联系人要回读那一行，
 * 详情也要把联系人带出来；同一个动作里读与建必须是同一份声明。
 */
const updatePartners = defineDatabasePermission((permission) =>
  permission
    .collection('partners')
    .title(partnersTitle)
    .read(PARTNER_READ_FIELDS)
    .update(PARTNER_UPDATE_FIELDS),
);

const updateContacts = defineDatabasePermission((permission) =>
  permission
    .collection('partnerContacts')
    .title(contactsTitle)
    .read(CONTACT_READ_FIELDS)
    .create(CONTACT_READ_FIELDS)
    .update(CONTACT_UPDATE_FIELDS),
);

export const PARTNER_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'partners',
    title: partnersTitle,
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'partnerContacts',
    title: contactsTitle,
    actions: ['read', 'create', 'update'],
  },
];

/** 客户与供应商同形不同名：动作名一致，授权的对象不同。 */
const definePartnerResource = (id: 'customers' | 'suppliers') =>
  defineCompositeResource(id, (resource) =>
    resource
      .title({ key: `authorization.${id}.title`, ns: NAMESPACE })
      .action('view', (action) =>
        action
          .title({ key: `authorization.${id}.actions.view`, ns: NAMESPACE })
          .grant('partners', viewPartners)
          .grant('partnerContacts', viewContacts),
      )
      .action('create', (action) =>
        action
          .title({ key: `authorization.${id}.actions.create`, ns: NAMESPACE })
          .grant('partners', createPartners),
      )
      .action('update', (action) =>
        action
          .title({ key: `authorization.${id}.actions.update`, ns: NAMESPACE })
          .grant('partners', updatePartners)
          .grant('partnerContacts', updateContacts),
      ),
  );

export const customers = definePartnerResource('customers');
export const suppliers = definePartnerResource('suppliers');
