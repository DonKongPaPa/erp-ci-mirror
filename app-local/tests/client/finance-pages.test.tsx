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
import ExpenseDetailPage from '../../client/pages/expenses/detail/index.js';
import ExpenseEditPage from '../../client/pages/expenses/edit.js';
import ExpensesPage from '../../client/pages/expenses/index.js';
import ExpenseNewPage from '../../client/pages/expenses/new.js';
import InvoiceReceiptDetailPage from '../../client/pages/invoice-receipts/detail/index.js';
import InvoiceReceiptEditPage from '../../client/pages/invoice-receipts/edit.js';
import InvoiceReceiptsPage from '../../client/pages/invoice-receipts/index.js';
import InvoiceReceiptNewPage from '../../client/pages/invoice-receipts/new.js';
import { today } from '../../client/pages/orders/model.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/** R-065 的财务页面：真实 hook 与路由容器，HTTP 用夹具；示例数据一律编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const at = '2026-11-28T08:00:00.000Z';
const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const finance = (extra: string[] = []): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [
    grant('expenses', ['view', 'create', 'update', 'confirm', 'void']),
    grant('invoiceReceipts', ['view', 'create', 'update', 'confirm', 'void']),
    grant('purchaseOrders', ['financeView']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
    ...(extra.length > 0 ? [grant('expenses', extra)] : []),
  ],
});
const notFound = () => new Response(null, { status: 404 });
const pageOf = (items: unknown[]) => ({
  items, total: items.length, page: 1, pageSize: 20,
});

const supplier = {
  id: 's1', code: 'SU1', name: 'Sample Vendor',
  payeeAccountNo: 'ACC-1', payeeBankName: 'Sample Bank', payeeBankCode: 'BANK-1',
};
const payable = {
  id: 'po1', orderNo: 'CG-20261127-0001', orderDate: '2026-11-27',
  status: 'ordered', payableTotal: 500, paidAmount: 100, invoicedAmount: 0,
  unpaidAmount: 400, supplier,
};
const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1', docNo: 'EXP-20261128-0001', expenseDate: '2026-11-28',
  status: 'draft', expenseTypeCode: null, expenseTypeLabel: null,
  fundAccountCode: null, fundAccountLabel: null,
  payeeName: 'Sample Vendor', supplier, payeeAccountNo: 'ACC-1',
  payeeBankName: 'Sample Bank', payeeBankCode: 'BANK-1',
  bindMode: 'purchase_order', handler: null, projectCode: null,
  projectLabel: null, remark: '', totalAmount: 50,
  confirmedAt: null, voidedAt: null, createdAt: at, updatedAt: at,
  lines: [{
    id: 'fl1', recordId: 'f1', purchaseOrderId: 'po1',
    orderNo: payable.orderNo, orderPayableAmount: 500, paidBefore: 100,
    amount: 50, note: null,
  }],
  files: [],
  ...overrides,
});

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
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

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/expenses' element={<ExpensesPage />}>
          <Route path='new' element={<ExpenseNewPage />} />
          <Route path=':expenseId' element={<ExpenseDetailPage />}>
            <Route path='edit' element={<ExpenseEditPage />} />
          </Route>
        </Route>
        <Route path='/invoice-receipts' element={<InvoiceReceiptsPage />}>
          <Route path='new' element={<InvoiceReceiptNewPage />} />
          <Route path=':invoiceReceiptId' element={<InvoiceReceiptDetailPage />}>
            <Route path='edit' element={<InvoiceReceiptEditPage />} />
          </Route>
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

const lookups = (call: ApiCall): unknown => {
  if (call.path === 'biz-dict/entries')
    return pageOf([{ id: 'e1', dictType: 'expense_type', code: 'GOODS', name: 'Goods', rate: null, startDate: null, endDate: null, description: null, isDefault: true, sort: 0, status: 'active', createdAt: at, updatedAt: at }]);
  if (call.path === 'person-options')
    return pageOf([{ userId: 'u1', name: 'Sam Finance', departmentId: null, departmentName: null }]);
  if (call.path === 'expenses/supplier-options') return pageOf([supplier]);
  if (call.path === 'purchase-orders/payable') return pageOf([payable]);
  return notFound();
};

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = lookups;
});

describe('R-065 finance pages', () => {
  it('creates an expense draft with a payable order line and no register flag', async () => {
    let created: unknown;
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'expenses') {
        created = call.json;
        return record();
      }
      return lookups(call);
    };
    const user = userEvent.setup();
    await renderAt('/expenses/new', finance());
    await screen.findByRole('heading', { name: 'New expense record' }, WAIT);

    await user.click(
      await screen.findByRole('button', { name: 'Select a purchase order' }, WAIT),
    );
    expect(await screen.findByRole('columnheader', { name: 'Order number' }, WAIT)).toBeVisible();
    await user.click(
      await screen.findByRole('button', { name: 'Select order CG-20261127-0001' }, WAIT),
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Expense amount' }, WAIT),
      '50',
    );
    await user.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    await waitFor(() => expect(created).toBeDefined(), WAIT);
    expect(created).toMatchObject({
      expenseDate: today(),
      bindMode: 'purchase_order',
      supplierId: 's1',
      lines: [{ purchaseOrderId: 'po1', amount: 50 }],
    });
    expect(created).not.toHaveProperty('confirm');
    // 财务读的是窄形状：请求体里不带订单明细、单价、备注、经办人。
    expect(JSON.stringify(created)).not.toContain('price');
    expect(JSON.stringify(created)).not.toContain('handler');
  });

  it('shows the register button only with the confirm action', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'expenses/f1') return record();
      return lookups(call);
    };
    const reader: AuthorizationSnapshot = {
      unrestricted: false,
      permissions: [
        grant('expenses', ['view']),
        grant('purchaseOrders', ['financeView']),
      ],
    };
    await renderAt('/expenses/f1', reader);
    expect((await screen.findAllByText('EXP-20261128-0001', {}, WAIT)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();

    await renderAt('/expenses/f1', finance());
    expect(await screen.findByRole('button', { name: 'Register' }, WAIT)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Void' })).toBeVisible();
  });

  it('registers an invoice receipt with no binding in one step', async () => {
    let created: unknown;
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'invoice-receipts') {
        created = call.json;
        return record({ docNo: 'RCV-20261128-0001', invoiceDate: '2026-11-28' });
      }
      return lookups(call);
    };
    const user = userEvent.setup();
    await renderAt('/invoice-receipts/new', finance());
    await screen.findByRole('heading', { name: 'New invoice receipt record' }, WAIT);

    await user.click(await screen.findByRole('combobox', { name: 'Binding mode' }, WAIT));
    await user.click(await screen.findByRole('option', { name: 'No document' }, WAIT));
    await user.type(await screen.findByRole('textbox', { name: 'Issuer' }, WAIT), 'Sample Issuer');
    await user.type(await screen.findByRole('textbox', { name: 'Invoice number' }, WAIT), 'INV-001');
    await user.type(await screen.findByRole('textbox', { name: 'Total amount' }, WAIT), '88');
    await user.click(await screen.findByRole('button', { name: 'Save and register' }, WAIT));

    await waitFor(() => expect(created).toBeDefined(), WAIT);
    expect(created).toMatchObject({
      invoiceDate: today(),
      bindMode: 'none',
      amount: 88,
      issuerName: 'Sample Issuer',
      invoiceNo: 'INV-001',
      confirm: true,
    });
  });
});
