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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import { Dashboard } from '../../client/pages/home/dashboard.js';
import { FavoriteReportsWidget } from '../../client/pages/home/widgets.js';
import ReportsPage from '../../client/pages/reports/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** R-078 页面片：用组件测试钉住白名单、裁列、导出与设常用；所有数据都是编造的。 */
const T = 15_000;
const WAIT = { timeout: T };

const BRIEF = {
  key: 'sales_tracking', titleKey: 'reporting.titles.sales_tracking',
  category: 'sales',
};
const SCHEMA = {
  dimensions: ['date', 'customer', 'shipStatus'],
  measures: ['shippedQty', 'receivedAmount'],
  columns: [
    { key: 'date', labelKey: 'reporting.columns.date', type: 'text' },
    { key: 'customer', labelKey: 'reporting.columns.customer', type: 'text' },
    { key: 'shipStatus', labelKey: 'reporting.columns.shipStatus', type: 'text' },
    { key: 'shippedQty', labelKey: 'reporting.columns.shippedQty', type: 'number' },
    {
      key: 'receivedAmount', labelKey: 'reporting.columns.receivedAmount',
      type: 'number',
    },
    {
      key: 'taxIncludedAmount', labelKey: 'reporting.columns.taxIncludedAmount',
      type: 'number',
    },
  ],
};
const RESULT = {
  // 服务端裁掉价格/金额列：页面只能画这四列，不能为 schema 里的第五、第六列补空格。
  columns: SCHEMA.columns.slice(0, 4),
  items: [
    { date: '2026-11-01', customer: 'Sample customer', shipStatus: 'done', shippedQty: 1234.5 },
    { date: '2026-11-02', customer: 'Another customer', shipStatus: 'pending', shippedQty: null },
  ],
  total: 2, page: 1, pageSize: 20,
};
const FAVORITE = { ...BRIEF };
/** 四组各有一张有权报表；采2 没在服务端列表里，页面不该出现、也不该发它的请求。 */
const LIST = [
  BRIEF,
  { key: 'purchase_detail', titleKey: 'reporting.titles.purchase_detail', category: 'purchase' },
  { key: 'stock_movement_detail', titleKey: 'reporting.titles.stock_movement_detail', category: 'stock' },
  { key: 'income_expense_detail', titleKey: 'reporting.titles.income_expense_detail', category: 'finance' },
] as const;

const reader: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [{
    resource: { type: 'composite', id: 'reports' },
    actions: ['view', 'run', 'export', 'favorite'],
  }],
};
const viewer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [{
    resource: { type: 'composite', id: 'reports' }, actions: ['view'],
  }],
};
const denied: AuthorizationSnapshot = { unrestricted: false, permissions: [] };

let permissions: AuthorizationSnapshot;
let favorites: readonly typeof FAVORITE[];
let calls: ApiCall[];

function answer(call: ApiCall): unknown {
  calls.push(call);
  if (call.path === 'authorization/permissions') return { data: permissions };
  if (call.path === 'reports' && call.method === 'GET') {
    return { items: LIST, total: LIST.length, page: 1, pageSize: 100 };
  }
  if (call.path === 'reports/favorites' && call.method === 'GET') {
    return { items: favorites };
  }
  if (call.path === `reports/${BRIEF.key}/schema`) return SCHEMA;
  if (call.path === `reports/${BRIEF.key}/run` && call.method === 'POST') return RESULT;
  if (call.path === `reports/${BRIEF.key}/export` && call.method === 'POST') {
    return new Response('date,customer\r\n2026-11-01,Sample customer\r\n', {
      status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' },
    });
  }
  if (call.path === `reports/${BRIEF.key}/favorite`) {
    favorites = call.method === 'POST' ? [FAVORITE] : [];
    return { favorited: call.method === 'POST' };
  }
  return new Response(null, { status: 404 });
}

function services(app: { container: { singleton: (...args: unknown[]) => unknown } }) {
  app.container.singleton(
    authorizationClientToken,
    (resolver: { resolve: (token: unknown) => unknown }) =>
      new AuthorizationClient(resolver.resolve(apiClientToken) as never),
  );
}

async function renderPage(snapshot: AuthorizationSnapshot) {
  permissions = snapshot;
  calls = [];
  return renderWithApp(
    <Routes>
      <Route path='/reports' element={<ReportsPage />} />
    </Routes>,
    {
      route: '/reports',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(answer),
      services,
    },
  );
}

async function renderHome(snapshot: AuthorizationSnapshot, ui: ReactNode) {
  permissions = snapshot;
  calls = [];
  return renderWithApp(ui, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(answer),
    services,
  });
}

async function openReport() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'S2 Sales order tracking' }, WAIT),
  );
  return user;
}

beforeEach(() => {
  favorites = [];
});

