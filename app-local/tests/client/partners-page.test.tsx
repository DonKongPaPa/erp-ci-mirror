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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import PartnerContactNewPage from '../../client/pages/partners/contact-new.js';
import PartnerDetailPage from '../../client/pages/partners/detail.js';
import PartnersPage from '../../client/pages/partners/index.js';
import PartnerNewPage from '../../client/pages/partners/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-014 客户与供应商页。真实的应用 hook 与路由容器，只把 HTTP 换成夹具：
 * 销售只持 customers.*，采购只持 suppliers.*。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const grant = (id: string, actions: string[]): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [{ resource: { type: 'composite', id }, actions }],
});
const sales = grant('customers', ['view', 'create', 'update']);
const purchase = grant('suppliers', ['view', 'create', 'update']);
const salesViewer = grant('customers', ['view']);
const notFound = () => new Response(null, { status: 404 });

function partner(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'p1',
    code: 'CU202611010001',
    name: 'Sample Buyer Co.',
    isCustomer: true,
    isSupplier: false,
    status: 'active',
    contactName: 'Sample Contact',
    phone: null,
    email: null,
    address: null,
    taxId: null,
    note: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
const contact = {
  id: 'c1',
  partnerId: 'p1',
  name: 'Sample Contact Person',
  title: 'Buyer',
  phone: null,
  email: null,
  isPrimary: true,
};
const page = (...items: ReturnType<typeof partner>[]) => ({
  items,
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
        <Route path='/partners' element={<PartnersPage />}>
          <Route path='new' element={<PartnerNewPage />} />
          <Route path=':partnerId' element={<PartnerDetailPage />}>
            <Route path='contacts/new' element={<PartnerContactNewPage />} />
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
          (resolver) =>
            new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

/** 等表单的某个输入框出现，返回它所在的那个对话框（权限落定前对话框里是一句「加载中」）。 */
async function liveDialog(textboxName: string): Promise<HTMLElement> {
  const field = await screen.findByRole('textbox', { name: textboxName }, WAIT);
  return field.closest<HTMLElement>('[role="dialog"]')!;
}

const posts = () =>
  api.mock.calls.map(([call]) => call).filter((call) => call.method === 'POST');
const gets = (path: string) =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === 'GET' && call.path === path);

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-014 客户与供应商页', () => {
  it('sales sees only the customer tab, lists customers and can open a record', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'partners'
        ? page(partner())
        : notFound();
    await renderAt('/partners', sales);

    expect(await screen.findByText('Sample Buyer Co.', {}, WAIT)).toBeVisible();
    // 销售看不到「供应商」标签，页头是「新建客户」。
    expect(
      screen.queryByRole('tab', { name: 'Supplier' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Customer' })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'New customer' }, WAIT),
    ).toHaveAttribute('href', '/partners/new?kind=customer');
    // 默认只列在用的；首列点开详情抽屉。
    expect(gets('partners').map((call) => [call.path, call.query])).toEqual([
      [
        'partners',
        { kind: 'customer', status: 'active', page: '1', pageSize: '20' },
      ],
    ]);
    expect(
      screen.getByRole('link', { name: 'CU202611010001' }),
    ).toHaveAttribute('href', '/partners/p1');
  });

  it('purchase sees only the supplier tab', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'partners'
        ? page(
            partner({
              id: 'p2',
              code: 'SU202611010001',
              name: 'Sample Vendor Co.',
              isCustomer: false,
              isSupplier: true,
            }),
          )
        : notFound();
    await renderAt('/partners', purchase);

    expect(
      await screen.findByText('Sample Vendor Co.', {}, WAIT),
    ).toBeVisible();
    expect(
      screen.queryByRole('tab', { name: 'Customer' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Supplier' })).toBeInTheDocument();
    expect(gets('partners').map((call) => call.query)).toEqual([
      { kind: 'supplier', status: 'active', page: '1', pageSize: '20' },
    ]);
  });

  it('creates a customer and confirms it with a toast', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'partners'
        ? partner({
            id: 'p9',
            code: 'CU202611010009',
            name: 'Sample New Buyer',
          })
        : notFound();
    const view = await renderAt('/partners/new?kind=customer', sales);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample New Buyer',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Phone' }),
      '0000',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create' }),
    );

    await waitFor(
      () =>
        expect(posts()[0]?.json).toEqual({
          name: 'Sample New Buyer',
          isCustomer: true,
          // 销售没有 suppliers.create：供应商那一个勾选框不画，也不会发出去。
          isSupplier: false,
          contactName: null,
          phone: '0000',
          email: null,
          address: null,
          taxId: null,
          note: null,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created customer "Sample New Buyer"',
      }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          /^\/partners$/,
        ),
      WAIT,
    );
  });

  it('shows the server sentence when the endpoint answers 422 and keeps the dialog open', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'partners'
        ? Response.json(
            {
              error: {
                message: 'raw',
                reason: 'PARTNER_KIND_REQUIRED',
                localizedMessage: {
                  locale: 'en-US',
                  message: 'Choose a type for this partner.',
                },
              },
            },
            { status: 422 },
          )
        : notFound();
    const view = await renderAt('/partners/new?kind=customer', sales);
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create' }),
    );

    // 一句在上面的提示条里，一句标在类型那一项下面。
    expect(
      await screen.findAllByText('Choose a type for this partner.', {}, WAIT),
    ).toHaveLength(2);
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Sample',
    );
    expect(posts()).toHaveLength(1);
    expect(view.toasts()).toEqual([]);
  });

  it('the detail drawer shows the record and its contacts, with a way to add one', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'partners/p1'
        ? { ...partner(), contacts: [contact] }
        : notFound();
    await renderAt('/partners/p1', sales);

    const drawer = await screen.findByRole(
      'dialog',
      { name: /Sample Buyer Co\./ },
      WAIT,
    );
    expect(
      await within(drawer).findByText('Sample Contact Person', {}, WAIT),
    ).toBeVisible();
    expect(within(drawer).getByText('Buyer')).toBeVisible();
    expect(
      within(drawer).getAllByText('CU202611010001', { exact: false }).length,
    ).toBeGreaterThan(0);
    expect(
      await within(drawer).findByRole('button', { name: 'Add contact' }, WAIT),
    ).toHaveAttribute('href', '/partners/p1/contacts/new');
  });

  it('purchase opening a customer-only record sees the server sentence, not the record', async () => {
    answer = (call) =>
      call.path === 'partners/p1'
        ? Response.json(
            {
              error: {
                message: 'Forbidden',
                reason: 'AUTHORIZATION_DENIED',
                localizedMessage: {
                  locale: 'en-US',
                  message: 'You cannot view this partner.',
                },
              },
            },
            { status: 403 },
          )
        : notFound();
    await renderAt('/partners/p1', purchase);

    expect(
      await screen.findByText('You cannot view this partner.', {}, WAIT),
    ).toBeVisible();
    expect(screen.queryByText('Sample Buyer Co.')).not.toBeInTheDocument();
  });

  it('adds a contact to an active record', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'partners/p1')
        return { ...partner(), contacts: [] };
      if (call.method === 'POST' && call.path === 'partners/p1/contacts')
        return {
          ...contact,
          id: 'c2',
          name: 'Sample Second Person',
          isPrimary: true,
        };
      return notFound();
    };
    const view = await renderAt('/partners/p1/contacts/new', sales);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample Second Person',
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Set as primary contact' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(
      () =>
        expect(posts()[0]?.json).toEqual({
          name: 'Sample Second Person',
          title: null,
          phone: null,
          email: null,
          isPrimary: true,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: 'Contact added' }),
    ]);
  });

  it('a viewer without update sees no create button and no row menu', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'partners'
        ? page(partner())
        : notFound();
    await renderAt('/partners', salesViewer);
    expect(await screen.findByText('Sample Buyer Co.', {}, WAIT)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), WAIT);

    expect(
      screen.queryByRole('button', { name: 'New customer' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Sample Buyer Co.' }),
    ).not.toBeInTheDocument();
  });
});
