import type { DocReason, DocType } from './client.js';

/**
 * 入库单与出库单是同一张骨架、同一组端点，只差方向（《基座ERP前端设计》2.4、3.3）。
 * 一个方向的全部差异收在这里：路径、能选的类型、由订单生成时的来源、词条组。
 */
export interface StockKind {
  readonly kind: DocType;
  /** 列表的路径，也是新建、详情、编辑的父路径。 */
  readonly base: '/inbound-orders' | '/outbound-orders';
  /** 这一个方向能选的类型（R-020 加片：reason 必须与 docType 相配，一共八种，每个方向四种）。 */
  readonly reasons: readonly DocReason[];
  /** 由订单生成时的来源类型；手工录入的单据没有来源。 */
  readonly sourceType: 'purchase_order' | 'sales_order';
  /** 手工新建时默认的类型。 */
  readonly manualReason: DocReason;
  /** 词条组：`stockDocs.in` 或 `stockDocs.out`。 */
  readonly words: 'in' | 'out';
}

export const STOCK_KINDS: Readonly<Record<DocType, StockKind>> = {
  in: {
    kind: 'in',
    base: '/inbound-orders',
    reasons: ['purchase_receipt', 'production_receipt', 'sales_return', 'other_in'],
    sourceType: 'purchase_order',
    manualReason: 'other_in',
    words: 'in',
  },
  out: {
    kind: 'out',
    base: '/outbound-orders',
    reasons: ['internal_use', 'sales_issue', 'purchase_return', 'other_out'],
    sourceType: 'sales_order',
    manualReason: 'other_out',
    words: 'out',
  },
};
