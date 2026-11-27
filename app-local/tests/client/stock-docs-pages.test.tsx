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
import InboundOrderDetailPage from '../../client/pages/inbound-orders/detail.js';
import InboundOrderEditPage from '../../client/pages/inbound-orders/edit.js';
import InboundOrdersPage from '../../client/pages/inbound-orders/index.js';
import InboundOrderNewPage from '../../client/pages/inbound-orders/new.js';
import OutboundOrdersPage from '../../client/pages/outbound-orders/index.js';
import OutboundOrderDetailPage from '../../client/pages/outbound-orders/detail.js';
import OutboundOrderEditPage from '../../client/pages/outbound-orders/edit.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-020 入库单、出库单（《基座ERP前端设计》2.4、3.3）。真实的应用 hook 与路由容器，只把 HTTP 换成夹具。
 * 仓管持 stockView / stockWrite / stockPost / stockVoid 与仓库、物料的读；只读身份只持 stockView。示例数据一律编造。
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
    permission('inventory', [
      'stockView',
      'stockWrite',
      'stockPost',
      'stockVoid',
      'warehouseView',
    ]),
    permission('items', ['view']),
  ],
};
const viewer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [permission('inventory', ['stockView'])],
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
const line = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  docId: 'd1',
  itemId: 'i1',
  warehouseId: 'w1',
  batchNo: '',
  qty: 120,
  ...overrides,
});
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1',
    docNo: 'RK-20261127-0001',
    docType: 'in',
    reason: 'other_in',
    status: 'draft',
    remark: '',
    sourceType: null,
    sourceId: null,
    createdById: 'u1',
    postedAt: null,
    postedById: null,
    createdAt: at,
    updatedAt: at,
    lines: [line()],
    ...overrides,
  };
}
const outDoc = (overrides: Record<string, unknown> = {}) =>
  doc({
    docNo: 'CK-20261127-0001',
    docType: 'out',
    reason: 'other_out',
    ...overrides,
  });
const pageOf = <T,>(items: readonly T[]) => ({
  items: [...items],
  total: items.length,
  page: 1,
  pageSize: 20,
});
const lookups = (call: ApiCall): unknown => {
  if (call.method === 'GET' && call.path === 'items') return pageOf([item]);
  if (call.method === 'GET' && call.path === 'warehouses')
    return pageOf([warehouse]);
  return notFound();
};
const rejected = (status: number, reason: string, message: string) =>
  Response.json(
    {
      error: {
        message: 'raw',
        reason,
        localizedMessage: { locale: 'en-US', message },
      },
    },
    { status },
  );

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
        <Route path='/inbound-orders' element={<InboundOrdersPage />}>
          <Route path='new' element={<InboundOrderNewPage />} />
          <Route path=':docId' element={<InboundOrderDetailPage />}>
            <Route path='edit' element={<InboundOrderEditPage />} />
          </Route>
        </Route>
        <Route path='/outbound-orders' element={<OutboundOrdersPage />}>
          <Route path=':docId' element={<OutboundOrderDetailPage />}>
            <Route path='edit' element={<OutboundOrderEditPage />} />
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

