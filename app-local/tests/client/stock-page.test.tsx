import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken } from '@nocobase/app-client';
import { act, screen, waitFor } from '@testing-library/react';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import StockPage from '../../client/pages/stock/index.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-020 库存查询（《基座ERP前端设计》3.3）：现存量、流水两个标签，只读。
 * 行里只有物料与仓库的标识，页面另取两个列表来对名字（设计第六节第 2 条）。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const permission = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const keeper: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    permission('inventory', ['stockView', 'warehouseView']),
    permission('items', ['view']),
  ],
};
/** 有仓库读、没有 inventory.stockView：现存量与流水都不该去取。 */
const noStockView: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [permission('inventory', ['warehouseView'])],
};
const notFound = () => new Response(null, { status: 404 });

const at = '2026-11-27T10:30:00.000Z';
const item = {
  id: 'i1',
  code: 'M001',
  name: 'Sample Sheet Metal',
  spec: '1.5mm',
  itemType: 'material',
  categoryCode: 'RAW',
  unitCode: 'KG',
  status: 'active',
  legacyCode: null,
  note: null,
  createdById: 'u1',
  createdAt: at,
  updatedAt: at,
};
const warehouse = {
  id: 'w1',
  code: 'WH01',
  name: 'Sample Warehouse',
  status: 'active',
  note: '',
  createdAt: at,
  updatedAt: at,
};
const balance = {
  itemId: 'i1',
  warehouseId: 'w1',
  batchNo: 'B01',
  qty: 1234.5,
};
const transaction = {
  id: 't1',
  docId: 'd1',
  docLineId: 'l1',
  docNo: 'IN-20261127-0001',
  itemId: 'i1',
  warehouseId: 'w1',
  batchNo: 'B01',
  qtyDelta: 120,
  balanceAfter: 1234.5,
  at,
  byUserId: 'u1',
};
const pageOf = <T,>(items: readonly T[]) => ({
  items: [...items],
  total: items.length,
  page: 1,
  pageSize: 20,
});

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions'
    ? { data: permissions }
    : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/stock' element={<StockPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
        app.container.singleton(
          authorizationClientToken,
          (resolver) =>
            new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

const gets = (path: string) =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === 'GET' && call.path === path);

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-020 库存查询', () => {
  it('lists on-hand quantities with item and warehouse names resolved', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock/balances')
        return pageOf([balance]);
      if (call.method === 'GET' && call.path === 'items')
        return pageOf([item]);
      if (call.method === 'GET' && call.path === 'warehouses')
        return pageOf([warehouse]);
      return notFound();
    };
    await renderAt('/stock', keeper);

    expect(await screen.findByText('Sample Sheet Metal', {}, WAIT)).toBeVisible();
    for (const text of ['M001', '1.5mm', 'KG', 'Sample Warehouse', 'B01']) {
      expect(await screen.findByText(text, {}, WAIT)).toBeVisible();
    }
    expect(await screen.findByText('1,234.5', {}, WAIT)).toBeVisible();
    expect(gets('stock/balances').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);
    // 只取第一页的物料与仓库来对名字，不下钻每一行。
    expect(gets('items').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '100' },
    ]);
    expect(gets('warehouses').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '100' },
    ]);
    // 只读：页头没有主按钮，行尾没有操作。
    expect(
      screen.queryByRole('button', { name: /^Actions for/ }),
    ).not.toBeInTheDocument();
  });

  it('switches to the ledger and links each entry back to its document', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock/transactions')
        return pageOf([transaction]);
      if (call.method === 'GET' && call.path === 'items')
        return pageOf([item]);
      if (call.method === 'GET' && call.path === 'warehouses')
        return pageOf([warehouse]);
      return notFound();
    };
    await renderAt('/stock', keeper);
    await screen.findByRole('tab', { name: 'On hand' }, WAIT);

    await userEvent.click(screen.getByRole('tab', { name: 'Ledger' }));

    expect(
      await screen.findByRole('link', { name: 'IN-20261127-0001' }, WAIT),
    ).toHaveAttribute('href', '/inbound-orders/d1');
    expect(
      await screen.findByText('Inbound order', {}, WAIT),
    ).toBeInTheDocument();
    // 收入为正、发出留空，结存是过账后的数量。
    expect(await screen.findByText('+120', {}, WAIT)).toBeVisible();
    expect(await screen.findByText('1,234.5', {}, WAIT)).toBeVisible();
    expect(gets('stock/transactions').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);
  });

  it('narrows the ledger by warehouse from the expanded filter row', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock/transactions')
        return pageOf([transaction]);
      if (call.method === 'GET' && call.path === 'warehouses')
        return pageOf([warehouse]);
      return notFound();
    };
    await renderAt('/stock', keeper);
    await screen.findByRole('tab', { name: 'Ledger' }, WAIT);
    await userEvent.click(screen.getByRole('tab', { name: 'Ledger' }));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Filters' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Warehouse' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Sample Warehouse' }, WAIT),
    );

    await waitFor(() =>
      expect(gets('stock/transactions').at(-1)?.query).toEqual({
        warehouseId: 'w1',
        page: '1',
        pageSize: '20',
      }),
    );
  });

  it('someone without inventory.stockView sends no request and sees no quantities', async () => {
    const { app } = await renderAt('/stock', noStockView);
    await act(async () => {
      await app.container.resolve(authorizationClientToken).snapshot();
    });

    expect(gets('stock/balances')).toEqual([]);
    expect(gets('stock/transactions')).toEqual([]);
    expect(screen.queryByText('B01')).not.toBeInTheDocument();
  });
});
