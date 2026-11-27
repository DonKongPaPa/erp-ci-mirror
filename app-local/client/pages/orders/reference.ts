export { useOptionPage as useReferencePage } from '#components/erp/options';

/**
 * 订单页面要用的三份档案：物料（R-019）、往来单位（R-014）、仓库（R-020）。
 * 订单的明细行只有 `itemId`，表头自带往来单位摘要；选物料、选仓库、对物料的名字都要另取列表。
 */

/** 一条物料，与 R-019 的 `Item` 对应；建单人标识不取。 */
export interface Item {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly itemType: 'material' | 'product';
  readonly categoryCode: string | null;
  readonly unitCode: string;
  readonly status: 'active' | 'inactive';
}

/** 往来单位列表行里页面用得到的三列。 */
export interface PartnerOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface WarehouseOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

/** 下拉选择的一个选项。 */
export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** 选物料用的选项：「编码 名称」；停用的物料列出来但选不了（编辑时已有的行要显示名字）。 */
export function itemChoices(
  items: readonly Item[],
  inactiveLabel: string,
): Choice[] {
  return items.map((item) => ({
    value: item.id,
    label:
      `${item.code} ${item.name}` +
      (item.status === 'active' ? '' : ` (${inactiveLabel})`),
    disabled: item.status !== 'active',
  }));
}

/** 通用分页读取器现在放在地基里，订单与出入库、财务页共用一份（见 `components/erp/options.ts`）。 */
