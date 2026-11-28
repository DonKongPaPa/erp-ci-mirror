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
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import SalesOrderDetailPage from '../../client/pages/sales-orders/detail/index.js';
import IncomeRecordDetailPage from '../../client/pages/income-records/detail/index.js';
import IncomeRecordsPage from '../../client/pages/income-records/index.js';
import IncomeRecordNewPage from '../../client/pages/income-records/new.js';
import ReceivableReconDetailPage from '../../client/pages/receivable-recons/detail/index.js';
import ReceivableReconsPage from '../../client/pages/receivable-recons/index.js';
import PayableReconsPage from '../../client/pages/payable-recons/index.js';
import ReceivableReconNewPage from '../../client/pages/receivable-recons/new.js';
import SaleInvoiceRecordsPage from '../../client/pages/sale-invoice-records/index.js';
import { today } from '../../client/pages/orders/model.js';
import packageMetadata from '../../package.json' with { type: 'json' };
import { NavigationMenu } from '../../client/layouts/components/navigation-menu';
import { AppSidebarProvider } from '../../client/layouts/components/app-sidebar';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.js';
import {
  buildRouteNavigation,
  useRouteNavigation,
  routeKey,
} from '../../client/routing/route-navigation';
import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';

/** R-065 第二片页面：真实应用 hook 与路由，HTTP 用夹具；数据一律编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const at = '2026-11-28T08:00:00.000Z';
const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const DOC_ACTIONS = ['view', 'create', 'update', 'confirm', 'void'];
const finance = (): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [
    ...['incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons']
      .map((id) => grant(id, DOC_ACTIONS)),
    grant('salesOrders', ['view', 'financeView']),
    grant('purchaseOrders', ['view']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
});
const sales = (): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [
    grant('salesOrders', ['view', 'viewPrice']),
    grant('items', ['view']),
  ],
});
const notFound = () => new Response(null, { status: 404 });
const pageOf = (items: unknown[]) => ({
  items, total: items.length, page: 1, pageSize: 20,
});

const customer = { id: 'c1', code: 'CU1', name: 'Sample Customer' };
const sourceOut = {
  id: 'out1', docNo: 'CK-20261127-0001', docDate: '2026-11-27',
  partnerId: customer.id, partnerName: customer.name, reason: 'sale_out',
  status: 'posted', totalQty: 5,
};
const snapshot = {
  id: 'sl1', reconId: 'r1', side: 'out', sourceDocId: 'out1', itemId: 'i1',
  item: { id: 'i1', code: 'M0001', name: 'Sample Sheet', spec: null, unitCode: 'KG' },
  qty: 5, taxRate: 13, taxIncludedPrice: 20, taxIncludedAmount: 100, note: null,
};
const recon = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1', docNo: 'YS-20261128-0001', reconDate: '2026-11-28',
  expectedPayDate: null, periodAmount: 500, status: 'draft',
  reconStatus: 'unsettled', reconciledIncomeAmount: 0, reconciledInvoiceAmount: 0,
  customer, supplier: null, contactName: null, phone: null, invoiceTypeCode: null,
  handler: null, projectCode: null, remark: '', confirmedAt: null, voidedAt: null,
  createdAt: at, updatedAt: at, snapshotLines: [snapshot], files: [],
  ...overrides,
});
const income = (overrides: Record<string, unknown> = {}) => ({
  id: 'in1', docNo: 'INCM-20261128-0001', date: '2026-11-28', status: 'draft',
  bindMode: 'receivable_recon', customerId: customer.id, customer,
  payerName: null, invoiceToName: null, invoiceNo: null,
  incomeTypeCode: null, incomeTypeLabel: null, invoiceTypeCode: null,
  invoiceTypeLabel: null, fundAccountCode: null, fundAccountLabel: null,
  handler: null, projectCode: null, projectLabel: null, remark: '',
  totalAmount: 100, confirmedAt: null, voidedAt: null, createdAt: at, updatedAt: at,
  lines: [{
    id: 'il1', recordId: 'in1', salesOrderId: null, receivableReconId: 'r1',
    orderPayableAmount: 500, receivedBefore: 0, amount: 100, note: null,
  }],
  files: [],
  ...overrides,
});
const salesOrder = {
  id: 'o1', orderNo: 'XS-20261127-0001', orderDate: '2026-11-27', status: 'ordered',
  customerId: 'c1', customer, payableTotal: 500, paidAmount: 0,
  receivedAmount: 120, invoicedAmount: 80, remark: '', submittedAt: at,
  createdAt: at, updatedAt: at, lines: [],
};

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
/** 服务端状态：作废收入记录后核销列回到原值。 */
let reconAfterVoid = recon();
let voided = false;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions'
    ? { data: permissions }
    : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid='location'>{location.pathname}</span>;
}

