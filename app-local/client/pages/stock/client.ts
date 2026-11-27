import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

/** 一行现存量，与 R-020 的 `Balance` 逐列对应：物料、仓库、批号一个组合一行。 */
export interface Balance {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qty: number;
}

/** 一行流水，与 R-020 的 `Transaction` 逐列对应。入库为正、出库为负。 */
export interface Transaction {
  readonly id: string;
  readonly docId: string;
  readonly docLineId: string;
  readonly docNo: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchNo: string;
  readonly qtyDelta: number;
  readonly balanceAfter: number;
  readonly at: string;
  readonly byUserId: string;
}

export interface BalanceQuery {
  readonly itemId?: string;
  readonly warehouseId?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface TransactionQuery {
  readonly itemId?: string;
  readonly warehouseId?: string;
  /** 带时区的 ISO 时间串，按过账时刻过滤，含端点。 */
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

const searchOf = (query: object): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

/** R-020 的现存量与流水两个只读端点。 */
export class StockClient {
  constructor(private readonly api: ApiClient) {}

  balances(query: BalanceQuery = {}): Promise<EntityPage<Balance>> {
    return this.api.request<EntityPage<Balance>>({
      path: `stock/balances?${searchOf(query)}`,
    });
  }

  transactions(query: TransactionQuery = {}): Promise<EntityPage<Transaction>> {
    return this.api.request<EntityPage<Transaction>>({
      path: `stock/transactions?${searchOf(query)}`,
    });
  }
}
