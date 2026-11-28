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
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import InboundOrdersPage from '../../client/pages/inbound-orders/index.js';
import InboundOrderNewPage from '../../client/pages/inbound-orders/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-070：仓管建采购入库单时从检验单选可入库行。请求体带 inspectionId 与
 * inspectionLineId；不带检验键的普通入库请求逐字节照旧（由既有测试钉住）。
 */
const T = 15_000;
const WAIT = { timeout: T };
const at = '2026-11-28T10:30:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const pageOf = <T,>(items: readonly T[]) => ({
  items: [...items], total: items.length, page: 1, pageSize: 20,
});
const permission = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id }, actions,
});
const keeper: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    permission('inventory', ['stockView', 'stockWrite', 'warehouseView']),
    permission('items', ['view']),
    permission('purchaseOrders', ['receive']),
    permission('inspectionOrders', ['receiveView']),
  ],
};
const noNarrow: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    permission('inventory', ['stockView', 'stockWrite', 'warehouseView']),
    permission('items', ['view']),
    permission('purchaseOrders', ['receive']),
  ],
};
const item = {
  id: 'i1', code: 'M001', name: 'Sample Sheet Metal', spec: '1.5mm',
  itemType: 'material', categoryCode: 'RAW', unitCode: 'KG', status: 'active',
  legacyCode: null, note: null, createdById: 'u1', createdAt: at, updatedAt: at,
};
const warehouse = {
  id: 'w1', code: 'WH01', name: 'Sample Warehouse', status: 'active',
  note: '', createdAt: at, updatedAt: at,
};
const receivable = {
  id: 'ins1', docNo: 'JY-20261128-0001', inspectionDate: '2026-11-28',
  status: 'partial', purchaseOrderId: 'po1',
  lines: [{
    inspectionLineId: 'il1', itemId: 'i1', warehouseId: 'w1', batchNo: '',
    releasableQty: 7, remainQty: 7,
  }],
};
const saved = {
  id: 'd1', docNo: 'RK-20261128-0001', docType: 'in', reason: 'purchase_receipt',
  status: 'draft', remark: '', sourceType: 'purchase_order', sourceId: 'po1',
  inspectionId: 'ins1', createdById: 'u1', postedAt: null, postedById: null,
  createdAt: at, updatedAt: at, lines: [],
};

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions' ? { data: permissions } : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid='location'>{location.pathname}</span>;
}

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/inbound-orders' element={<InboundOrdersPage />}>
          <Route path='new' element={<InboundOrderNewPage />} />
        </Route>
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
          (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

const calls = (method: string, path: string): ApiCall[] =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === method && call.path === path);

beforeEach(() => {
  sessionStorage.clear();
  api.mockClear();
  getSession.mockClear();
  answer = (call: ApiCall) => {
    if (call.method === 'GET' && call.path === 'stock-docs') return pageOf([]);
    if (call.method === 'GET' && call.path === 'items') return pageOf([item]);
    if (call.method === 'GET' && call.path === 'warehouses') return pageOf([warehouse]);
    if (call.method === 'GET' && call.path === 'inspections/receivable-options')
      return pageOf([receivable]);
    return notFound();
  };
});

describe('R-070 入库建单带检验单', () => {
  it('采购入库从检验单选行：请求体带 inspectionId 与 inspectionLineId', async () => {
    const user = userEvent.setup();
    answer = (call: ApiCall) => {
      if (call.method === 'GET' && call.path === 'stock-docs') return pageOf([]);
      if (call.method === 'GET' && call.path === 'items') return pageOf([item]);
      if (call.method === 'GET' && call.path === 'warehouses') return pageOf([warehouse]);
      if (call.method === 'GET' && call.path === 'inspections/receivable-options')
        return pageOf([receivable]);
      if (call.method === 'POST' && call.path === 'stock-docs') return saved;
      return notFound();
    };
    await renderAt('/inbound-orders/new', keeper);
    await screen.findByRole('heading', { name: 'New inbound order' }, WAIT);

    // 默认类型是 other_in，先改成采购入库才露出检验单入口。
    await user.click(
      await screen.findByRole('combobox', { name: enUS.stockDocs.fields.reason }, WAIT),
    );
    await user.click(
      await screen.findByRole('option', { name: enUS.stockDocs.reasons.purchase_receipt }, WAIT),
    );

    await user.click(
      await screen.findByRole('button', { name: enUS.stockDocs.pickInspection }, WAIT),
    );
    expect(
      await screen.findByRole('columnheader', { name: enUS.stockDocs.pickInspectionDocNo }, WAIT),
    ).toBeVisible();
    await user.click(
      await screen.findByRole('button', {
        name: enUS.stockDocs.pickInspectionLine.replace('{{docNo}}', receivable.docNo),
      }, WAIT),
    );

    // 尚可入库数量 7 填进数量；「已占用」已由服务端从 remainQty 里扣掉。
    expect(
      await screen.findByRole('textbox', { name: 'Quantity, line 1' }, WAIT),
    ).toHaveValue('7');
    await user.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    await waitFor(() => expect(calls('POST', 'stock-docs')).toHaveLength(1), WAIT);
    const body = calls('POST', 'stock-docs')[0]?.json as Record<string, unknown>;
    expect(body).toMatchObject({
      docType: 'in',
      reason: 'purchase_receipt',
      sourceType: 'purchase_order',
      sourceId: 'po1',
      inspectionId: 'ins1',
    });
    expect(body.lines).toEqual([expect.objectContaining({
      itemId: 'i1', warehouseId: 'w1', qty: 7, inspectionLineId: 'il1',
    })]);
  });

  it('没有窄读动作时不画检验单入口', async () => {
    await renderAt('/inbound-orders/new', noNarrow);
    await screen.findByRole('heading', { name: 'New inbound order' }, WAIT);
    expect(
      screen.queryByRole('button', { name: enUS.stockDocs.pickInspection }),
    ).not.toBeInTheDocument();
  });
});
