import type { ApiClient } from '@nocobase/app-client';

import type { DocFile } from '#components/erp/doc-files';
import type { EntityPage } from '#components/erp/list-state';

/** R-065 第二片：端点直接回对象或一页，没有 `{ data }` 外层。人员只回标识与姓名。 */
export type DocStatus = 'draft' | 'confirmed' | 'void';
export type ReconStatus = 'unsettled' | 'partial' | 'settled';
export type DocBindMode = 'sales_order' | 'receivable_recon' | 'none';

export interface PersonRef { readonly userId: string; readonly name: string; }
export interface PartnerRef { readonly id: string; readonly code: string; readonly name: string; }

export interface ReconciliationLine {
  readonly id: string;
  readonly recordId: string;
  readonly salesOrderId: string | null;
  readonly receivableReconId: string | null;
  readonly amount: number;
  readonly orderPayableAmount: number;
  readonly receivedBefore?: number;
  readonly invoicedBefore?: number;
  readonly note: string | null;
}

export interface DocRecord {
  readonly id: string;
  readonly docNo: string;
  readonly date: string;
  readonly status: DocStatus;
  readonly bindMode: DocBindMode;
  readonly customerId: string | null;
  readonly customer: PartnerRef | null;
  readonly payerName: string | null;
  readonly invoiceToName: string | null;
  readonly invoiceNo: string | null;
  readonly incomeTypeCode: string | null;
  readonly incomeTypeLabel: string | null;
  readonly invoiceTypeCode: string | null;
  readonly invoiceTypeLabel: string | null;
  readonly fundAccountCode: string | null;
  readonly fundAccountLabel: string | null;
  readonly handler: PersonRef | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly remark: string;
  readonly totalAmount: number;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ReconciliationLine[];
  readonly files?: readonly DocFile[];
}

export interface SnapshotLine {
  readonly id: string;
  readonly reconId: string;
  readonly side: 'out' | 'return' | 'in';
  readonly sourceDocId: string;
  readonly itemId: string;
  readonly item: {
    readonly id: string; readonly code: string; readonly name: string;
    readonly spec: string | null; readonly unitCode: string;
  };
  readonly qty: number;
  readonly taxRate: number | null;
  readonly taxIncludedPrice: number | null;
  readonly taxIncludedAmount: number | null;
  readonly note: string | null;
}

export interface ReconRecord {
  readonly id: string;
  readonly docNo: string;
  readonly reconDate: string;
  readonly expectedPayDate: string | null;
  readonly periodAmount: number;
  readonly status: DocStatus;
  readonly reconStatus: ReconStatus;
  readonly reconciledIncomeAmount?: number;
  readonly reconciledInvoiceAmount?: number;
  readonly reconciledPaidAmount?: number;
  readonly customer: PartnerRef | null;
  readonly supplier: PartnerRef | null;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly invoiceTypeCode: string | null;
  readonly handler: PersonRef | null;
  readonly projectCode: string | null;
  readonly remark: string;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshotLines: readonly SnapshotLine[];
  readonly files?: readonly DocFile[];
}

/** 财务读销售订单的窄形状：八列头与客户三列摘要。 */
export interface ReceivableOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly payableTotal: number | null;
  readonly receivedAmount: number;
  readonly invoicedAmount: number;
  readonly customer: PartnerRef | null;
}

export interface ReconOption {
  readonly id: string;
  readonly docNo: string;
  readonly reconDate: string;
  readonly periodAmount: number;
  readonly reconciledIncomeAmount?: number;
  readonly reconciledInvoiceAmount?: number;
  readonly reconciledPaidAmount?: number;
}

/** 对账建单选已过账出入库单的窄读数：不回明细、单价、经办人。 */
export interface SourceDoc {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly partnerId: string | null;
  readonly partnerName: string | null;
  readonly reason: string;
  readonly status: string;
  readonly totalQty: number | null;
}

export interface ListQuery {
  readonly status?: string;
  readonly partnerId?: string;
  readonly typeCode?: string;
  readonly bindMode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export class ReconciliationClient {
  constructor(private readonly api: ApiClient) {}

  list(kind: string, query: ListQuery = {}): Promise<EntityPage<DocRecord | ReconRecord>> {
    return this.api.request<EntityPage<DocRecord | ReconRecord>>({
      path: `${kind}?${searchOf(query)}`,
    });
  }

  get(kind: string, id: string): Promise<DocRecord | ReconRecord> {
    return this.api.request<DocRecord | ReconRecord>({
      path: `${kind}/${encodeURIComponent(id)}`,
    });
  }

  create(kind: string, input: unknown): Promise<DocRecord | ReconRecord> {
    return this.api.request<DocRecord | ReconRecord>({
      path: kind, method: 'POST', json: input,
    });
  }

  update(kind: string, id: string, input: unknown): Promise<DocRecord | ReconRecord> {
    return this.api.request<DocRecord | ReconRecord>({
      path: `${kind}/${encodeURIComponent(id)}`, method: 'PATCH', json: input,
    });
  }

  async confirm(kind: string, id: string): Promise<DocRecord | ReconRecord> {
    return this.api.request<DocRecord | ReconRecord>({
      path: `${kind}/${encodeURIComponent(id)}/confirm`, method: 'POST',
    });
  }

  async void(kind: string, id: string): Promise<DocRecord | ReconRecord> {
    return this.api.request<DocRecord | ReconRecord>({
      path: `${kind}/${encodeURIComponent(id)}/void`, method: 'POST',
    });
  }

  /** 收入/开票绑销售订单：财务专用窄读，没有明细、单价、备注、经办人。 */
  receivableOrders(query: { q?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<ReceivableOrder>> {
    return this.api.request<EntityPage<ReceivableOrder>>({
      path: `sales-orders/receivable?${searchOf(query)}`,
    });
  }

  /** 已确认的对账单下拉：两列核销金额只给财务。 */
  reconOptions(kind: string, query: { q?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<ReconOption>> {
    return this.api.request<EntityPage<ReconOption>>({
      path: `${kind}/options?${searchOf(query)}`,
    });
  }

  /** 财务专用窄读：已过账的销售出库单（out）或采购入库单（in）。 */
  sourceDocs(kind: 'out' | 'in', query: { q?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<SourceDoc>> {
    return this.api.request<EntityPage<SourceDoc>>({
      path: `reconciliation/source-docs?${searchOf({ kind, ...query })}`,
    });
  }

  /** 对账单的客户/供应商下拉：只回 id、code、name，没有邮箱、手机号。 */
  partners(kind: 'customer' | 'supplier', query: { q?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<PartnerRef>> {
    return this.api.request<EntityPage<PartnerRef>>({
      path: `reconciliation/partners?${searchOf({ kind, ...query })}`,
    });
  }
}
