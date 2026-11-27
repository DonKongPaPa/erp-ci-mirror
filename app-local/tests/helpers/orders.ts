import { randomUUID } from 'node:crypto';

import type { TestSession } from '@nocobase/app-plugin-authentication/testing';

/** R-021/R-022 的测试夹具：往来单位、仓库、订单，都是真库里的真行。 */
export interface Row {
  [key: string]: unknown;
}
export type JsonBody = Row & {
  items?: Row[];
  lines?: Row[];
  total?: number;
  error?: { reason: string };
};

export const ORIGIN = 'http://localhost';

export const unique = (prefix: string): string =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;

export const write = (body: unknown = {}, method = 'POST'): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

export const get = (): RequestInit => ({ method: 'GET' });

export const jsonOf = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

export async function createPartner(
  session: TestSession,
  flags: { isCustomer?: boolean; isSupplier?: boolean } = { isSupplier: true },
): Promise<Row> {
  const response = await session.fetch('/partners', write({
    name: unique('往来'),
    ...flags,
  }));
  if (response.status !== 201) {
    throw new Error(`建往来单位失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}

export async function createWarehouse(session: TestSession): Promise<Row> {
  const response = await session.fetch('/warehouses', write({
    code: unique('WH'),
    name: '订单测试仓',
  }));
  if (response.status !== 201) {
    throw new Error(`建仓库失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}

/** 返回一个默认草稿订单；覆盖字段用 override 传入。 */
export async function createOrder(
  session: TestSession,
  kind: 'purchase' | 'sales',
  override: Row = {},
): Promise<Row> {
  const path = kind === 'purchase' ? '/purchase-orders' : '/sales-orders';
  const partner = await createPartner(session, kind === 'purchase'
    ? { isSupplier: true }
    : { isCustomer: true });
  const body = {
    ...(kind === 'purchase' ? { supplierId: partner.id } : { customerId: partner.id }),
    orderDate: '2026-11-27',
    remark: '订单测试',
    lines: [],
    ...override,
  };
  const response = await session.fetch(path, write(body));
  if (response.status !== 201) {
    throw new Error(`建订单失败：${response.status} ${await response.text()}`);
  }
  return await jsonOf(response);
}