const calls = (method: string, path: string) =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === method && call.path === path);

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-020 入库单', () => {
  it('lists this direction only, with type, source and row actions for a draft', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'stock-docs'
        ? pageOf([doc()])
        : notFound();
    await renderAt('/inbound-orders', keeper);

    expect(
      await screen.findByRole('link', { name: 'RK-20261127-0001' }, WAIT),
    ).toHaveAttribute('href', '/inbound-orders/d1');
    expect(await screen.findByText('Other inbound', {}, WAIT)).toBeVisible();
    expect(await screen.findByText('Entered manually', {}, WAIT)).toBeVisible();
    expect(await screen.findByText('Draft', {}, WAIT)).toBeVisible();
    // 默认是全部状态；只按单据方向取。
    expect(calls('GET', 'stock-docs').map((call) => call.query)).toEqual([
      { docType: 'in', page: '1', pageSize: '20' },
    ]);
    expect(
      await screen.findByRole('button', { name: 'New inbound order' }, WAIT),
    ).toHaveAttribute('href', '/inbound-orders/new');
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Actions for RK-20261127-0001' },
        WAIT,
      ),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Edit' }, WAIT),
    ).toHaveAttribute('href', '/inbound-orders/d1/edit');
    expect(
      await screen.findByRole('menuitem', { name: 'Void' }, WAIT),
    ).toBeInTheDocument();
  });

  it('a viewer sees no create button and no row menu', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'stock-docs'
        ? pageOf([doc()])
        : notFound();
    await renderAt('/inbound-orders', viewer);
    expect(
      await screen.findByText('RK-20261127-0001', {}, WAIT),
    ).toBeVisible();

    expect(
      screen.queryByRole('button', { name: 'New inbound order' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Actions for RK-20261127-0001',
      }),
    ).not.toBeInTheDocument();
  });

  it('creates a draft by hand and lands on the document', async () => {
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'stock-docs')
        return doc({ id: 'd9', docNo: 'RK-20261127-0009' });
      return lookups(call);
    };
    const view = await renderAt('/inbound-orders/new', keeper);
    await screen.findByRole('heading', { name: 'New inbound order' }, WAIT);

    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Item, line 1' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole(
        'option',
        { name: 'M001 Sample Sheet Metal' },
        WAIT,
      ),
    );
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Warehouse, line 1' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Sample Warehouse' }, WAIT),
    );
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Quantity, line 1' }, WAIT),
      '12.5',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    await waitFor(
      () =>
        expect(calls('POST', 'stock-docs')[0]?.json).toEqual({
          docType: 'in',
          reason: 'other_in',
          remark: '',
          lines: [
            { itemId: 'i1', warehouseId: 'w1', batchNo: '', qty: 12.5 },
          ],
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: 'Saved as a draft' }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          '/inbound-orders/d9',
        ),
      WAIT,
    );
  });

  it('refuses to save a line whose quantity is not positive, without a request', async () => {
    await renderAt('/inbound-orders/new', keeper);
    await screen.findByRole('heading', { name: 'New inbound order' }, WAIT);

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Quantity, line 1' }, WAIT),
      '0',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    expect(
      await screen.findByText(
        'Enter a quantity greater than 0, with at most four decimals.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    // 物料、仓库没选也一并标出来。
    expect(
      await screen.findAllByText('Required.', {}, WAIT),
    ).toHaveLength(2);
    expect(calls('POST', 'stock-docs')).toEqual([]);
  });

  it('shows the server sentence on 422 and keeps what was typed', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'stock-docs'
        ? rejected(422, 'STOCK_LINE_INVALID', 'A document line is invalid.')
        : lookups(call);
    const view = await renderAt('/inbound-orders/new', keeper);
    await screen.findByRole('heading', { name: 'New inbound order' }, WAIT);

    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Item, line 1' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'M001 Sample Sheet Metal' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Warehouse, line 1' }, WAIT),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Sample Warehouse' }, WAIT),
    );
    const qty = await screen.findByRole(
      'textbox',
      { name: 'Quantity, line 1' },
      WAIT,
    );
    await userEvent.type(qty, '5');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    expect(
      await screen.findByText('A document line is invalid.', {}, WAIT),
    ).toBeVisible();
    expect(view.toasts()).toEqual([]);
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/inbound-orders/new',
    );
    expect(
      screen.getByRole('textbox', { name: 'Quantity, line 1' }),
    ).toHaveValue('5');
  });

  it('shows a draft with its header, its line and the actions it still allows', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'stock-docs/d1'
        ? doc()
        : lookups(call);
    await renderAt('/inbound-orders/d1', keeper);

    expect(
      await screen.findByRole('heading', { name: /RK-20261127-0001/ }, WAIT),
    ).toBeVisible();
    expect(await screen.findByText('Draft', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByText(
        'This is a draft. Stock increases only when it is posted.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(await screen.findByText('Sample Sheet Metal', {}, WAIT)).toBeVisible();
    expect(await screen.findByText('120', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Edit' }, WAIT),
    ).toHaveAttribute('href', '/inbound-orders/d1/edit');
    expect(
      await screen.findByRole('button', { name: 'Post' }, WAIT),
    ).toBeEnabled();
    expect(
      await screen.findByRole('button', { name: 'Void' }, WAIT),
    ).toBeInTheDocument();
  });

  it('posts after a confirmation, then offers nothing but a way to the stock', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1') return doc();
      if (call.method === 'POST' && call.path === 'stock-docs/d1/post')
        return doc({ status: 'posted', postedAt: at });
      return lookups(call);
    };
    const view = await renderAt('/inbound-orders/d1', keeper);
    const post = await screen.findByRole('button', { name: 'Post' }, WAIT);

    await userEvent.click(post);
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Post RK-20261127-0001?' },
      WAIT,
    );
    await userEvent.click(
      await within(confirm).findByRole(
        'button',
        { name: 'Post' },
        WAIT,
      ),
    );

    await waitFor(() => expect(calls('POST', 'stock-docs/d1/post')).toHaveLength(1), WAIT);
    expect(
      await screen.findByText('Posted. Stock has increased.', {}, WAIT),
    ).toBeVisible();
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Posted RK-20261127-0001. Stock has increased.',
      }),
    ]);
    expect(
      await screen.findByRole('link', { name: 'View stock' }, WAIT),
    ).toHaveAttribute('href', '/stock');
    // 已过账：没有任何写入口。
    for (const name of ['Post', 'Edit', 'Void']) {
      expect(
        screen.queryByRole('button', { name }),
        `${name} 不该再出现`,
      ).not.toBeInTheDocument();
    }
  });

  it('voids a draft after a confirmation', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1') return doc();
      if (call.method === 'POST' && call.path === 'stock-docs/d1/void')
        return doc({ status: 'void' });
      return lookups(call);
    };
    const view = await renderAt('/inbound-orders/d1', keeper);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Void' }, WAIT),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Void RK-20261127-0001?' },
      WAIT,
    );
    await userEvent.click(
      await within(confirm).findByRole('button', { name: 'Void' }, WAIT),
    );

    await waitFor(
      () => expect(calls('POST', 'stock-docs/d1/void')).toHaveLength(1),
      WAIT,
    );
    expect(await screen.findByText('Void', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByText(
        'This document is void. It does not affect stock and cannot be posted.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Voided RK-20261127-0001',
      }),
    ]);
  });

  it('a posted document has no edit entry: the edit address explains instead of showing a form', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'stock-docs/d1'
        ? doc({ status: 'posted', postedAt: at })
        : lookups(call);
    await renderAt('/inbound-orders/d1/edit', keeper);

    expect(
      await screen.findByText(
        'Only a draft document can be changed.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Save draft' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'Quantity, line 1' }),
    ).not.toBeInTheDocument();
  });

  it('edits a draft by replacing its lines', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1') return doc();
      if (call.method === 'PATCH' && call.path === 'stock-docs/d1')
        return doc({ lines: [line({ qty: 130 })] });
      return lookups(call);
    };
    await renderAt('/inbound-orders/d1/edit', keeper);
    const qty = await screen.findByRole(
      'textbox',
      { name: 'Quantity, line 1' },
      WAIT,
    );
    expect(qty).toHaveValue('120');

    await userEvent.clear(qty);
    await userEvent.type(qty, '130');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    await waitFor(
      () =>
        expect(calls('PATCH', 'stock-docs/d1')[0]?.json).toEqual({
          reason: 'other_in',
          remark: '',
          lines: [{ itemId: 'i1', warehouseId: 'w1', batchNo: '', qty: 130 }],
        }),
      WAIT,
    );
  });
});

