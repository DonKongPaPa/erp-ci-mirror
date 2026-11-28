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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import InspectionsPage from '../../client/pages/inspections/index.js';
import InspectionNewPage from '../../client/pages/inspections/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/** 来料检验两组页面的自适应验收；数据一律编造，只把 HTTP 换成夹具。 */
const T = 15_000;
const WAIT = { timeout: T };
const AT = '2026-11-28T10:30:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });
const L = enUS.inspections;

const SUMMARY = {
  id: 'ins1',
  docNo: 'JY-20261128-0001',
  inspectionDate: '2026-11-28',
  status: 'pending',
  purchaseOrder: { id: 'po1', orderNo: 'PO-0001', orderDate: '2026-11-27' },
  supplier: { id: 's1', code: 'S01', name: 'Sample Supplier' },
  inspector: { userId: 'u1', name: 'Sample Inspector' },
  remark: '',
  createdAt: AT,
  updatedAt: AT,
};

const grant = (id: string, actions: string[]) => ({ resource: { type: 'composite', id }, actions });
const admin: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
const reader: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('inspectionOrders', ['view'])],
};

let permissions: AuthorizationSnapshot;
let handlers: Readonly<Record<string, (call: ApiCall) => unknown>>;
const answer = (call: ApiCall): unknown => {
  const handler = handlers[`${call.method} ${call.path}`];
  return handler ? handler(call) : notFound();
};
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions' ? { data: permissions } : answer(call),
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
        <Route path='/inspections' element={<InspectionsPage />}>
          <Route path='new' element={<InspectionNewPage />} />
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

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET inspections': () => page(SUMMARY),
    'GET person-options': () => page(),
    'GET inspections/order-options': () => page(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('来料检验页面的内容自适应', () => {
  it('新建表单一列限宽，并有标题与说明', async () => {
    await renderAt('/inspections/new', admin);

    const field = await screen.findByRole(
      'textbox',
      { name: L.fields.inspectionDate },
      WAIT,
    );
    expect(screen.getByRole('heading', { name: L.newTitle })).toBeVisible();
    expect(screen.getByText(L.newDescription)).toBeVisible();
    expect(field.closest('form')?.closest('.max-w-3xl')).not.toBeNull();
  });

  it('列表主操作是常规高度且左侧有图标', async () => {
    await renderAt('/inspections', admin);

    const create = await screen.findByRole('button', { name: L.actions.new }, WAIT);
    expect(create).toHaveClass('h-8');
    expect(create.querySelector('svg')).not.toBeNull();
  });

  it('空态写明原因与下一步，有权限时给带图标的新建入口并可进入新建页', async () => {
    const user = userEvent.setup();
    handlers = { ...handlers, 'GET inspections': () => page() };
    await renderAt('/inspections', admin);

    await screen.findByRole('status', WAIT);
    expect(screen.getByText(L.empty)).toBeVisible();
    const buttons = screen.getAllByRole('button', { name: L.actions.new });
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.querySelector('svg')).not.toBeNull();
    await user.click(buttons[1]!);

    await screen.findByRole('textbox', { name: L.fields.inspectionDate }, WAIT);
    expect(screen.getByRole('heading', { name: L.newTitle })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/inspections/new');
  });

  it('没有新建权限时空态不放新建入口', async () => {
    handlers = { ...handlers, 'GET inspections': () => page() };
    await renderAt('/inspections', reader);

    await screen.findByRole('status', WAIT);
    expect(
      screen.queryByRole('button', { name: L.actions.new }),
    ).not.toBeInTheDocument();
  });

  it('干净表单点取消直接离开，不弹确认', async () => {
    const user = userEvent.setup();
    await renderAt('/inspections/new', admin);

    await screen.findByRole('textbox', { name: L.fields.inspectionDate }, WAIT);
    await user.click(screen.getByRole('button', { name: enUS.actions.cancel }));

    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent('/inspections'),
      WAIT,
    );
    await waitFor(
      () =>
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
      WAIT,
    );
  });

  it('脏表单点取消先确认，点放弃才离开', async () => {
    const user = userEvent.setup();
    await renderAt('/inspections/new', admin);

    const remark = await screen.findByRole('textbox', { name: enUS.erp.fields.note }, WAIT);
    await user.type(remark, 'draft remark');
    await user.click(screen.getByRole('button', { name: enUS.actions.cancel }));

    const dialog = await screen.findByRole('alertdialog', WAIT);
    expect(dialog).toHaveTextContent(L.newTitle);
    expect(screen.getByTestId('location')).toHaveTextContent('/inspections/new');
    await user.click(within(dialog).getByRole('button', { name: L.actions.discard }));
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/inspections'),
      WAIT,
    );
  });

  it('窄屏把列表渲染成卡片而不是表格', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await renderAt('/inspections', admin);

    await screen.findByText(SUMMARY.docNo, {}, WAIT);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    expect(
      within(cards[0]!).getByRole('link', { name: SUMMARY.docNo }),
    ).toBeVisible();
    expect(screen.getByText(/PO-0001/)).toBeVisible();
  });
});
