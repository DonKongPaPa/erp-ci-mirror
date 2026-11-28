import { apiClientToken } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import { Dashboard } from '../../client/pages/home/dashboard.js';
import HomePage from '../../client/pages/home/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const T = 15_000;
const WAIT = { timeout: T };
const granted: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'page', id: 'purchaseOrders' }, actions: ['access'] },
    { resource: { type: 'page', id: 'purchaseRequests' }, actions: ['access'] },
    {
      resource: { type: 'composite', id: 'salesOrders' },
      actions: ['ledgerView'],
    },
  ],
};
const restricted: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'page', id: 'purchaseOrders' }, actions: ['access'] },
  ],
};
const root: AuthorizationSnapshot = { unrestricted: true, permissions: [] };

const calls: ApiCall[] = [];
let permissions: AuthorizationSnapshot;

function fetchAnswers(call: ApiCall) {
  calls.push(call);
  if (call.path === 'authorization/permissions') return { data: permissions };
  if (call.path.startsWith('approvals/')) return { items: [], total: 0 };
  return new Response(null, { status: 404 });
}

function registerAuthorization(app: { container: { singleton: (...args: unknown[]) => unknown } }) {
  // The test application provides the API client; this test supplies the real authorization client with a fixture snapshot.
  app.container.singleton(
    authorizationClientToken,
    (resolver: { resolve: (token: unknown) => unknown }) =>
      new AuthorizationClient(resolver.resolve(apiClientToken) as never),
  );
}

async function renderDashboard(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  calls.length = 0;
  return renderWithApp(<Dashboard roleKey='purchase' />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(fetchAnswers),
    services: registerAuthorization,
  });
}

async function renderHome(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  calls.length = 0;
  return renderWithApp(<HomePage />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(fetchAnswers),
    services: registerAuthorization,
  });
}

function renderControlledDashboard(snapshot: AuthorizationSnapshot, ui: ReactNode) {
  permissions = snapshot;
  calls.length = 0;
  return renderWithApp(ui, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(fetchAnswers),
    services: registerAuthorization,
  });
}

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
});

describe('home workbench (R-086)', () => {
  it('opens on a workbench, not the framework introduction', async () => {
    await renderHome(root);
    expect(
      await screen.findByRole('button', { name: enUS.dashboard.adjust }, WAIT),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: enUS.dashboard.widgets.quickActions }),
    ).toBeVisible();
    expect(screen.queryByText(enUS.home.title)).not.toBeInTheDocument();
  });

  it('renders only quick actions the viewer is authorized to use', async () => {
    await renderDashboard(granted);
    expect(
      await screen.findByRole(
        'link',
        { name: enUS.dashboard.quick.newPurchaseOrder },
        WAIT,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: enUS.dashboard.quick.newPurchaseRequest }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: enUS.dashboard.quick.orderReview }),
    ).not.toBeInTheDocument();
    expect(calls.some((call) => call.path.includes('order-ledger'))).toBe(false);
  });

  it('drops preference entries the role does not allow and widgets whose condition is denied', async () => {
    await renderControlledDashboard(
      restricted,
      <Dashboard
        roleKey='purchase'
        preference={{
          widgets: [
            { id: 'inventoryShortcuts', collapsed: false },
            { id: 'deliveryReminders', collapsed: false },
            { id: 'quickActions', collapsed: false },
          ],
        }}
      />,
    );
    expect(
      await screen.findByText(enUS.dashboard.widgets.quickActions, {}, WAIT),
    ).toBeVisible();
    expect(
      screen.queryByText(enUS.dashboard.widgets.inventoryShortcuts),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-delivery-reminders')).not.toBeInTheDocument();
    await waitFor(
      () => {
        expect(calls.some((call) => call.path === 'home/delivery-reminders')).toBe(
          false,
        );
      },
      WAIT,
    );
  });

  it('adjusts the widget list and restores the role default', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderControlledDashboard(
      root,
      <Dashboard roleKey='root' onChange={onChange} />,
    );
    await user.click(
      await screen.findByRole('button', { name: enUS.dashboard.adjust }, WAIT),
    );
    const panel = await screen.findByRole(
      'dialog',
      { name: enUS.dashboard.adjustTitle },
      WAIT,
    );
    expect(panel.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);

    await user.click(
      screen.getByRole('checkbox', { name: enUS.dashboard.widgets.myTasks }),
    );
    expect(onChange).toHaveBeenCalledWith({
      widgets: [
        { id: 'quickActions', collapsed: false },
        { id: 'deliveryReminders', collapsed: false },
        { id: 'favoriteReports', collapsed: false },
        { id: 'inventoryShortcuts', collapsed: false },
      ],
    });

    onChange.mockClear();
    await user.click(
      screen.getAllByRole('button', { name: enUS.dashboard.moveUp })[1],
    );
    expect(onChange).toHaveBeenCalled();

    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: enUS.dashboard.reset }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
