import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

import type { ReturnKindDef } from './page-id.js';

/** 与服务端 `returns-schemas.ts` 逐列对应；端点直接回对象或一页，没有 `{ data }` 外层。 */
export type ReturnStatus = 'draft' | 'posted' | 'void';
export type ReturnSourceType = 'stock_doc' | 'order';

export interface Ref {
  readonly id: string;
  readonly name: string;
}
export interface Partner {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
export interface Person {
  readonly userId: string;
  readonly name: string;
}
export interface ItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}
export interface DocFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface ReturnLine {
  readonly id: string;
  readonly sourceLineId: string | null;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  /** 来源行数量的快照，页面只读。 */
  readonly qty: number;
  readonly returnQty: number;
  /** 这一行尚可退的数量，页面只回显、不自行推算。 */
  readonly remainQty: number;
  readonly note: string | null;
  readonly item: ItemSummary;
}

export interface ReturnDoc {
  readonly id: string;
  readonly docNo: string;
  readonly docType: 'purchase' | 'sales';
  readonly sourceType: ReturnSourceType;
  readonly sourceId: string;
  readonly status: ReturnStatus;
  readonly partner: Partner | null;
  readonly handler: Person | null;
  readonly warehouse: Ref | null;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly ReturnLine[];
  readonly files?: readonly DocFile[];
}

/** 列表行不带明细与附件；服务端若带了也不影响页面。 */
export type ReturnSummary = Omit<ReturnDoc, 'lines' | 'files'> & {
  readonly lines?: readonly ReturnLine[];
};

export interface ReturnListQuery {
  readonly status?: ReturnStatus;
  readonly partnerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** 新建时可选的来源单据，明细行带仓库、批次与尚可退数量。 */
export interface SourceLineOption {
  readonly sourceLineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly remainQty: number;
}
export interface SourceOption {
  readonly id: string;
  readonly docNo: string;
  readonly docDate: string | null;
  readonly partner: Partner | null;
  readonly lines: readonly SourceLineOption[];
}

/** 财务的窄形状：没有备注、单价、经办人。页面不补这些键。 */
export interface FinanceOption {
  readonly id: string;
  readonly docNo: string;
  readonly returnDate: string | null;
  readonly status: ReturnStatus;
  readonly customerId: string | null;
  readonly lines: readonly { readonly itemId: string; readonly qty: number }[];
}

export interface ReturnLineInput {
  readonly sourceLineId: string;
  readonly returnQty: number;
  readonly warehouseId?: string;
  readonly note?: string;
}
export interface CreateReturnInput {
  readonly sourceType: ReturnSourceType;
  readonly sourceId: string;
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly ReturnLineInput[];
}
export interface UpdateReturnInput {
  readonly handlerUserId?: string | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly ReturnLineInput[];
}

export interface PostResult {
  readonly returnDoc: ReturnDoc;
  readonly stockDocId: string;
}

/** 出入库列表按 returnDocId 反查出来的生成单摘要。 */
export interface GeneratedDocSummary {
  readonly id: string;
  readonly docNo: string;
  readonly docType: 'in' | 'out';
  readonly reason: string;
  readonly status: string;
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export class ReturnsClient {
  constructor(
    private readonly api: ApiClient,
    private readonly def: ReturnKindDef,
  ) {}

  list(query: ReturnListQuery = {}): Promise<EntityPage<ReturnSummary>> {
    return this.api.request<EntityPage<ReturnSummary>>({
      path: `${this.def.api}?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<ReturnDoc> {
    return this.api.request<ReturnDoc>({
      path: `${this.def.api}/${encodeURIComponent(id)}`,
    });
  }

  sourceOptions(query: { q?: string; partnerId?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<SourceOption>> {
    return this.api.request<EntityPage<SourceOption>>({
      path: `${this.def.api}/source-options?${searchOf(query)}`,
    });
  }

  /** 只有销售退货有财务窄读端点；调用方按 financeView 动作守门。 */
  financeOptions(query: { q?: string; customerId?: string; page?: number; pageSize?: number } = {}): Promise<EntityPage<FinanceOption>> {
    return this.api.request<EntityPage<FinanceOption>>({
      path: `sales-returns/finance-options?${searchOf(query)}`,
    });
  }

  create(input: CreateReturnInput): Promise<ReturnDoc> {
    return this.api.request<ReturnDoc>({
      path: this.def.api,
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateReturnInput): Promise<ReturnDoc> {
    return this.api.request<ReturnDoc>({
      path: `${this.def.api}/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  post(id: string): Promise<PostResult> {
    return this.api.request<PostResult>({
      path: `${this.def.api}/${encodeURIComponent(id)}/post`,
      method: 'POST',
    });
  }

  /** 作废原因由页面必填；服务端把它附在备注里留痕（见合并请求正文）。 */
  voidDoc(id: string, reason: string): Promise<ReturnDoc> {
    return this.api.request<ReturnDoc>({
      path: `${this.def.api}/${encodeURIComponent(id)}/void`,
      method: 'POST',
      json: { reason },
    });
  }

  /** 详情里按 returnDocId 反查过账生成的那张出入库单。 */
  generatedDocs(id: string): Promise<EntityPage<GeneratedDocSummary>> {
    return this.api.request<EntityPage<GeneratedDocSummary>>({
      path: `stock-docs?${searchOf({ returnDocId: id, docType: this.def.generatedDocType, pageSize: 100 })}`,
    });
  }
}
