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
import CategoryEditPage from '../../client/pages/items/category-edit.js';
import CategoryNewPage from '../../client/pages/items/category-new.js';
import ItemDetailPage from '../../client/pages/items/detail.js';
import ItemEditPage from '../../client/pages/items/edit.js';
import ItemsPage from '../../client/pages/items/index.js';
import ItemNewPage from '../../client/pages/items/new.js';
import UnitEditPage from '../../client/pages/items/unit-edit.js';
import UnitNewPage from '../../client/pages/items/unit-new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-019 物料页（物料清单、计量单位、物料分类三个标签）。真实的应用 hook 与路由容器，只把 HTTP 换成夹具。
 * root 不受限、能读能写；采购、销售只持 items.view。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const manager: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
const viewer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'composite', id: 'items' }, actions: ['view'] },
  ],
};
const notFound = () => new Response(null, { status: 404 });

function item(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'i1',
    code: 'M2611270001',
    name: 'Sample brass sheet',
    spec: 'Sample 2.0mm',
    itemType: 'material',
    categoryCode: 'RAW',
    unitCode: 'KG',
    status: 'active',
    legacyCode: 'L-001',
    note: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
const product = item({
  id: 'i2',
  code: 'P2611270001',
  name: 'Sample bracket',
  spec: null,
  itemType: 'product',
  categoryCode: null,
  unitCode: 'PCS',
  legacyCode: null,
});
const unit = {
  code: 'KG',
  name: 'Sample kilogram',
  decimals: 2,
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const category = {
  id: 'c1',
  code: 'RAW',
  name: 'Sample raw material',
  parentId: null,
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const childCategory = {
  ...category,
  id: 'c2',
  code: 'MET',
  name: 'Sample metal',
  parentId: 'c1',
};
const page = (...items: Record<string, unknown>[]) => ({
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
        <Route path='/items' element={<ItemsPage />}>
          <Route path='new' element={<ItemNewPage />} />
          <Route path='units/new' element={<UnitNewPage />} />
          <Route path='units/:unitCode/edit' element={<UnitEditPage />} />
          <Route path='categories/new' element={<CategoryNewPage />} />
          <Route
            path='categories/:categoryId/edit'
            element={<CategoryEditPage />}
          />
          <Route path=':itemId' element={<ItemDetailPage />}>
            <Route path='edit' element={<ItemEditPage />} />
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

const calls = (method: string) =>
  api.mock.calls.map(([call]) => call).filter((call) => call.method === method);
const gets = (path: string) =>
  calls('GET').filter((call) => call.path === path);
const posts = () => calls('POST');
const patches = () => calls('PATCH');

/** 三个标签都要取的两本字典：各一页，最多 100 条，不带状态。 */
const DICTIONARY_READS = [
  ['item-categories', { page: '1', pageSize: '100' }],
  ['units', { page: '1', pageSize: '100' }],
] as const;

/** 字典的夹具：单位与分类各取一页。 */
function withDictionaries(
  records: (call: ApiCall) => unknown,
): (call: ApiCall) => unknown {
  return (call) => {
    if (
      call.method === 'GET' &&
      call.path === 'units' &&
      call.query?.pageSize === '100'
    )
      return page(unit);
    if (
      call.method === 'GET' &&
      call.path === 'item-categories' &&
      call.query?.pageSize === '100'
    )
      return page(category, childCategory);
    return records(call);
  };
}

function ruleError(status: number, reason: string, message: string): Response {
  return Response.json(
    {
      error: {
        message: 'raw',
        reason,
        localizedMessage: { locale: 'en-US', message },
      },
    },
    { status },
  );
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-019 物料页', () => {
  it('lists active items with the request the endpoint expects and names their unit and category', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' && call.path === 'items'
        ? page(item(), product)
        : notFound(),
    );
    await renderAt('/items', manager);

    expect(
      await screen.findByText('Sample brass sheet', {}, WAIT),
    ).toBeVisible();
    expect(screen.getByText('Sample 2.0mm')).toBeVisible();
    // 类型的徽标、单位的名称、分类的名称；规格为空画「—」。
    expect(screen.getAllByText('Material').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Product').length).toBeGreaterThan(0);
    expect(screen.getByText('Sample kilogram')).toBeVisible();
    expect(screen.getAllByText('Sample raw material').length).toBeGreaterThan(
      0,
    );
    // 默认只列在用的：不勾「含已停用」时传 status=active。
    expect(gets('items').map((call) => call.query)).toEqual([
      { status: 'active', page: '1', pageSize: '20' },
    ]);
    for (const [path, query] of DICTIONARY_READS)
      expect(gets(path).map((call) => call.query)).toContainEqual(query);
    // 首列点开详情抽屉。
    expect(screen.getByRole('link', { name: 'M2611270001' })).toHaveAttribute(
      'href',
      '/items/i1',
    );
    expect(
      await screen.findByRole(
        'button',
        { name: enUS.items.form.newTitle },
        WAIT,
      ),
    ).toHaveAttribute('href', '/items/new');
  });

  it('sends the type and category filters, and lists deactivated records only when asked', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' && call.path === 'items'
        ? page(item())
        : notFound(),
    );
    await renderAt(
      '/items?itemType=product&categoryCode=RAW&includeInactive=true',
      manager,
    );

    expect(
      await screen.findByText('Sample brass sheet', {}, WAIT),
    ).toBeVisible();
    // 展开行里两个筛选都看得见当前值；不传 status 就是全部状态。
    expect(
      await screen.findByRole('combobox', { name: 'Type' }, WAIT),
    ).toHaveTextContent('Product');
    expect(
      screen.getByRole('combobox', { name: 'Category' }),
    ).toHaveTextContent('RAW Sample raw material');
    expect(gets('items').map((call) => call.query)).toEqual([
      {
        categoryCode: 'RAW',
        itemType: 'product',
        page: '1',
        pageSize: '20',
      },
    ]);
  });

  it('switches to the units tab: the request, the table and the header button all follow', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' &&
      call.path === 'units' &&
      call.query?.pageSize === '20'
        ? page(unit)
        : notFound(),
    );
    await renderAt('/items?view=units', manager);

    expect(await screen.findByText('Sample kilogram', {}, WAIT)).toBeVisible();
    expect(screen.getByText('2')).toBeVisible();
    expect(
      gets('units').map((call) => [call.query, call.query?.pageSize]),
    ).toContainEqual([{ status: 'active', page: '1', pageSize: '20' }, '20']);
    // 字段太少，不设详情：编码不是链接。
    expect(screen.queryByRole('link', { name: 'KG' })).not.toBeInTheDocument();
    expect(
      await screen.findByRole(
        'button',
        { name: enUS.items.units.newTitle },
        WAIT,
      ),
    ).toHaveAttribute('href', '/items/units/new');
  });

  it('the categories tab names the parent category and leaves a root blank', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' &&
      call.path === 'item-categories' &&
      call.query?.pageSize === '20'
        ? page(category, childCategory)
        : notFound(),
    );
    await renderAt('/items?view=categories', manager);

    expect(await screen.findByText('Sample metal', {}, WAIT)).toBeVisible();
    // 根分类自己的名字，与子分类那一行「上级分类」格里的是同一串字。
    expect(
      screen.getAllByText('Sample raw material', { selector: 'td' }),
    ).toHaveLength(2);
    // 根分类没有上级：整页只有它那一格画「—」。
    expect(screen.getAllByText('—')).toHaveLength(1);
    expect(gets('item-categories').map((call) => call.query)).toContainEqual({
      status: 'active',
      page: '1',
      pageSize: '20',
    });
    expect(
      await screen.findByRole(
        'button',
        { name: enUS.items.categories.newTitle },
        WAIT,
      ),
    ).toHaveAttribute('href', '/items/categories/new');
  });

  it('creates an item: the code is left to the server and the toast offers to view it', async () => {
    answer = withDictionaries((call) =>
      call.method === 'POST' && call.path === 'items'
        ? item({ id: 'i9', code: 'M2611270009', name: 'Sample copper rod' })
        : notFound(),
    );
    const view = await renderAt('/items/new', manager);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample copper rod',
    );
    await userEvent.click(
      within(dialog).getByRole('combobox', { name: 'Base unit' }),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Sample kilogram (KG)' }, WAIT),
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Legacy code' }),
      'L-009',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    await waitFor(
      () =>
        expect(posts()[0]?.json).toEqual({
          name: 'Sample copper rod',
          // 没选的类型默认是物料，没选的分类是空。
          itemType: 'material',
          unitCode: 'KG',
          spec: null,
          categoryCode: null,
          legacyCode: 'L-009',
          note: null,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created material "Sample copper rod"',
      }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/items$/),
      WAIT,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WAIT);
  });

  it('shows the server sentence when the endpoint answers 422 and keeps the dialog open', async () => {
    answer = withDictionaries((call) =>
      call.method === 'POST' && call.path === 'items'
        ? ruleError(422, 'UNIT_INACTIVE', 'That unit is deactivated.')
        : notFound(),
    );
    const view = await renderAt('/items/new', manager);
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample',
    );
    await userEvent.click(
      within(dialog).getByRole('combobox', { name: 'Base unit' }),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Sample kilogram (KG)' }, WAIT),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 一句在上面的提示条里，一句标在基本单位那一项下面；对话框不关，输入还在。
    expect(
      await screen.findAllByText('That unit is deactivated.', {}, WAIT),
    ).toHaveLength(2);
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Sample',
    );
    expect(posts()).toHaveLength(1);
    expect(view.toasts()).toEqual([]);
  });

  it('validates on submit only: a missing name and unit are marked and nothing is sent', async () => {
    answer = withDictionaries(notFound);
    await renderAt('/items/new', manager);
    const dialog = await liveDialog('Name');
    // 等到提交按钮出现，表单才算画完，再断言「还没有提示」。
    await screen.findByRole('button', { name: enUS.erp.actions.create }, WAIT);
    expect(within(dialog).queryByText(enUS.erp.form.required)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 名称、基本单位两项必填：两句提示；一个写请求都没有。
    expect(
      await screen.findAllByText(enUS.erp.form.required, {}, WAIT),
    ).toHaveLength(2);
    expect(posts()).toHaveLength(0);
  });

  it('editing reads the latest item and sends the editable fields, never the code', async () => {
    answer = withDictionaries((call) => {
      if (call.method === 'GET' && call.path === 'items/i1') return item();
      if (call.method === 'PATCH' && call.path === 'items/i1')
        return item({ name: 'Sample brass sheet A' });
      return notFound();
    });
    const view = await renderAt('/items/i1/edit', manager);
    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    expect(name).toHaveValue('Sample brass sheet');
    await waitFor(
      () =>
        expect(
          screen.getByRole('combobox', { name: 'Base unit' }),
        ).toHaveTextContent('Sample kilogram'),
      WAIT,
    );
    await userEvent.type(name, ' A');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.erp.actions.save }),
    );

    await waitFor(
      () =>
        expect(patches()[0]?.json).toEqual({
          name: 'Sample brass sheet A',
          itemType: 'material',
          unitCode: 'KG',
          spec: 'Sample 2.0mm',
          categoryCode: 'RAW',
          legacyCode: 'L-001',
          note: null,
        }),
      WAIT,
    );
    expect(patches()[0]?.json).not.toHaveProperty('code');
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Saved material "Sample brass sheet A"',
      }),
    ]);
  });

  it('a deactivated item cannot be edited until it is activated', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' && call.path === 'items/i1'
        ? item({ status: 'inactive' })
        : notFound(),
    );
    await renderAt('/items/i1/edit', manager);

    expect(
      await screen.findByText(enUS.items.form.inactive, {}, WAIT),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(patches()).toHaveLength(0);
  });

  it('deactivating asks first; only the confirmation patches the status and the row leaves', async () => {
    let deactivated = false;
    answer = withDictionaries((call) => {
      if (call.method === 'PATCH' && call.path === 'items/i1') {
        deactivated = true;
        return item({ status: 'inactive' });
      }
      if (call.method === 'GET' && call.path === 'items')
        return deactivated ? page(product) : page(item(), product);
      return notFound();
    });
    const view = await renderAt('/items', manager);
    await screen.findByText('Sample brass sheet', {}, WAIT);
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Actions for Sample brass sheet' },
        WAIT,
      ),
    );
    await userEvent.click(
      await screen.findByRole(
        'menuitem',
        { name: enUS.erp.actions.deactivate },
        WAIT,
      ),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Deactivate item "Sample brass sheet"?' },
      WAIT,
    );
    // 点了「停用」不等于停用了：确认之前一个写请求都没有。
    expect(patches()).toHaveLength(0);

    await userEvent.click(
      within(confirm).getByRole('button', {
        name: enUS.erp.actions.deactivate,
      }),
    );
    await waitFor(
      () =>
        expect(
          screen.queryByText('Sample brass sheet'),
        ).not.toBeInTheDocument(),
      WAIT,
    );
    expect(patches().map((call) => [call.path, call.json])).toEqual([
      ['items/i1', { status: 'inactive' }],
    ]);
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Deactivated item "Sample brass sheet"',
      }),
    ]);
  });

  it('a unit that items still use is refused: the sentence stays in the confirm dialog', async () => {
    answer = withDictionaries((call) => {
      if (
        call.method === 'GET' &&
        call.path === 'units' &&
        call.query?.pageSize === '20'
      )
        return page(unit);
      if (call.method === 'PATCH' && call.path === 'units/KG')
        return ruleError(422, 'UNIT_IN_USE', 'Items still use this unit.');
      return notFound();
    });
    const view = await renderAt('/items?view=units', manager);
    await screen.findByText('Sample kilogram', {}, WAIT);
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Actions for Sample kilogram' },
        WAIT,
      ),
    );
    await userEvent.click(
      await screen.findByRole(
        'menuitem',
        { name: enUS.erp.actions.deactivate },
        WAIT,
      ),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Deactivate unit of measure "Sample kilogram"?' },
      WAIT,
    );
    await userEvent.click(
      within(confirm).getByRole('button', {
        name: enUS.erp.actions.deactivate,
      }),
    );

    // 服务端那句话写在框里，框不关，行还在，也没有成功的提示。
    expect(
      await within(confirm).findByText('Items still use this unit.', {}, WAIT),
    ).toBeVisible();
    expect(confirm).toBeInTheDocument();
    expect(screen.getByText('Sample kilogram')).toBeVisible();
    expect(view.toasts()).toEqual([]);
    expect(patches().map((call) => [call.path, call.json])).toEqual([
      ['units/KG', { status: 'inactive' }],
    ]);
  });

  it('creates a unit with an upper-case code and the decimals as a number', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'units'
        ? { ...unit, code: 'BOX', name: 'Sample box', decimals: 3 }
        : notFound();
    const view = await renderAt('/items/units/new', manager);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'box',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample box',
    );
    await userEvent.type(
      within(dialog).getByRole('spinbutton', { name: 'Decimals' }),
      '{backspace}3',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    await waitFor(
      () =>
        expect(posts()[0]?.json).toEqual({
          code: 'BOX',
          name: 'Sample box',
          decimals: 3,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created unit of measure "Sample box"',
      }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/items$/),
      WAIT,
    );
  });

  it('a taken unit code puts the server sentence under the code field', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'units'
        ? ruleError(409, 'UNIT_CODE_TAKEN', 'That unit code is already in use.')
        : notFound();
    await renderAt('/items/units/new', manager);
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'KG',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 一句在上面的提示条里，一句标在编码那一项下面。
    expect(
      await screen.findAllByText('That unit code is already in use.', {}, WAIT),
    ).toHaveLength(2);
  });

  it('editing a unit reads the latest one, keeps the code read-only and sends name and decimals', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'units/KG') return unit;
      if (call.method === 'PATCH' && call.path === 'units/KG')
        return { ...unit, name: 'Sample kilogramme' };
      return notFound();
    };
    const view = await renderAt('/items/units/KG/edit', manager);
    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    expect(name).toHaveValue('Sample kilogram');
    expect(
      within(name.closest('[role="dialog"]')!).getByText('KG'),
    ).toBeVisible();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await userEvent.type(name, 'me');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.erp.actions.save }),
    );

    await waitFor(
      () =>
        expect(patches()[0]?.json).toEqual({
          name: 'Sample kilogramme',
          decimals: 2,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Saved unit of measure "Sample kilogramme"',
      }),
    ]);
  });

  it('creates a root category with a generated id', async () => {
    answer = withDictionaries((call) =>
      call.method === 'POST' && call.path === 'item-categories'
        ? category
        : notFound(),
    );
    const view = await renderAt('/items/categories/new', manager);
    const dialog = await liveDialog('Name');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'raw',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample raw material',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    await waitFor(() => expect(posts()[0]?.path).toBe('item-categories'), WAIT);
    const json = posts()[0]?.json as Record<string, unknown>;
    expect(json).toEqual({
      // id 由前端生成 UUID（契约）。
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      code: 'RAW',
      name: 'Sample raw material',
      parentId: null,
    });
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created item category "Sample raw material"',
      }),
    ]);
  });

  it('editing a category moves it under a parent and never sends the code', async () => {
    answer = withDictionaries((call) => {
      if (call.method === 'GET' && call.path === 'item-categories/c2')
        return childCategory;
      if (call.method === 'PATCH' && call.path === 'item-categories/c2')
        return { ...childCategory, name: 'Sample metal work' };
      return notFound();
    });
    const view = await renderAt('/items/categories/c2/edit', manager);
    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    expect(name).toHaveValue('Sample metal');
    await waitFor(
      () =>
        expect(
          screen.getByRole('combobox', { name: 'Parent category' }),
        ).toHaveTextContent('Sample raw material (RAW)'),
      WAIT,
    );
    await userEvent.type(name, ' work');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.erp.actions.save }),
    );

    await waitFor(
      () =>
        expect(patches()[0]?.json).toEqual({
          name: 'Sample metal work',
          parentId: 'c1',
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Saved item category "Sample metal work"',
      }),
    ]);
  });

  it('the detail drawer shows the item and, for someone who may write, deactivate and edit', async () => {
    answer = withDictionaries((call) =>
      call.method === 'GET' && call.path === 'items/i1' ? item() : notFound(),
    );
    await renderAt('/items/i1', manager);

    const drawer = await screen.findByRole(
      'dialog',
      { name: /Sample brass sheet/ },
      WAIT,
    );
    expect(
      await within(drawer).findAllByText('Sample raw material (RAW)', {}, WAIT),
    ).toHaveLength(1);
    expect(within(drawer).getByText('L-001')).toBeVisible();
    expect(
      await within(drawer).findByRole(
        'button',
        { name: enUS.erp.actions.edit },
        WAIT,
      ),
    ).toHaveAttribute('href', '/items/i1/edit');
    expect(
      within(drawer).getByRole('button', { name: enUS.erp.actions.deactivate }),
    ).toBeEnabled();
  });

  it('a viewer without manage sees no create button and no row menu, and the drawer has no write buttons', async () => {
    let current = '/items';
    answer = withDictionaries((call) => {
      if (call.path === 'items') return page(item());
      if (call.path === 'items/i1') return item();
      return notFound();
    });
    permissions = viewer;
    const first = await renderAt(current, viewer);
    expect(
      await screen.findByText('Sample brass sheet', {}, WAIT),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), WAIT);

    expect(
      screen.queryByRole('button', { name: enUS.items.form.newTitle }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Sample brass sheet' }),
    ).not.toBeInTheDocument();
    first.unmount();
    current = '/items/i1';

    await renderAt(current, viewer);
    const drawer = await screen.findByRole(
      'dialog',
      { name: /Sample brass sheet/ },
      WAIT,
    );
    expect(await within(drawer).findByText('L-001', {}, WAIT)).toBeVisible();
    expect(
      within(drawer).queryByRole('button', { name: enUS.erp.actions.edit }),
    ).not.toBeInTheDocument();
    expect(
      within(drawer).queryByRole('button', {
        name: enUS.erp.actions.deactivate,
      }),
    ).not.toBeInTheDocument();
  });

  it('a viewer opening the new address gets a note, no form, no request', async () => {
    await renderAt('/items/new', viewer);

    expect(
      await screen.findByText(enUS.erp.form.noWrite, {}, WAIT),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
