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
import PurchaseRequestDetailPage from '../../client/pages/purchase-requests/detail.js';
import PurchaseRequestEditPage from '../../client/pages/purchase-requests/edit.js';
import PurchaseRequestsPage from '../../client/pages/purchase-requests/index.js';
import PurchaseRequestNewPage from '../../client/pages/purchase-requests/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-021 波 2：请购单页面。真实 hook 与路由容器，只把 HTTP 换成夹具；
 * 数据一律编造。表头字段照旧系统原字，合计由服务端算、页面只回显。
 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-27T08:00:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

const DEPARTMENT = { id: 'd1', name: 'Sample Planning Dept' };
const PERSON = {
  userId: 'u1',
  name: 'Sample Requester',
  departmentId: 'd1',
  departmentName: 'Sample Planning Dept',
};
const PROJECT = {
  id: 'pj1',
  dictType: 'project',
  code: 'PJ01',
  name: 'Sample Project',
  rate: null,
  isDefault: false,
  sort: 1,
};
const ITEM_A = {
  id: 'i1',
  code: 'M2611180001',
  name: 'Sample Steel Sheet',
  spec: null,
  itemType: 'material',
  categoryCode: null,
  unitCode: 'KG',
  status: 'active',
};
const ITEM_B = {
  ...ITEM_A,
  id: 'i2',
  code: 'M2611180002',
  name: 'Sample Aluminum Bar',
};
const L = enUS.purchaseRequests;

type Raw = Record<string, unknown>;
function rawRequest(overrides: Raw = {}): Raw {
  return {
    id: 'r1',
    docNo: 'QG-20261127-0001',
    requestDate: '2026-11-27',
    status: 'draft',
    department: DEPARTMENT,
    requester: { userId: PERSON.userId, name: PERSON.name },
    projectCode: PROJECT.code,
    projectLabel: PROJECT.name,
    customText1: 'Custom one',
    customText2: 'Custom two',
    description: 'Sample description',
    approvalId: null,
    convertedOrderId: null,
    totalQty: 20,
    estimatedTotal: 100,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: 'l1',
        itemId: ITEM_A.id,
        qty: 10,
        expectedPrice: 5,
        expectedAmount: 50,
        item: {
          id: ITEM_A.id,
          code: ITEM_A.code,
          name: ITEM_A.name,
          spec: null,
          unitCode: ITEM_A.unitCode,
        },
      },
      {
        id: 'l2',
        itemId: ITEM_B.id,
        qty: 10,
        expectedPrice: 5,
        expectedAmount: 50,
        item: {
          id: ITEM_B.id,
          code: ITEM_B.code,
          name: ITEM_B.name,
          spec: null,
          unitCode: ITEM_B.unitCode,
        },
      },
    ],
    files: [],
    ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawRequest(overrides);
  return rest;
};

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
/** planning / staff 的会话：建改提交作废与读，没有转订单。 */
const writer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('purchaseRequests', ['view', 'create', 'update', 'submit', 'void']),
    grant('items', ['view']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
};
/** purchase 的会话：只读与转订单。 */
const buyer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('purchaseRequests', ['view', 'convert']),
    grant('items', ['view']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
};
/** 只被授予读的人：没有任何写入口。 */
const reader: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('purchaseRequests', ['view']), grant('items', ['view'])],
};

let permissions: AuthorizationSnapshot;
let handlers: Readonly<Record<string, (call: ApiCall) => unknown>>;
const answer = (call: ApiCall): unknown => {
  const handler = handlers[`${call.method} ${call.path}`];
  return handler ? handler(call) : notFound();
};
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
        <Route path='/purchase-requests' element={<PurchaseRequestsPage />}>
          <Route path='new' element={<PurchaseRequestNewPage />} />
          <Route path=':purchaseRequestId' element={<PurchaseRequestDetailPage />}>
            <Route path='edit' element={<PurchaseRequestEditPage />} />
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

const calls = (method: string, path: string): ApiCall[] =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === method && call.path === path);

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name }, WAIT));
  await user.click(await screen.findByRole('option', { name: option }, WAIT));
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET items': () => page(ITEM_A, ITEM_B),
    'GET department-options': () => page(DEPARTMENT),
    'GET person-options': () => page(PERSON),
    'GET biz-dict/entries': () => page(PROJECT),
    'GET purchase-requests': () => page(listRow()),
    'GET purchase-requests/r1': () => rawRequest(),
  };
});

