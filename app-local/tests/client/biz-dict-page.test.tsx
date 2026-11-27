import { apiClientToken } from '@nocobase/app-client';
import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
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
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import BizDictEditPage from '../../client/pages/biz-dict/edit.js';
import BizDictPage from '../../client/pages/biz-dict/index.js';
import BizDictNewPage from '../../client/pages/biz-dict/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-072 业务字典页。真实的应用 hook 与路由容器，只把 HTTP 换成夹具；示例取值一律编造。
 * 只读的人持 bizDict.view，维护的人持 bizDict.manage，显隐按动作而不是按角色名。
 */
const T = 15_000;
const WAIT = { timeout: T };
const manager: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
const viewer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'composite', id: 'bizDict' }, actions: ['view'] },
  ],
};
const readOnly: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [],
};

/** 页面文案就用应用自己的语言包；夹具只替换 HTTP，不另造一份译文。 */
const copy = { bizDict: enUS.bizDict };

const types = [
  'project',
  'settlement',
  'supplier_group',
  'customer_group',
  'income_type',
  'expense_type',
  'invoice_type',
  'tax_rate',
  'fund_account',
].map((dictType) => ({ dictType, label: `Sample ${dictType}` }));

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    dictType: 'tax_rate',
    code: 'RATE-13',
    name: 'Sample 13 percent',
    rate: 13,
    startDate: null,
    endDate: null,
    description: null,
    isDefault: true,
    sort: 1,
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

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

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/biz-dict' element={<BizDictPage />}>
          <Route path='new' element={<BizDictNewPage />} />
          <Route path=':entryId/edit' element={<BizDictEditPage />} />
        </Route>
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: { ...enUS, ...copy } },
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

const calls = (method: string) =>
  api.mock.calls.map(([call]) => call).filter((call) => call.method === method);
const notFound = () => new Response(null, { status: 404 });

