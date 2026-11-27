import type { ApiClient } from '@nocobase/app-client';

import type { DocFile } from '#components/erp/doc-files';
import type { EntityPage } from '#components/erp/list-state';

/** R-065 第一片：支出记录与到票记录同构；端点直接回记录或一页，不包 `{ data }`。 */
export type FinanceStatus = 'draft' | 'confirmed' | 'void';
export type BindMode = 'purchase_order' | 'none';

export interface PersonSummary {
  readonly userId: string;
  readonly name: string;
}
export interface SupplierSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
export interface SupplierOption extends SupplierSummary {
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
}

export interface FinanceLine {
  readonly id: string;
  readonly recordId: string;
  readonly purchaseOrderId: string;
  readonly orderNo: string;
  readonly orderPayableAmount: number;
  readonly paidBefore: number;
  readonly invoicedBefore: number;
  readonly amount: number;
  readonly note: string | null;
}

export interface FinanceRecord {
  readonly id: string;
  readonly docNo: string;
  readonly expenseDate?: string;
  readonly invoiceDate?: string;
  readonly status: FinanceStatus;
  readonly expenseTypeCode?: string | null;
  readonly expenseTypeLabel?: string | null;
  readonly fundAccountCode?: string | null;
  readonly fundAccountLabel?: string | null;
  readonly invoiceTypeCode?: string | null;
  readonly invoiceTypeLabel?: string | null;
  readonly issuerName?: string | null;
  readonly invoiceNo?: string | null;
  readonly payeeName: string | null;
  readonly supplier: SupplierSummary | null;
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
  readonly bindMode: BindMode;
  readonly handler: PersonSummary | null;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly remark: string;
  readonly totalAmount: number;
  readonly confirmedAt: string | null;
  readonly voidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 列表行不带明细与附件。 */
  readonly lines: readonly FinanceLine[];
  readonly files: readonly DocFile[];
}

/** 财务读采购订单的窄形状：只有头上的金额与对方收款信息。 */
export interface PayableOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly orderDate: string;
  readonly status: string;
  readonly payableTotal: number | null;
  readonly paidAmount: number;
  readonly invoicedAmount: number;
  readonly unpaidAmount: number | null;
  readonly supplier: SupplierOption | null;
}

export interface FinanceListQuery {
  readonly status?: string;
  readonly supplierId?: string;
  readonly typeCode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** 与 `CreateExpenseBody` / `CreateInvoiceReceiptBody` 同形；金额两位小数由服务端算与校验。 */
export interface FinanceWriteFields {
  readonly status?: undefined;
  readonly bindMode: BindMode;
  readonly amount?: number;
  readonly lines?: readonly {
    readonly purchaseOrderId: string;
    readonly amount: number;
    readonly note?: string;
  }[];
  readonly expenseTypeCode?: string | null;
  readonly fundAccountCode?: string | null;
  readonly invoiceTypeCode?: string | null;
  readonly issuerName?: string | null;
  readonly invoiceNo?: string | null;
  readonly payeeName?: string | null;
  readonly supplierId?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly projectCode?: string | null;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
}

export interface CreateFinanceInput extends FinanceWriteFields {
  readonly expenseDate?: string;
  readonly invoiceDate?: string;
  /** 省略是草稿；true 时一步登记。 */
  readonly confirm?: boolean;
}

export interface UpdateFinanceInput extends Omit<FinanceWriteFields, 'bindMode'> {
  readonly expenseDate?: string;
  readonly invoiceDate?: string;
  readonly bindMode?: BindMode;
}

export class FinanceClient {
  constructor(private readonly api: ApiClient) {}

  list(kind: string, query: FinanceListQuery = {}): Promise<EntityPage<FinanceRecord>> {
    const search = new URLSearchParams();
    const typeKey =
      kind === 'expenses' ? 'expenseTypeCode' : 'invoiceTypeCode';
    for (const [key, value] of Object.entries({
      status: query.status,
      supplierId: query.supplierId,
      [typeKey]: query.typeCode,
      from: query.from,
      to: query.to,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
    })) {
      if (value !== undefined && value === '') continue;
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    return this.api.request<EntityPage<FinanceRecord>>({
      path: `${kind}?${search.toString()}`,
    });
  }

  get(kind: string, id: string): Promise<FinanceRecord> {
    return this.api.request<FinanceRecord>({
      path: `${kind}/${encodeURIComponent(id)}`,
    });
  }

  create(kind: string, input: CreateFinanceInput): Promise<FinanceRecord> {
    return this.api.request<FinanceRecord>({
      path: kind,
      method: 'POST',
      json: input,
    });
  }

  update(kind: string, id: string, input: UpdateFinanceInput): Promise<FinanceRecord> {
    return this.api.request<FinanceRecord>({
      path: `${kind}/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  async confirm(kind: string, id: string): Promise<FinanceRecord> {
    return this.api.request<FinanceRecord>({
      path: `${kind}/${encodeURIComponent(id)}/confirm`,
      method: 'POST',
    });
  }

  async void(kind: string, id: string): Promise<FinanceRecord> {
    return this.api.request<FinanceRecord>({
      path: `${kind}/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  /** 财务选采购订单：窄形状，没有明细、备注、单价、经办人。 */
  payable(
    query: { supplierId?: string; status?: string; q?: string; page?: number; pageSize?: number } = {},
  ): Promise<EntityPage<PayableOrder>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return this.api.request<EntityPage<PayableOrder>>({
      path: `purchase-orders/payable?${search.toString()}`,
    });
  }

  /** 到票页沿用支出页的供应商选项端点；持任一财务读动作即可。 */
  supplierOptions(q = ''): Promise<EntityPage<SupplierOption>> {
    return this.api.request<EntityPage<SupplierOption>>({
      path: `expenses/supplier-options?q=${encodeURIComponent(q)}`,
    });
  }
}