describe('R-020 出库单', () => {
  it('marks a line that exceeds the on-hand quantity and disables posting', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1')
        return outDoc({ lines: [line({ qty: 60 })] });
      if (call.method === 'GET' && call.path === 'stock/balances')
        return {
          items: [{ itemId: 'i1', warehouseId: 'w1', batchNo: '', qty: 45 }],
          total: 1,
          page: 1,
          pageSize: 100,
        };
      return lookups(call);
    };
    await renderAt('/outbound-orders/d1', keeper);

    expect(
      await screen.findByText('45 (exceeds by 15)', {}, WAIT),
    ).toBeVisible();
    expect(
      await screen.findByRole('alert', {}, WAIT),
    ).toHaveTextContent('1 line(s) exceed the on-hand quantity');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled(),
    );
    expect(calls('GET', 'stock/balances')[0]?.query).toEqual({
      itemId: 'i1',
      warehouseId: 'w1',
      page: '1',
      pageSize: '100',
    });
  });

  it('keeps the server sentence in the confirmation when posting is refused (422)', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1')
        return outDoc({ lines: [line({ qty: 10 })] });
      if (call.method === 'GET' && call.path === 'stock/balances')
        return {
          items: [{ itemId: 'i1', warehouseId: 'w1', batchNo: '', qty: 45 }],
          total: 1,
          page: 1,
          pageSize: 100,
        };
      if (call.method === 'POST' && call.path === 'stock-docs/d1/post')
        return rejected(
          422,
          'STOCK_INSUFFICIENT',
          'Insufficient stock; the whole document was rolled back.',
        );
      return lookups(call);
    };
    const view = await renderAt('/outbound-orders/d1', keeper);
    const post = await screen.findByRole('button', { name: 'Post' }, WAIT);
    await waitFor(() => expect(post).toBeEnabled(), WAIT);

    await userEvent.click(post);
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Post CK-20261127-0001?' },
      WAIT,
    );
    await userEvent.click(
      await within(confirm).findByRole('button', { name: 'Post' }, WAIT),
    );

    expect(
      await within(confirm).findByText(
        'Insufficient stock; the whole document was rolled back.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(view.toasts()).toEqual([]);
    // 还是草稿，改与作废的入口都还在。
    expect(
      await within(confirm).findByRole('button', { name: 'Cancel' }, WAIT),
    ).toBeEnabled();
  });

  it('reloads the document when the server says it is no longer a draft', async () => {
    let stored = doc({
      docNo: 'CK-20261127-0001',
      docType: 'out',
      reason: 'other_out',
    });
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1')
        return stored;
      if (call.method === 'POST' && call.path === 'stock-docs/d1/void') {
        stored = { ...stored, status: 'posted', postedAt: at };
        return rejected(422, 'STOCK_DOC_NOT_DRAFT', 'Only a draft document can be changed.');
      }
      return lookups(call);
    };
    await renderAt('/outbound-orders/d1', keeper);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Void' }, WAIT),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Void CK-20261127-0001?' },
      WAIT,
    );
    await userEvent.click(
      await within(confirm).findByRole('button', { name: 'Void' }, WAIT),
    );

    // 单据已不是草稿：这一页重新读一遍，按过账后的样子显示，确认框关掉。
    expect(
      await screen.findByText('Posted. Stock has decreased.', {}, WAIT),
    ).toBeVisible();
    await waitFor(
      () => expect(screen.queryByRole('alertdialog')).toBeNull(),
      WAIT,
    );
    expect(calls('GET', 'stock-docs/d1')).toHaveLength(2);
  });

  it('returns straight to the document after saving, without a discard prompt', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'stock-docs/d1') return outDoc();
      if (call.method === 'PATCH' && call.path === 'stock-docs/d1')
        return outDoc({ lines: [line({ qty: 130 })] });
      return lookups(call);
    };
    await renderAt('/outbound-orders/d1/edit', keeper);
    const qty = await screen.findByRole(
      'textbox',
      { name: 'Quantity, line 1' },
      WAIT,
    );
    await userEvent.clear(qty);
    await userEvent.type(qty, '130');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    // 保存成功必须真的离开表单回到详情；若还问「放弃修改」，导航会被挡住，这里会超时。
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          /^\/outbound-orders\/d1$/,
        ),
      WAIT,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls('PATCH', 'stock-docs/d1')).toHaveLength(1);
  });
});
