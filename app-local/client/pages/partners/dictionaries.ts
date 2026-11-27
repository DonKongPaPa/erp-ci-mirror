import type { EntityPage } from '#components/erp/list-state';
import { useListData } from '#hooks/use-list-data';

import type { Entry } from '../biz-dict/client.js';
import type { PersonOption } from './client.js';

const PEOPLE_PATH = 'person-options?page=1&pageSize=20';
const groupPath = (dictType: string) =>
  `biz-dict/entries?dictType=${dictType}&pageSize=100`;

/**
 * 往来单位表单的三本窄字典：销售员 / 采购员共用 R-072 的人员选项（只有标识与姓名），
 * 客户分组与供应商分组各取字典当前类型的一页。按侧取数：没有那一侧的动作就不发那一本的请求。
 * 读不到时退化成空选项（已有的码仍会留在下拉里），不挡着表单打开。
 */
export function usePartnerDictionaries(
  enabled: boolean,
  pending: boolean,
  sides: { readonly customer: boolean; readonly supplier: boolean },
) {
  const active = enabled && !pending;
  const people = useListData<EntityPage<PersonOption>>(PEOPLE_PATH, {
    active,
  });
  const customerGroups = useListData<EntityPage<Entry>>(
    groupPath('customer_group'),
    { active: active && sides.customer },
  );
  const supplierGroups = useListData<EntityPage<Entry>>(
    groupPath('supplier_group'),
    { active: active && sides.supplier },
  );
  return {
    people: people.data?.items ?? [],
    customerGroups: customerGroups.data?.items ?? [],
    supplierGroups: supplierGroups.data?.items ?? [],
    loading: people.loading || customerGroups.loading || supplierGroups.loading,
  };
}

export interface PartnerDictionaries {
  readonly people: readonly PersonOption[];
  readonly customerGroups: readonly Entry[];
  readonly supplierGroups: readonly Entry[];
}