describe('R-021 请购单页面', () => {
  it('列表按端点支持的筛选项取数：状态、请购部门与日期，不发明关键字参数', async () => {
    const user = userEvent.setup();
    await renderAt('/purchase-requests', writer);

    expect(await screen.findByText('QG-20261127-0001', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: L.actions.new }, WAIT),
    ).toHaveAttribute('href', '/purchase-requests/new');
    // 端点没有 q：不画搜索框，也不往地址栏写 q。
    expect(calls('GET', 'purchase-requests').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await choose(user, L.filters.status, L.status.approved);
    await waitFor(
      () =>
        expect(calls('GET', 'purchase-requests').at(-1)?.query).toEqual({
          status: 'approved',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    await choose(user, L.filters.department, DEPARTMENT.name);
    await waitFor(
      () =>
        expect(calls('GET', 'purchase-requests').at(-1)?.query).toEqual({
          status: 'approved',
          departmentId: DEPARTMENT.id,
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    const from = await screen.findByRole('textbox', { name: L.filters.from }, WAIT);
    await user.type(from, '2026-11-01');
    await user.tab();
    await waitFor(
      () =>
        expect(
          calls('GET', 'purchase-requests').at(-1)?.query?.from,
        ).toEqual(expect.any(String)),
      WAIT,
    );
    expect(
      screen.queryByRole('textbox', { name: /keyword/i }),
    ).not.toBeInTheDocument();
  });

  it('新建提交契约里的表头字段与明细，详情回显服务端算出的表尾合计', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      [`POST purchase-requests`]: (call) => {
        stored.created = call.json;
        stored.request = rawRequest({
          id: 'r9',
          docNo: 'QG-20261127-0002',
          ...(call.json as Raw),
          department: DEPARTMENT,
          requester: { userId: PERSON.userId, name: PERSON.name },
          projectLabel: PROJECT.name,
          status: 'draft',
          totalQty: 10,
          estimatedTotal: 50,
          lines: [
            {
              id: 'n1',
              itemId: ITEM_A.id,
              qty: 10,
              expectedPrice: 5,
              expectedAmount: 50,
              item: {
                id: ITEM_A.id,
                code: ITEM_A.code,
                name: ITEM_A.name,
                spec: null,
                unitCode: ITEM_A.unitCode,
              },
            },
          ],
          files: [],
        });
        return stored.request;
      },
      'GET purchase-requests/r9': () => stored.request,
      'POST purchase-requests/r9/lines': () => stored.request,
    };
    const view = await renderAt('/purchase-requests/new', writer);

    await choose(user, L.fields.department, DEPARTMENT.name);
    await choose(user, L.fields.requester, PERSON.name);
    await choose(user, L.fields.project, PROJECT.name);
    const dateField = await screen.findByRole(
      'textbox',
      { name: L.fields.requestDate },
      WAIT,
    );
    await user.clear(dateField);
    await user.type(dateField, '2026-11-27');
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.customText1 }, WAIT),
      'C1',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.customText2 }, WAIT),
      'C2',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.description }, WAIT),
      'Sample description',
    );
    await user.click(
      await screen.findByRole('button', { name: L.actions.addLine }, WAIT),
    );
    await choose(
      user,
      L.fields.itemLine.replace('{{n}}', '1'),
      `${ITEM_A.code} ${ITEM_A.name}`,
    );
    await user.type(
      await screen.findByRole(
        'textbox',
        { name: L.fields.qtyLine.replace('{{n}}', '1') },
        WAIT,
      ),
      '10',
    );
    await user.type(
      await screen.findByRole(
        'textbox',
        { name: L.fields.expectedPriceLine.replace('{{n}}', '1') },
        WAIT,
      ),
      '5',
    );
    await user.click(
      await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT),
    );

    await waitFor(
      () =>
        expect(stored.created).toEqual({
          requestDate: '2026-11-27',
          departmentId: DEPARTMENT.id,
          requesterUserId: PERSON.userId,
          projectCode: PROJECT.code,
          customText1: 'C1',
          customText2: 'C2',
          description: 'Sample description',
          fileIds: [],
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: L.toasts.created.replace('{{name}}', 'QG-20261127-0002'),
      }),
    ]);
    // 保存后到了这张单的详情：表尾只回显服务端算出来的两个合计，页面不自己加。
    expect(await screen.findByText('QG-20261127-0002', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('request-total-qty')).toHaveTextContent('10');
    expect(screen.getByTestId('request-estimated-total')).toHaveTextContent(
      '50.00',
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/purchase-requests/r9',
    );
  });

  // 缺陷 4：服务端慢一点时，FeedbackForm 的「保存中」先结束，离开守卫会把成功后的导航挡住。
  it('a slow save still navigates to the detail without a discard prompt', async () => {
    const user = userEvent.setup();
    const saved = rawRequest({
      id: 'r-slow',
      docNo: 'QG-20261127-0003',
      status: 'draft',
      lines: [],
      totalQty: 0,
      estimatedTotal: 0,
    });
    handlers = {
      ...handlers,
      'POST purchase-requests': async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return saved;
      },
      'POST purchase-requests/r-slow/lines': () => saved,
      'GET purchase-requests/r-slow': () => saved,
    };
    await renderAt('/purchase-requests/new', writer);
    await choose(user, L.fields.department, DEPARTMENT.name);
    await choose(user, L.fields.requester, PERSON.name);
    const dateField = await screen.findByRole('textbox', { name: L.fields.requestDate }, WAIT);
    await user.clear(dateField);
    await user.type(dateField, '2026-11-27');
    await user.click(await screen.findByRole('button', { name: L.actions.addLine }, WAIT));
    await choose(user, L.fields.itemLine.replace('{{n}}', '1'), `${ITEM_A.code} ${ITEM_A.name}`);
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.qtyLine.replace('{{n}}', '1') }, WAIT),
      '10',
    );
    await user.click(await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT));

    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/purchase-requests/r-slow'),
      WAIT,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each([
    ['draft', 'draft', true, false],
    ['approving', 'approving', false, false],
    ['approved', 'approved', false, false],
    ['rejected', 'rejected', true, false],
  ] as const)(
    '详情按状态显隐写动作：%s',
    async (status, label, editable, _unknown) => {
      handlers = {
        ...handlers,
        'GET purchase-requests/r1': () => rawRequest({ status }),
      };
      await renderAt('/purchase-requests/r1', writer);

      expect(await screen.findByText('QG-20261127-0001', {}, WAIT)).toBeVisible();
      expect(screen.getByText(L.status[label])).toBeInTheDocument();
      for (const name of [L.actions.edit, L.actions.submit, L.actions.void]) {
        const button =
          screen.queryByRole('button', { name }) ??
          screen.queryByRole('link', { name });
        if (editable) expect(button).toBeInTheDocument();
        else expect(button).not.toBeInTheDocument();
      }
      // writer 没有 convert 动作：任何一种状态都不画转采购订单。
      expect(
        screen.queryByRole('button', { name: L.actions.convert }),
      ).not.toBeInTheDocument();
    },
  );

  it('purchase 会话只在已通过时看到转采购订单，跳到生成的草稿订单', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'GET purchase-requests/r1': () => rawRequest({ status: 'approved' }),
      'POST purchase-requests/r1/create-order': () => ({
        request: rawRequest({ status: 'converted', convertedOrderId: 'o2' }),
        purchaseOrderId: 'o2',
      }),
    };
    const view = await renderAt('/purchase-requests/r1', buyer);

    expect(await screen.findByText('QG-20261127-0001', {}, WAIT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: L.actions.edit }),
    ).not.toBeInTheDocument();
    const convert = await screen.findByRole(
      'button',
      { name: L.actions.convert },
      WAIT,
    );
    await user.click(convert);
    await waitFor(
      () =>
        expect(calls('POST', 'purchase-requests/r1/create-order')).toHaveLength(
          1,
        ),
      WAIT,
    );
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          '/purchase-orders/o2',
        ),
      WAIT,
    );
    expect(view.toasts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'success' }),
      ]),
    );
  });

  it('只读会话不画新建、编辑、提交、作废与转采购订单', async () => {
    await renderAt('/purchase-requests/r1', reader);

    expect(await screen.findByText('QG-20261127-0001', {}, WAIT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: L.actions.edit }) ??
        screen.queryByRole('link', { name: L.actions.edit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: L.actions.submit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: L.actions.void }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: L.actions.convert }),
    ).not.toBeInTheDocument();
  });
});
