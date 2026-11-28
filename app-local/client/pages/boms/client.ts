import type { ApiClient } from '@nocobase/app-client';

import type { EntityPage } from '#components/erp/list-state';

/**
 * R-019 波 2 BOM 端点的客户端。端点直接回对象或一页，没有 `{ data }` 外层。
 * 金额列由服务端按 `items.viewPurchasePrice` 裁掉：没有键就没有列，页面不画空列。
 */

export type BomStatus = 'active' | 'inactive';

export interface BomItemSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly unitCode: string;
}

export interface BomLineItem extends BomItemSummary {
  readonly brand: string | null;
  readonly manufacturerModel: string | null;
}

export interface BomLine {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly qty: number;
  readonly lossRate: number;
  readonly childBomId: string | null;
  readonly note: string | null;
  readonly item: BomLineItem;
}

export interface BomFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

export interface Bom {
  readonly id: string;
  readonly docNo: string;
  readonly version: string;
  readonly product: BomItemSummary;
  readonly isDefault: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly dailyOutput: number | null;
  readonly status: BomStatus;
  readonly remark: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly BomLine[];
  readonly files: readonly BomFile[];
}

/** 列表行不带配件行与附件。 */
export type BomSummary = Omit<Bom, 'lines' | 'files'>;

export interface BomListQuery {
  readonly productId?: string;
  readonly status?: BomStatus;
  readonly page: number;
  readonly pageSize: number;
}

export interface BomLineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly lossRate?: number;
  readonly childBomId?: string;
  readonly note?: string | null;
}

export interface CreateBomInput {
  readonly version: string;
  readonly productId: string;
  readonly isDefault?: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly dailyOutput?: number | null;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines: readonly BomLineInput[];
}

export interface UpdateBomInput {
  readonly version?: string;
  readonly isDefault?: boolean;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly dailyOutput?: number | null;
  readonly status?: BomStatus;
  readonly remark?: string;
  readonly fileIds?: readonly string[];
  readonly lines?: readonly BomLineInput[];
}

export interface ExplodeNode {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly bomId: string;
  readonly docNo: string;
  readonly version: string;
  readonly itemId: string;
  readonly item: BomItemSummary;
  readonly qtyPerUnit: number;
  readonly lossRate: number;
  readonly effectiveQty: number;
  readonly depth: number;
}

/** 有价格动作时 totals 行才多出两个键；没有时这两个键不出现。 */
export interface ExplodeTotal {
  readonly itemId: string;
  readonly code: string;
  readonly name: string;
  readonly unitCode: string;
  readonly qty: number;
  readonly basePurchasePrice?: number | null;
  readonly estimatedCost?: number | null;
}

export interface ExplodeResult {
  readonly productId: string;
  readonly asOf: string;
  readonly levels: number;
  readonly root: {
    readonly bomId: string;
    readonly docNo: string;
    readonly version: string;
    readonly productId: string;
    readonly isDefault: boolean;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  };
  readonly nodes: readonly ExplodeNode[];
  readonly totals: readonly ExplodeTotal[];
  readonly cycles: readonly string[][];
}

function searchOf(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export class BomsClient {
  constructor(private readonly api: ApiClient) {}

  list(query: BomListQuery): Promise<EntityPage<BomSummary>> {
    return this.api.request<EntityPage<BomSummary>>({
      path: `boms?${searchOf(query)}`,
    });
  }

  detail(id: string): Promise<Bom> {
    return this.api.request<Bom>({ path: `boms/${encodeURIComponent(id)}` });
  }

  create(input: CreateBomInput): Promise<Bom> {
    return this.api.request<Bom>({
      path: 'boms',
      method: 'POST',
      json: input,
    });
  }

  update(id: string, input: UpdateBomInput): Promise<Bom> {
    return this.api.request<Bom>({
      path: `boms/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  void(id: string): Promise<Bom> {
    return this.api.request<Bom>({
      path: `boms/${encodeURIComponent(id)}/void`,
      method: 'POST',
    });
  }

  explode(productId: string, asOf: string, levels: '1' | 'all'): Promise<ExplodeResult> {
    const query = searchOf({ productId, asOf, levels });
    return this.api.request<ExplodeResult>({ path: `boms/explode?${query}` });
  }
}