let mounted: { unmount(): void }[] = [];
async function renderAt(route: string, grants: AuthorizationSnapshot) {
  for (const view of mounted) view.unmount();
  mounted = [];
  permissions = grants;
  const view = await renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/income-records' element={<IncomeRecordsPage />}>
          <Route path='new' element={<IncomeRecordNewPage />} />
          <Route path=':incomeRecordId' element={<IncomeRecordDetailPage />} />
        </Route>
        <Route path='/sale-invoice-records' element={<SaleInvoiceRecordsPage />} />
        <Route path='/receivable-recons' element={<ReceivableReconsPage />}>
          <Route path='new' element={<ReceivableReconNewPage />} />
          <Route path=':receivableReconId' element={<ReceivableReconDetailPage />} />
        </Route>
        <Route path='/payable-recons' element={<PayableReconsPage />} />
        <Route path='/sales-orders/:salesOrderId' element={<SalesOrderDetailPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: (request: Request) => answerApi(api)(request),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
        app.container.singleton(
          authorizationClientToken,
          (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
  mounted.push(view);
  return view;
}

const lookups = (call: ApiCall): unknown => {
  if (call.path === 'biz-dict/entries') return pageOf([]);
  if (call.path.startsWith('person-options')) return pageOf([]);
  if (call.path.startsWith('reconciliation/partners')) return pageOf([customer]);
  if (call.path.startsWith('reconciliation/source-docs')) return pageOf([sourceOut]);
  if (call.path.startsWith('sales-orders/receivable')) return pageOf([salesOrder]);
  if (call.path.startsWith('receivable-recons/options'))
    return pageOf([{
      id: 'r1', docNo: recon().docNo, reconDate: recon().reconDate,
      periodAmount: 500, reconciledIncomeAmount: reconAfterVoid.reconciledIncomeAmount,
      reconciledInvoiceAmount: reconAfterVoid.reconciledInvoiceAmount,
    }]);
  if (call.path === 'income-records') return pageOf([]);
  if (call.path === 'sale-invoice-records') return pageOf([]);
  if (call.path === 'receivable-recons') return pageOf([]);
  if (call.path === 'payable-recons') return pageOf([]);
  if (call.path === 'receivable-recons/r1') return reconAfterVoid;
  if (call.path === 'income-records/in1') return income();
  if (call.path === 'sales-orders/o1') return salesOrder;
  if (call.path === 'items') return pageOf([]);
  if (call.path === 'warehouses') return pageOf([]);
  return notFound();
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  api.mockClear();
  getSession.mockClear();
  voided = false;
  reconAfterVoid = recon();
  answer = lookups;
});

afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = [];
  vi.unstubAllGlobals();
});