async function listFixture() {
  answer = (call) => {
    if (call.method === 'GET' && call.path === 'biz-dict/types')
      return { items: types };
    if (call.method === 'GET' && call.path === 'biz-dict/entries')
      return page(entry());
    return notFound();
  };
  await renderAt('/biz-dict?type=tax_rate', viewer);
  // 真的等到目标行，再做「不存在」断言。
  return screen.findByText('Sample 13 percent', {}, WAIT);
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-072 业务字典页', () => {
  it('renders nine types and the active entries of the selected type', async () => {
    await listFixture();

    expect(await screen.findAllByRole('tab', {}, WAIT)).toHaveLength(9);
    expect(
      await screen.findByRole('tab', { name: 'Sample tax_rate' }, WAIT),
    ).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('RATE-13', {}, WAIT)).toBeInTheDocument();
    expect(
      calls('GET').find(
        (call) => call.path === 'biz-dict/entries' &&
          call.query?.dictType === 'tax_rate',
      ),
    ).toBeDefined();
  });

  it('sends status=all while include deactivated is checked, status=active once it is unchecked', async () => {
    const active = entry();
    const inactive = entry({
      id: 'e2',
      code: 'RATE-05',
      name: 'Sample 5 percent (inactive)',
      status: 'inactive',
      sort: 2,
    });
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'biz-dict/types')
        return { items: types };
      if (call.method === 'GET' && call.path === 'biz-dict/entries')
        return call.query?.status === 'all' ? page(active, inactive) : page(active);
      return notFound();
    };
    await renderAt('/biz-dict?type=tax_rate', manager);
    await screen.findByText(active.name, {}, WAIT);

    const lastListStatus = () =>
      calls('GET')
        .filter((call) => call.path === 'biz-dict/entries')
        .at(-1)?.query?.status;
    expect(lastListStatus()).toBe('active');

    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Include deactivated' }, WAIT),
    );
    expect(await screen.findByText(inactive.name, {}, WAIT)).toBeInTheDocument();
    expect(lastListStatus()).toBe('all');

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Include deactivated' }),
    );
    await waitFor(
      () => expect(screen.queryByText(inactive.name)).not.toBeInTheDocument(),
      WAIT,
    );
    expect(lastListStatus()).toBe('active');
  });

  it('shows write entries only to a session holding bizDict.manage', async () => {
    await listFixture();

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: copy.bizDict.actions.new }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', {
          name: `Actions for ${entry().name}`,
        }),
      ).not.toBeInTheDocument();
    }, WAIT);

    await renderAt('/biz-dict?type=tax_rate', manager);
    expect(
      await screen.findByRole('button', { name: copy.bizDict.actions.new }, WAIT),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole(
        'button',
        { name: `Actions for ${entry().name}` },
        WAIT,
      ),
    ).toBeInTheDocument();
  });

  it('submits the narrow create body shape to the dictionary endpoint', async () => {
    answer = () => ({ items: types });
    await renderAt('/biz-dict/new?type=tax_rate', manager);

    const code = await screen.findByRole('textbox', { name: 'Code' }, WAIT);
    await userEvent.type(code, 'RATE-15');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'Sample 15 percent',
    );
    await userEvent.type(
      screen.getByRole('spinbutton', { name: 'Rate (%)' }),
      '15',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create' }),
    );

    await waitFor(() => {
      const post = calls('POST').find(
        (call) => call.path === 'biz-dict/entries',
      );
      expect(post?.json).toEqual({
        dictType: 'tax_rate',
        code: 'RATE-15',
        name: 'Sample 15 percent',
        rate: 15,
      });
    }, WAIT);
  });

  it('opens the edit dialog from the list row and saves a narrow PATCH body without a detail GET', async () => {
    const original = entry();
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'biz-dict/types')
        return { items: types };
      if (call.method === 'GET' && call.path === 'biz-dict/entries')
        return page(original);
      if (call.method === 'PATCH' && call.path === 'biz-dict/entries/e1')
        return original;
      return notFound();
    };
    await renderAt('/biz-dict/e1/edit?type=tax_rate', manager);

    // 对话框先画「加载中」，真的等到表单字段再断言（loading 状态下没有 Name 输入框）。
    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    const dialog = name.closest<HTMLElement>('[role="dialog"]')!;
    expect(name).toHaveValue('Sample 13 percent');
    const rate = await within(dialog).findByRole(
      'spinbutton',
      { name: 'Rate (%)' },
      WAIT,
    );
    expect(rate).toHaveValue(13);
    const save = await within(dialog).findByRole(
      'button',
      { name: 'Save' },
      WAIT,
    );
    await userEvent.clear(name);
    await userEvent.type(name, 'Sample 14 percent');
    await userEvent.clear(rate);
    await userEvent.type(rate, '14');
    await userEvent.click(save);

    await waitFor(() => {
      const patch = calls('PATCH').find(
        (call) => call.path === 'biz-dict/entries/e1',
      );
      expect(patch?.json).toEqual({
        name: 'Sample 14 percent',
        rate: 14,
        isDefault: true,
        sort: 1,
      });
    }, WAIT);
    // 旧实现在这里 GET 一个并不存在的详情端点，弹窗永远打不开。
    expect(
      calls('GET').some((call) => call.path === 'biz-dict/entries/e1'),
    ).toBe(false);
  });

  it('opens edit from the row menu without fetching a nonexistent detail endpoint', async () => {
    const original = entry();
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'biz-dict/types')
        return { items: types };
      if (call.method === 'GET' && call.path === 'biz-dict/entries')
        return page(original);
      return notFound();
    };
    await renderAt('/biz-dict?type=tax_rate', manager);
    await screen.findByText(original.name, {}, WAIT);
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: `Actions for ${original.name}` },
        WAIT,
      ),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Edit' }, WAIT),
    );

    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    expect(name).toHaveValue(original.name);
    expect(
      calls('GET').some((call) => call.path === 'biz-dict/entries/e1'),
    ).toBe(false);
  });

  it('reactivates a deactivated value through PATCH', async () => {
    const inactive = entry({
      name: 'Sample 13 (inactive)',
      status: 'inactive',
    });
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'biz-dict/types')
        return { items: types };
      if (call.method === 'GET' && call.path === 'biz-dict/entries')
        return call.query?.status === 'all' ? page(inactive) : page(entry());
      if (call.method === 'PATCH' && call.path === 'biz-dict/entries/e1')
        return entry();
      return notFound();
    };
    await renderAt('/biz-dict?type=tax_rate', manager);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Include deactivated' }, WAIT),
    );
    const menu = await screen.findByRole(
      'button',
      { name: `Actions for ${inactive.name}` },
      WAIT,
    );
    await userEvent.click(menu);
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Activate' }, WAIT),
    );

    await waitFor(() => {
      const patch = calls('PATCH').find(
        (call) => call.path === 'biz-dict/entries/e1',
      );
      expect(patch?.json).toEqual({ status: 'active' });
    }, WAIT);
  });

  it('deactivates through PATCH and never offers a delete', async () => {
    await listFixture();
    // 从只读换成可维护的会话再看操作列。
    await renderAt('/biz-dict?type=tax_rate', manager);
    const menu = await screen.findByRole(
      'button',
      { name: `Actions for ${entry().name}` },
      WAIT,
    );
    await userEvent.click(menu);
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Deactivate' }, WAIT),
    );
    const confirm = await screen.findByRole(
      'button',
      { name: 'Deactivate' },
      WAIT,
    );
    await userEvent.click(confirm);

    await waitFor(() => {
      const patch = calls('PATCH').find(
        (call) => call.path === 'biz-dict/entries/e1',
      );
      expect(patch?.json).toEqual({ status: 'inactive' });
    }, WAIT);
    expect(
      calls('DELETE').some((call) => call.path.startsWith('biz-dict/entries')),
    ).toBe(false);
  });

  it('does not show write entries to a session without any dictionary action', async () => {
    answer = (call) => {
      if (call.path === 'biz-dict/types') return { items: types };
      if (call.path === 'biz-dict/entries') return page(entry());
      return notFound();
    };
    await renderAt('/biz-dict?type=tax_rate', readOnly);

    expect(
      await screen.findByText('Sample 13 percent', {}, WAIT),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: copy.bizDict.actions.new }),
    ).not.toBeInTheDocument();
  });
});
