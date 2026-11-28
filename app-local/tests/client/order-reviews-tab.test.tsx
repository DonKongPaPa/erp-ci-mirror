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
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';

import enUS from '../../client/locales/en-US.js';
import SalesOrderDetailPage from '../../client/pages/sales-orders/detail/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** R-064 评审页签：显隐按会话实际动作，提交体按设计逐键钉住。全部数据编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-28T08:00:00.000Z';
const ORDER = {
  id: 'o1',
  orderNo: 'XS-20261128-0001',
  status: 'ordered',
  orderDate: '2026-11-28',
  remark: 'Sample remark',
  submittedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  customerId: 'c1',
  customer: { id: 'c1', code: 'CU001', name: 'Sample Customer', status: 'active' },
  lines: [
    { id: 'l1', itemId: 'i1', qty: 2, price: 3, shippedQty: 0, remainingQty: 2 },
  ],
};
const ITEM = {
  id: 'i1', code: 'M1', name: 'Sample Material', spec: null,
  itemType: 'material', categoryCode: null, unitCode: 'KG', status: 'active',
};
const REVIEW = {
  id: 'r1',
  salesOrderId: 'o1',
  status: 'submitted',
  reviewer: { userId: 'u1', name: 'Sample Planner' },
  reviewedAt: NOW,
  confirmedDeliveryDate: null,
  confirmedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  lines: [],
};
const CONFIRMED = {
  ...REVIEW,
  id: 'r0',
  status: 'confirmed',
  confirmedDeliveryDate: '2026-12-20',
};
const PERSONS = {
  items: [{ userId: 'u1', name: 'Sample Planner', departmentId: null, departmentName: null }],
  total: 1,
};

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const base: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('salesOrders', ['view']),
    grant('items', ['view']),
    grant('inventory', ['warehouseView']),
  ],
};
const planner: AuthorizationSnapshot = {
  ...base,
  permissions: [
    ...base.permissions,
    grant('orderReviews', ['view', 'create', 'update', 'submit', 'confirm', 'void']),
    grant('bizOptions', ['view']),
  ],
};
const sales: AuthorizationSnapshot = {
  ...base,
  permissions: [...base.permissions, grant('orderReviews', ['view'])],
};

let permissions: AuthorizationSnapshot;
let reviews: readonly Record<string, unknown>[];
const api = vi.fn((call: ApiCall) => {
  if (call.path === 'authorization/permissions') return { data: permissions };
  if (call.path === 'sales-orders/o1') return ORDER;
  if (call.path === 'items') {
    return { items: [ITEM], total: 1, page: 1, pageSize: 100 };
  }
  if (call.path === 'warehouses') {
    return { items: [], total: 0, page: 1, pageSize: 100 };
  }
  if (call.path === 'person-options') return PERSONS;
  if (call.path === 'order-reviews' && call.method === 'GET') {
    return { items: reviews, total: reviews.length, page: 1, pageSize: 100 };
  }
  if (call.path.startsWith('order-reviews/')) {
    if (call.method === 'POST') {
      return { ...REVIEW, ...((call.json ?? {}) as Record<string, unknown>) };
    }
    return reviews.find((row) => `order-reviews/${row.id}` === call.path) ?? null;
  }
  if (call.path === 'order-reviews' && call.method === 'POST') {
    return { ...REVIEW, ...(call.json as Record<string, unknown>) };
  }
  return new Response(null, { status: 404 });
});
const getSession = vi.fn(async () => ({ data: null }));

async function renderDetail(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/sales-orders/:salesOrderId' element={<SalesOrderDetailPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: '/sales-orders/o1',
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
  api.mock.calls.map(([call]) => call)
    .filter((call) => call.method === method && call.path === path);

describe('sales order review tab (R-064)', () => {
  beforeEach(() => {
    api.mockClear();
    reviews = [REVIEW];
  });

  it('hides the tab from a session without orderReviews.view', async () => {
    await renderDetail(base);
    await screen.findByText(ORDER.orderNo, {}, WAIT);
    expect(screen.queryByTestId('order-review-tab-trigger')).not.toBeInTheDocument();
    expect(calls('GET', 'order-reviews')).toHaveLength(0);
  });

  it('shows the tab and sends all five factors plus the reviewer in create body', async () => {
    await renderDetail(planner);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('order-review-tab-trigger', {}, WAIT));
    await screen.findByTestId('order-review-tab', {}, WAIT);
    await user.click(screen.getByRole('button', { name: enUS.orderReviews.new }));
    const dialog = await screen.findByTestId('order-review-create-dialog', {}, WAIT);

    await user.click(within(dialog).getByRole('combobox', { name: enUS.orderReviews.reviewer }));
    await user.click(await screen.findByRole('option', { name: 'Sample Planner' }, WAIT));
    for (const factor of ['man', 'machine', 'material', 'method', 'environment'] as const) {
      await user.type(
        within(dialog).getByRole('textbox', { name: enUS.orderReviews.factor[factor] }),
        `Conclusion ${factor}`,
      );
    }
    await user.click(within(dialog).getByRole('button', { name: enUS.orderReviews.create }));

    await waitFor(() => expect(calls('POST', 'order-reviews')).toHaveLength(1), WAIT);
    expect(calls('POST', 'order-reviews')[0].json).toEqual({
      salesOrderId: 'o1',
      reviewerUserId: 'u1',
      lines: [
        { factor: 'man', conclusion: 'Conclusion man' },
        { factor: 'machine', conclusion: 'Conclusion machine' },
        { factor: 'material', conclusion: 'Conclusion material' },
        { factor: 'method', conclusion: 'Conclusion method' },
        { factor: 'environment', conclusion: 'Conclusion environment' },
      ],
    });
  });

  it('sends only the confirmed delivery date on confirm', async () => {
    await renderDetail(planner);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('order-review-tab-trigger', {}, WAIT));
    await user.click(await screen.findByRole('button', { name: enUS.orderReviews.confirm }, WAIT));
    const dialog = await screen.findByTestId('order-review-confirm-dialog', {}, WAIT);
    await user.type(
      within(dialog).getByLabelText(enUS.orderReviews.confirmedDeliveryDate),
      '2026-12-01',
    );
    await user.click(within(dialog).getByRole('button', { name: enUS.orderReviews.confirmAction }));

    await waitFor(
      () => expect(calls('POST', 'order-reviews/r1/confirm')).toHaveLength(1),
      WAIT,
    );
    expect(calls('POST', 'order-reviews/r1/confirm')[0].json).toEqual({
      confirmedDeliveryDate: '2026-12-01',
    });
  });

  it('warns that re-review voids the current confirmed review', async () => {
    reviews = [CONFIRMED, REVIEW];
    await renderDetail(planner);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('order-review-tab-trigger', {}, WAIT));
    await user.click(await screen.findByRole('button', { name: enUS.orderReviews.reReview }, WAIT));
    expect(
      await screen.findByTestId('order-review-re-review-warning', {}, WAIT),
    ).toHaveTextContent(enUS.orderReviews.reReviewWarning);
  });

  it('shows the returned delivery date to a sales reader with no write actions', async () => {
    reviews = [{ ...CONFIRMED, lines: REVIEW.lines }];
    await renderDetail(sales);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('order-review-tab-trigger', {}, WAIT));
    const detail = await screen.findByTestId('order-review-detail', {}, WAIT);
    await waitFor(() => expect(detail).toHaveTextContent('2026-12-20'), WAIT);
    expect(screen.queryByRole('button', { name: enUS.orderReviews.new })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.orderReviews.confirm })).not.toBeInTheDocument();
  });
});