describe('R-065 reconciliation pages', () => {
  it('creates a receivable recon from checked outbound docs and shows a read-only snapshot', async () => {
    let created: unknown;
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'receivable-recons') {
        created = call.json;
        return recon();
      }
      return lookups(call);
    };
    const user = userEvent.setup();
    await renderAt('/receivable-recons/new', finance());
    // 先等到目标结构（勾选按钮）真的出现，再操作。
    expect(await screen.findByRole('button', { name: 'Select sales outbound documents' }, WAIT)).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Select sales outbound documents' }, WAIT));
    expect(await screen.findByText('CK-20261127-0001', {}, WAIT)).toBeVisible();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select document CK-20261127-0001' }, WAIT),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Add selected documents' }, WAIT),
    );
    await user.click(await screen.findByRole('combobox', { name: 'Customer' }, WAIT));
    await user.click(await screen.findByRole('option', { name: 'CU1 Sample Customer' }, WAIT));
    await user.type(
      await screen.findByRole('textbox', { name: 'Current period amount' }, WAIT),
      '500',
    );
    await user.click(await screen.findByRole('button', { name: 'Save draft' }, WAIT));

    await waitFor(() => expect(created).toBeDefined(), WAIT);
    expect(created).toMatchObject({
      reconDate: today(), periodAmount: 500, outStockDocIds: ['out1'],
    });
    expect(created).not.toHaveProperty('purchaseStockDocIds');

    await renderAt('/receivable-recons/r1', finance());
    expect(await screen.findByText(/Sample Sheet/u, {}, WAIT)).toBeVisible();
    expect(screen.getByText('out1')).toBeVisible();
    // 快照只读：详情里没有可改的数量或金额输入框。
    expect(screen.queryByRole('textbox', { name: /quantity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove line/i })).not.toBeInTheDocument();
  });

  it('binds a confirmed statement when creating an income record', async () => {
    let created: unknown;
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'income-records') {
        created = call.json;
        return income();
      }
      return lookups(call);
    };
    const user = userEvent.setup();
    await renderAt('/income-records/new', finance());
    expect(await screen.findByRole('combobox', { name: 'Bind mode' }, WAIT)).toBeVisible();
    await user.click(await screen.findByRole('combobox', { name: 'Bind mode' }, WAIT));
    await user.click(await screen.findByRole('option', { name: 'Bind a receivable statement' }, WAIT));
    await user.click(
      await screen.findByRole('button', { name: 'Select a receivable statement' }, WAIT),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Select statement YS-20261128-0001' }, WAIT),
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Income amount' }, WAIT),
      '100',
    );
    await user.click(await screen.findByRole('button', { name: 'Save draft' }, WAIT));

    await waitFor(() => expect(created).toBeDefined(), WAIT);
    expect(created).toMatchObject({
      incomeDate: today(), bindMode: 'receivable_recon',
      lines: [{ receivableReconId: 'r1', amount: 100 }],
    });
    expect(JSON.stringify(created)).not.toContain('salesOrderId');
    expect(created).not.toHaveProperty('confirm');
  });

  it('shows the two reconciled amounts and status, and reverts them after voiding the record', async () => {
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'income-records/in1/void') {
        voided = true;
        reconAfterVoid = recon({
          status: 'confirmed', reconStatus: 'unsettled',
          reconciledIncomeAmount: 0, reconciledInvoiceAmount: 0,
        });
        return income({ status: 'void' });
      }
      return lookups(call);
    };
    reconAfterVoid = recon({
      status: 'confirmed', reconStatus: 'partial',
      reconciledIncomeAmount: 100, reconciledInvoiceAmount: 0,
    });
    const user = userEvent.setup();
    await renderAt('/income-records/in1', finance());
    expect((await screen.findAllByText('INCM-20261128-0001', {}, WAIT)).length).toBeGreaterThan(0);

    await renderAt('/receivable-recons/r1', finance());
    expect(await screen.findByText('Reconciled receipts', {}, WAIT)).toBeVisible();
    expect(screen.getByText('Reconciled invoices')).toBeVisible();
    expect(screen.getByText('Partially settled')).toBeVisible();
    const panel = await screen.findByRole('region', { name: 'Reconciliation' }, WAIT);
    expect(within(panel).getByText('100')).toBeVisible();

    await renderAt('/income-records/in1', finance());
    await user.click(await screen.findByRole('button', { name: 'Void' }, WAIT));
    const dialog = await screen.findByRole('alertdialog', { name: /Void INCM-20261128-0001/u }, WAIT);
    await user.click(within(dialog).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(voided).toBe(true), WAIT);

    await renderAt('/receivable-recons/r1', finance());
    expect(await screen.findByText('Reconciled receipts', {}, WAIT)).toBeVisible();
    expect(screen.getByText('Not settled')).toBeVisible();
    const after = await screen.findByRole('region', { name: 'Reconciliation' }, WAIT);
    expect(within(after).getAllByText('0').length).toBeGreaterThan(0);
  });

  it('shows received and invoiced amounts on the sales order detail without touching purchase links', async () => {
    await renderAt('/sales-orders/o1', sales());
    expect(await screen.findByText('XS-20261127-0001', {}, WAIT)).toBeVisible();
    expect(await screen.findByText('Received amount', {}, WAIT)).toBeVisible();
    expect(screen.getByText(/120/u)).toBeVisible();
    expect(screen.getByText('Invoiced amount')).toBeVisible();
    expect(screen.getByText(/80/u)).toBeVisible();
  });

  it('hides all four finance page entries from a non-finance role', async () => {
    const routes: AppClientRegisteredRoute[] = [
      'incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons',
    ].map((id) => ({
      id, name: id, path: `/${id}`, packageName: packageMetadata.name,
      source: 'application', auth: 'required',
      authz: { resource: { type: 'page', id }, action: 'access' },
      navigation: { title: `navigation.${id}` },
      componentLoader: async () => ({ default: () => null }),
    }));
    function Menu(): ReactElement {
      const { items } = useRouteNavigation(routes);
      return (
        <NavigationMenu
          items={items}
          label='Finance navigation'
          selectedKey={routeKey(routes[0]!)}
        />
      );
    }
    async function renderMenu(grants: AuthorizationSnapshot) {
      permissions = grants;
      return await renderWithApp(
        <SidebarPreferenceProvider value={createAppSidebarPreferenceStore('/main')}>
          <AppSidebarProvider><Menu /></AppSidebarProvider>
        </SidebarPreferenceProvider>,
        {
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
    await renderMenu(sales());
    expect(await screen.findByRole('navigation', { name: 'Finance navigation' }, WAIT)).toBeVisible();
    for (const label of ['Income records', 'Sale invoices', 'Receivable statements', 'Payable statements']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }

    // R-085 归组后四页在「财务」组里、不占顶层；菜单怎么画（紧凑态先点开组）由
    // company-navigation 的测试守，这里只断言导航数据。
    const menu = buildRouteNavigation(routes, new Set());
    const finance = menu.find(({ route }) => route.name === 'businessFinance');
    expect(finance?.children.map(({ route }) => route.name)).toEqual([
      'incomeRecords', 'saleInvoiceRecords', 'receivableRecons', 'payableRecons',
    ]);
    expect(menu.filter(({ route }) => route.componentLoader)).toEqual([]);
    void act;
  });

});


/** 前端自适应：文案、限宽、金额、空态、窄屏、脏表单离开。 */
describe('finance list and form adaptation', () => {
  it('shows localized binding mode labels instead of raw values', async () => {
    await renderAt('/income-records/new', finance());
    const combo = await screen.findByRole('combobox', { name: 'Bind mode' }, WAIT);
    await waitFor(() => expect(combo.textContent).not.toContain('sales_order'), WAIT);
    expect(combo.textContent).toContain(enUS.reconciliation.bindSalesOrder);
  });

  it('maps an internal finance reason to a localized message, not the raw rule code', async () => {
    answer = (call) => {
      if (call.path === 'income-records/missing')
        return Response.json(
          { error: { reason: 'FINANCE_NOT_FOUND', message: 'Reconciliation rule violated: finance-not-found' } },
          { status: 422 },
        );
      return lookups(call);
    };
    await renderAt('/income-records/missing', finance());
    expect(
      await screen.findByText(enUS.reconciliation.errors.notFound, {}, WAIT),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('finance-not-found');
  });

  it('limits the single-column form to a readable width', async () => {
    await renderAt('/income-records/new', finance());
    const form = await waitFor(() => {
      const found = document.querySelector('form[data-slot="feedback-form"]');
      expect(found).not.toBeNull();
      return found!;
    }, WAIT);
    expect(form).toHaveClass('max-w-3xl');
  });

  it('right-aligns amount cells and keeps two decimals', async () => {
    answer = (call) => (call.path === 'income-records' ? pageOf([income()]) : lookups(call));
    await renderAt('/income-records', finance());
    const amount = await screen.findByText('100.00', {}, WAIT);
    expect(amount).toHaveClass('text-right');
    expect(amount).toHaveClass('tabular-nums');
  });

  it('offers a next step in the empty state only with create permission', async () => {
    await renderAt('/income-records', finance());
    await waitFor(() => expect(document.body.textContent).toContain(enUS.incomeRecords.emptyHint), WAIT);
    const enabled = screen.getAllByRole('button', { name: 'New income record' });
    expect(enabled).toHaveLength(2);
    expect(enabled[1]?.querySelector('svg')).not.toBeNull();

    const reader: AuthorizationSnapshot = {
      unrestricted: false,
      permissions: [grant('incomeRecords', ['view'])],
    };
    await renderAt('/income-records', reader);
    await waitFor(() => expect(document.body.textContent).toContain(enUS.incomeRecords.emptyHint), WAIT);
    expect(screen.queryAllByRole('button', { name: 'New income record' })).toHaveLength(0);
  });

  it('renders phone cards instead of a table below md', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)',
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    answer = (call) => (call.path === 'income-records' ? pageOf([income()]) : lookups(call));
    await renderAt('/income-records', finance());
    const list = await screen.findByRole('list', {}, WAIT);
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('INCM-20261128-0001');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('confirms leaving a dirty form and leaves a clean one directly', async () => {
    const user = userEvent.setup();
    await renderAt('/income-records/new', finance());
    await user.type(await screen.findByRole('textbox', { name: 'Payer' }, WAIT), 'Jane');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog', {}, WAIT);
    expect(dialog).toHaveTextContent('Discard changes?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/income-records/new'), WAIT);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('alertdialog', {}, WAIT);
    await user.click(within(again).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/income-records'), WAIT);

    await renderAt('/income-records/new', finance());
    await screen.findByRole('combobox', { name: 'Bind mode' }, WAIT);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/income-records'), WAIT);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
