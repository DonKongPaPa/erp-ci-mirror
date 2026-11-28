import { apiClientToken } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import HomePage from '../../client/pages/home/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** R-064 首页交付提醒：显隐按 ledgerView，days 只在块内改，行链接回销售订单。数据编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const REMINDER = {
  salesOrderId: 'o1',
  orderNo: 'XS-20261128-0001',
  customer: { id: 'c1', code: 'CU001', name: 'Sample Customer' },
  baselineDate: '2026-11-20',
  overdueDays: 8,
  scope: 'overdue',
};
/** 天数由夹具决定：负数是即将到期，服务端把它算成今天减基准日。 */
let reminderDays = 8;
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
  if (call.path === 'home/delivery-reminders') {
    return { items: [{ ...REMINDER, overdueDays: reminderDays }], total: 1 };
  }
  return new Response(null, { status: 404 });
});

async function renderHome(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  return renderWithApp(<HomePage />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(api),
    services: (app) => {
      app.container.singleton(
        authorizationClientToken,
        (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
      );
    },
  });
}

const reminders = (): ApiCall[] =>
  api.mock.calls.map(([call]) => call)
    .filter((call) => call.path === 'home/delivery-reminders');

describe('home delivery reminders (R-064)', () => {
  it('shows the block with a 7-day default and a link back to the order', async () => {
    api.mockClear();
    await renderHome(reader);
    const block = await screen.findByTestId('home-delivery-reminders', {}, WAIT);
    await waitFor(() => expect(reminders()).toHaveLength(1), WAIT);
    expect(reminders()[0].query).toMatchObject({ scope: 'overdue', days: '7' });
    expect(await within(block).findByRole('link', { name: `Open order ${REMINDER.orderNo}` }, WAIT))
      .toHaveAttribute('href', `/sales-orders/${REMINDER.salesOrderId}`);
  });

  it('sends the days and scope chosen inside the block', async () => {
    api.mockClear();
    await renderHome(reader);
    const block = await screen.findByTestId('home-delivery-reminders', {}, WAIT);
    const user = userEvent.setup();
    await user.click(within(block).getByRole('button', { name: '14' }));
    await waitFor(() => expect(reminders().at(-1)?.query?.days).toBe('14'), WAIT);
    await user.click(within(block).getByRole('button', { name: enUS.homeDelivery.scopeUpcoming }));
    await waitFor(() => {
      expect(reminders().at(-1)?.query?.scope).toBe('upcoming');
      expect(reminders().at(-1)?.query?.days).toBe('14');
    }, WAIT);
  });

  // 缺陷 7：服务端把即将到期算成负的 overdueDays，页面不能把它读成「超期 -17 天」。
  it.each([
    [-17, 'Due in 17 day(s)'],
    [0, 'Due today'],
    [8, 'Overdue by 8 day(s)'],
  ])('renders overdueDays=%i as "%s"', async (days, text) => {
    api.mockClear();
    reminderDays = days;
    await renderHome(reader);
    const block = await screen.findByTestId('home-delivery-reminders', {}, WAIT);
    expect(await within(block).findByText(text, {}, WAIT)).toBeVisible();
  });

  it('renders nothing and fetches nothing without ledgerView', async () => {
    api.mockClear();
    await renderHome(denied);
    await waitFor(
      () => expect(api.mock.calls.some(([call]) => call.path === 'authorization/permissions')).toBe(true),
      WAIT,
    );
    expect(screen.queryByTestId('home-delivery-reminders')).not.toBeInTheDocument();
    expect(reminders()).toHaveLength(0);
  });
});