describe('report center page (R-078)', () => {
  it('does not request anything without the entry action', async () => {
    await renderPage(denied);
    expect(
      await screen.findByRole('alert', {}, WAIT),
    ).toBeVisible();
    expect(calls.some((call) => call.path.startsWith('reports'))).toBe(false);
  });

  it('lists only the reports the server returns, grouped in the four categories', async () => {
    await renderPage(reader);
    expect(
      await screen.findByRole('button', { name: 'S2 Sales order tracking' }, WAIT),
    ).toBeVisible();
    for (const group of ['Purchase', 'Sales', 'Stock', 'Finance'])
      expect(screen.getByRole('heading', { name: group })).toBeVisible();
    expect(screen.queryByText('C2 Purchase order tracking')).not.toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/schema'))).toBe(false);
  });

  it('offers only whitelisted keys and sends only those keys on run', async () => {
    await renderPage(reader);
    const user = await openReport();
    expect(
      await screen.findByTestId('filter-date', {}, WAIT),
    ).toBeInTheDocument();
    expect(screen.getByTestId('filter-customer')).toBeInTheDocument();
    expect(screen.getByTestId('dimension-shipStatus')).toBeInTheDocument();
    expect(screen.getByTestId('measure-shippedQty')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-price')).not.toBeInTheDocument();
    expect(screen.queryByTestId('measure-taxIncludedAmount')).not.toBeInTheDocument();

    await user.type(screen.getByTestId('filter-date'), '2026-11-01');
    await user.click(screen.getByTestId('measure-receivedAmount'));
    await user.click(await screen.findByRole('button', { name: 'Generate report' }, WAIT));
    const run = calls.find((call) => call.path.endsWith('/run'));
    expect(run?.method).toBe('POST');
    expect(run?.json).toEqual({
      filters: { date: '2026-11-01' },
      dimensions: ['date', 'customer', 'shipStatus'],
      measures: ['shippedQty'],
      page: 1,
      pageSize: 20,
    });
  });

  it('draws exactly the returned columns, formats numbers and shows a dash for null', async () => {
    await renderPage(reader);
    const user = await openReport();
    await user.click(
      await screen.findByRole('button', { name: 'Generate report' }, WAIT),
    );
    expect(await screen.findByText('1,234.50', {}, WAIT)).toBeVisible();
    const table = await screen.findByTestId('reports-result', {}, WAIT);
    expect(within(table).getByText('shippedQty')).toBeVisible();
    expect(within(table).getAllByText('—')).toHaveLength(1);
    expect(within(table).queryByText('taxIncludedAmount')).not.toBeInTheDocument();
    expect(within(table).queryByText('receivedAmount')).not.toBeInTheDocument();
  });

  it('exports with the same inputs and downloads the CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:report');
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: createObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await renderPage(reader);
      const user = await openReport();
      await user.type(await screen.findByTestId('filter-customer', {}, WAIT), 'Sample customer');
      await user.click(await screen.findByRole('button', { name: 'Export CSV' }, WAIT));
      await waitFor(() => {
        expect(calls.some((call) => call.path.endsWith('/export'))).toBe(true);
      }, WAIT);
      const exportCall = calls.find((call) => call.path.endsWith('/export'));
      expect(exportCall?.method).toBe('POST');
      expect(exportCall?.json).toMatchObject({
        filters: { customer: 'Sample customer' },
      });
      expect(createObjectURL).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
    } finally {
      if (original === undefined) delete (URL as { createObjectURL?: unknown }).createObjectURL;
      else Object.defineProperty(URL, 'createObjectURL', original);
      click.mockRestore();
    }
  });

  it('sets and removes a favorite with the two dedicated endpoints', async () => {
    await renderPage(reader);
    const user = await openReport();
    await user.click(
      await screen.findByRole('button', { name: 'Set as favorite' }, WAIT),
    );
    expect(
      await screen.findByRole('button', { name: 'Remove favorite' }, WAIT),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove favorite' }));
    expect(
      await screen.findByRole('button', { name: 'Set as favorite' }, WAIT),
    ).toBeVisible();
    const favoriteCalls = calls.filter((call) => call.path.endsWith('/favorite'));
    expect(favoriteCalls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
  });

  it('hides the run and export actions when the caller only has view', async () => {
    await renderPage(viewer);
    await openReport();
    // 先等到表单真的装配好，再断言三个按钮都不在；否则点击后立刻查会落在空窗口里。
    expect(await screen.findByTestId('filter-date', {}, WAIT)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Generate report' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Set as favorite' })).not.toBeInTheDocument();
    }, WAIT);
  });
});

describe('home favorite reports widget (R-078)', () => {

  it('keeps the guidance when there is no favorite', async () => {
    await renderHome(reader, <FavoriteReportsWidget roleKey='sales' />);
    expect(
      await screen.findByText('No favorite reports yet. Set them in the report center.', {}, WAIT),
    ).toBeVisible();
  });

  it('does not mount the widget or request favorites without the entry action', async () => {
    await renderHome(denied, <Dashboard roleKey='staff' />);
    await screen.findByRole('button', { name: enUS.dashboard.adjust }, WAIT);
    expect(screen.queryByText('Favorite reports')).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === 'reports/favorites')).toBe(false);
  });
});
