import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import { apiClientToken } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import OrderLedgerPage from '../../client/pages/order-ledger/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** R-064 总台账页面：空段画横线、筛选只发端点支持的键、超期标记照服务端给的算。数据编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const emptySegment = { status: null, qty: null, total: null };
const ROW_EMPTY = {
  salesOrderId: 'o1',
  orderNo: 'XS-20261128-0001',
  orderDate: '2026-11-28',
  status: 'ordered',
  customer: { id: 'c1', code: 'CU001', name: 'Sample Customer' },
  projectCode: 'P1',
  projectLabel: 'Sample Project',
  handler: { userId: 'u1', name: 'Sample Salesperson' },
  baselineDate: null,
  review: {
    ...emptySegment,
    status: 'pending',
    confirmedDeliveryDate: null,
    reviewer: null,
  },
  purchase: emptySegment,
  production: emptySegment,
  receipt: emptySegment,
  shipping: emptySegment,
  payment: emptySegment,
  overdue: false,
  overdueDays: null,
  upcoming: false,
};
const ROW_OVERDUE = {
  ...ROW_EMPTY,
  salesOrderId: 'o2',
  orderNo: 'XS-20261128-0002',
  baselineDate: '2026-11-20',
  review: {
    ...emptySegment,
    status: 'done',
    confirmedDeliveryDate: '2026-11-20',
    reviewer: { userId: 'u2', name: 'Sample Planner' },
  },
  shipping: { status: 'partial', qty: 1, total: 3 },
  overdue: true,
  overdueDays: 8,
};

const reader: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    {
      resource: { type: 'composite', id: 'salesOrders' },
      actions: ['ledgerView'],
    },
  ],
};
const denied: AuthorizationSnapshot = { unrestricted: false, permissions: [] };

let permissions: AuthorizationSnapshot;
const api = vi.fn((call: ApiCall) => {
  if (call.path === 'authorization/permissions') return { data: permissions };
  if (call.path === 'sales-orders/ledger' && call.method === 'GET') {
    return { items: [ROW_EMPTY, ROW_OVERDUE], total: 2, page: 1, pageSize: 20 };
  }
  return new Response(null, { status: 404 });
});

const getSession = vi.fn(async () => ({ data: null }));

async function renderLedger(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/order-ledger' element={<OrderLedgerPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: '/order-ledger',
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

const ledgerCalls = (): ApiCall[] =>
  api.mock.calls.map(([call]) => call)
    .filter((call) => call.method === 'GET' && call.path === 'sales-orders/ledger');

describe('order ledger page (R-064)', () => {
  it('renders no-source segments as a dash, never as zero', async () => {
    api.mockClear();
    await renderLedger(reader);
    const row = await screen.findByText(ROW_EMPTY.orderNo, {}, WAIT).then(
      (node) => node.closest('tr') as HTMLElement,
    );
    expect(await within(row).findAllByText('—', {}, WAIT).then((nodes) => nodes.length)).toBeGreaterThanOrEqual(4);
    await waitFor(() => {
      expect(within(row).queryByText('0')).not.toBeInTheDocument();
      expect(within(row).getByText('Sample Salesperson')).toBeVisible();
    }, WAIT);
  });

  it('sends only the endpoint filters and the overdue marker from the response', async () => {
    api.mockClear();
    await renderLedger(reader);
    await screen.findByText(ROW_OVERDUE.orderNo, {}, WAIT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: enUS.erp.list.filters }, WAIT));
    await user.click(
      await screen.findByRole('combobox', { name: enUS.orderLedger.filter.reviewStatus }, WAIT),
    );
    await user.click(await screen.findByRole('option', { name: enUS.orderLedger.done }, WAIT));

    await waitFor(
      () => expect(ledgerCalls().at(-1)?.query?.reviewStatus).toBe('done'),
      WAIT,
    );
    const project = await screen.findByRole('textbox', {
      name: enUS.orderLedger.filter.projectCode,
    }, WAIT);
    await user.type(project, 'P1{Enter}');
    await waitFor(() => expect(ledgerCalls().at(-1)?.query?.projectCode).toBe('P1'), WAIT);
    expect(ledgerCalls().at(-1)?.query).not.toHaveProperty('handlerUserId');
    expect(ledgerCalls().at(-1)?.query).not.toHaveProperty('deliveryFrom');

    const overdueCell = await screen.findByTestId(`ledger-baseline-${ROW_OVERDUE.salesOrderId}`, {}, WAIT);
    expect(overdueCell).toHaveAttribute('data-overdue', 'true');
    expect(overdueCell).toHaveAttribute(
      'title',
      enUS.orderLedger.overdueDays.replace('{{days}}', '8'),
    );
  });

  it('fetches nothing without ledgerView', async () => {
    api.mockClear();
    await renderLedger(denied);
    await waitFor(() => expect(api.mock.calls.some(([call]) => call.path === 'authorization/permissions')).toBe(true), WAIT);
    expect(ledgerCalls()).toHaveLength(0);
  });
});
