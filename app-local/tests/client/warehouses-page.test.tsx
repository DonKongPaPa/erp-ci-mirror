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
import WarehouseEditPage from '../../client/pages/warehouses/edit.js';
import WarehousesPage from '../../client/pages/warehouses/index.js';
import WarehouseNewPage from '../../client/pages/warehouses/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-020 仓库页（《基座ERP前端设计》3.3）。真实的应用 hook 与路由容器，只把 HTTP 换成夹具：
 * 仓管只持 inventory.warehouseView（看得到、改不了），root 持 warehouseManage。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const grant = (id: string, actions: string[]): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [{ resource: { type: 'composite', id }, actions }],
});
const keeper = grant('inventory', ['warehouseView', 'stockView']);
const manager = grant('inventory', ['warehouseView', 'warehouseManage']);
const notFound = () => new Response(null, { status: 404 });

function warehouse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'w1',
    code: 'WH01',
    name: 'Sample Warehouse',
    status: 'active',
    note: 'Sample note',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
const page = (...items: ReturnType<typeof warehouse>[]) => ({
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
        <Route path='/warehouses' element={<WarehousesPage />}>
          <Route path='new' element={<WarehouseNewPage />} />
          <Route path=':warehouseId/edit' element={<WarehouseEditPage />} />
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

const writes = (method: string) =>
  api.mock.calls.map(([call]) => call).filter((call) => call.method === method);
const gets = (path: string) =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === 'GET' && call.path === path);

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-020 仓库页', () => {
  it('lists active warehouses only and offers edit and deactivation on a row', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'warehouses'
        ? page(warehouse())
        : notFound();
    await renderAt('/warehouses', manager);

    expect(await screen.findByText('Sample Warehouse', {}, WAIT)).toBeVisible();
    // 默认只列在用的。
    expect(gets('warehouses').map((call) => call.query)).toEqual([
      { status: 'active', page: '1', pageSize: '20' },
    ]);
    expect(
      await screen.findByRole('button', { name: 'New warehouse' }, WAIT),
    ).toHaveAttribute('href', '/warehouses/new');
    // 仓库不设详情：首列不是链接，行尾的「⋮」里是编辑与停用。
    expect(screen.queryByRole('link', { name: 'WH01' })).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Actions for Sample Warehouse' },
        WAIT,
      ),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Edit' }, WAIT),
    ).toHaveAttribute('href', '/warehouses/w1/edit');
    expect(
      await screen.findByRole('menuitem', { name: 'Deactivate' }, WAIT),
    ).toBeInTheDocument();
  });

  it('creates a warehouse and confirms it with a toast', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'warehouses'
        ? warehouse({ id: 'w9', code: 'WH09', name: 'Sample New Warehouse' })
        : notFound();
    const view = await renderAt('/warehouses/new', manager);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'WH09',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample New Warehouse',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Note' }),
      'Sample note',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create' }),
    );

    await waitFor(
      () =>
        expect(writes('POST')[0]?.json).toEqual({
          code: 'WH09',
          name: 'Sample New Warehouse',
          note: 'Sample note',
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created warehouse "Sample New Warehouse"',
      }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          /^\/warehouses$/,
        ),
      WAIT,
    );
  });

  it('shows the server sentence under the code on 409 and keeps the dialog open', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'warehouses'
        ? Response.json(
            {
              error: {
                message: 'raw',
                reason: 'WAREHOUSE_CODE_EXISTS',
                localizedMessage: {
                  locale: 'en-US',
                  message: 'That warehouse code is already in use.',
                },
              },
            },
            { status: 409 },
          )
        : notFound();
    const view = await renderAt('/warehouses/new', manager);
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'WH01',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample Duplicate',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create' }),
    );

    // 一句在上面的提示条里，一句标在编码那一项下面。
    expect(
      await screen.findAllByText(
        'That warehouse code is already in use.',
        {},
        WAIT,
      ),
    ).toHaveLength(2);
    expect(
      within(dialog).getByRole('textbox', { name: 'Code' }),
    ).toHaveValue('WH01');
    expect(writes('POST')).toHaveLength(1);
    expect(view.toasts()).toEqual([]);
  });

  it('deactivates from the row menu after a confirmation', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'warehouses')
        return page(warehouse());
      if (call.method === 'PATCH' && call.path === 'warehouses/w1')
        return warehouse({ status: 'inactive' });
      return notFound();
    };
    const view = await renderAt('/warehouses', manager);
    await screen.findByText('Sample Warehouse', {}, WAIT);

    await userEvent.click(
      screen.getByRole('button', { name: 'Actions for Sample Warehouse' }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Deactivate' }, WAIT),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Deactivate warehouse "Sample Warehouse"?' },
      WAIT,
    );
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'Deactivate' }),
    );

    await waitFor(
      () => expect(writes('PATCH')[0]?.json).toEqual({ status: 'inactive' }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Deactivated warehouse "Sample Warehouse"',
      }),
    ]);
  });

  it('edits without sending the code', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'warehouses/w1')
        return warehouse();
      if (call.method === 'PATCH' && call.path === 'warehouses/w1')
        return warehouse({ name: 'Sample Renamed' });
      return notFound();
    };
    const view = await renderAt('/warehouses/w1/edit', manager);
    const dialog = await liveDialog('Name');

    // 编码不可改：先等到表单稳定，再断言对话框里没有编码输入框。
    const name = await within(dialog).findByRole(
      'textbox',
      { name: 'Name' },
      WAIT,
    );
    expect(
      within(dialog).queryByRole('textbox', { name: 'Code' }),
    ).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, 'Sample Renamed');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Save' }),
    );

    await waitFor(
      () =>
        expect(writes('PATCH')[0]?.json).toEqual({
          name: 'Sample Renamed',
          note: 'Sample note',
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Saved warehouse "Sample Renamed"',
      }),
    ]);
  });

  it('a warehouse keeper sees no create button and no row menu', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'warehouses'
        ? page(warehouse())
        : notFound();
    await renderAt('/warehouses', keeper);
    expect(await screen.findByText('Sample Warehouse', {}, WAIT)).toBeVisible();

    expect(
      screen.queryByRole('button', { name: 'New warehouse' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Sample Warehouse' }),
    ).not.toBeInTheDocument();
    // 直接敲新建的地址：只看到一句没有写权限的说明，没有表单。
    await renderAt('/warehouses/new', keeper);
    expect(
      await screen.findByText(
        'You do not have permission to change this record.',
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Code' })).not.toBeInTheDocument();
  });
});
