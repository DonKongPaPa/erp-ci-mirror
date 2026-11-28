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
import FinanceRequestDetailPage from '../../client/pages/finance-requests/detail.js';
import FinanceRequestEditPage from '../../client/pages/finance-requests/edit.js';
import FinanceRequestsPage from '../../client/pages/finance-requests/index.js';
import FinanceRequestNewPage from '../../client/pages/finance-requests/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-066 页面片：请款单与报销单的组件测试。真实 hook 与路由容器，只把 HTTP 换成夹具；
 * 数据一律编造。服务端按授权决定行级范围，页面只按会话持有的动作显隐入口、不自己过滤。
 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-28T08:00:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

const TYPE = {
  id: 't1',
  dictType: 'expense_type',
  code: 'TRAVEL',
  name: 'Sample Travel',
  rate: null,
  isDefault: false,
  sort: 1,
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
const PERSON = {
  userId: 'u1',
  name: 'Sample Handler',
  departmentId: null,
  departmentName: null,
};
const L = enUS.financeRequestDocs;

type Raw = Record<string, unknown>;
function rawRequest(overrides: Raw = {}): Raw {
  return {
    id: 'r1',
    docType: 'payment_request',
    docNo: 'QK-20261128-0001',
    requestDate: '2026-11-28',
    status: 'draft',
    expenseTypeCode: TYPE.code,
    expenseTypeLabel: TYPE.name,
    amount: 50,
    reason: 'Sample reason',
    handler: { userId: PERSON.userId, name: PERSON.name },
    projectCode: PROJECT.code,
    projectLabel: PROJECT.name,
    approvalId: null,
    expenseRecordId: null,
    createdAt: NOW,
    updatedAt: NOW,
    files: [],
    ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { files: _files, ...rest } = rawRequest(overrides);
  return rest;
};

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
/** staff 的会话：建改提交作废与读，没有转支出。 */
const writer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('financeRequests', ['view', 'create', 'update', 'submit', 'void']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
};
/** finance 的会话：读全部与转支出，不能改草稿。 */
const finance: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('financeRequests', ['view', 'convert']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
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
        <Route path='/finance-requests' element={<FinanceRequestsPage />}>
          <Route path='new' element={<FinanceRequestNewPage />} />
          <Route path=':financeRequestId' element={<FinanceRequestDetailPage />}>
            <Route path='edit' element={<FinanceRequestEditPage />} />
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
    'GET person-options': () => page(PERSON),
    'GET biz-dict/entries': (call) =>
      page(call.query?.dictType === 'expense_type' ? TYPE : PROJECT),
    'GET finance-requests': () =>
      page(listRow(), listRow({ id: 'r2', docNo: 'BX-20261128-0001', docType: 'expense_claim' })),
    'GET finance-requests/r1': () => rawRequest(),
  };
});

describe('R-066 请款单与报销单页面', () => {
  it('列表按端点支持的筛选项取数：类型、状态、类型码、项目与日期，不发明关键字参数', async () => {
    const user = userEvent.setup();
    await renderAt('/finance-requests', writer);

    expect(await screen.findByText('QK-20261128-0001', {}, WAIT)).toBeVisible();
    // 端点回什么显示什么：两种类型都在，页面不按经办人再过滤。
    expect(await screen.findByText('BX-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: L.actions.new }, WAIT),
    ).toHaveAttribute('href', '/finance-requests/new');
    expect(calls('GET', 'finance-requests').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await choose(user, L.filters.docType, L.docTypes.expense_claim);
    await waitFor(
      () =>
        expect(calls('GET', 'finance-requests').at(-1)?.query).toEqual({
          docType: 'expense_claim',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    await choose(user, L.filters.status, L.status.approved);
    await waitFor(
      () =>
        expect(calls('GET', 'finance-requests').at(-1)?.query?.status).toBe(
          'approved',
        ),
      WAIT,
    );
    await choose(user, L.filters.expenseType, TYPE.name);
    await waitFor(
      () =>
        expect(calls('GET', 'finance-requests').at(-1)?.query?.expenseTypeCode).toBe(
          TYPE.code,
        ),
      WAIT,
    );
    await choose(user, L.filters.project, PROJECT.name);
    await waitFor(
      () =>
        expect(calls('GET', 'finance-requests').at(-1)?.query?.projectCode).toBe(
          PROJECT.code,
        ),
      WAIT,
    );
    const from = await screen.findByRole('textbox', { name: L.filters.from }, WAIT);
    await user.type(from, '2026-11-01');
    await user.tab();
    await waitFor(
      () =>
        expect(
          calls('GET', 'finance-requests').at(-1)?.query?.from,
        ).toEqual(expect.any(String)),
      WAIT,
    );
    expect(
      screen.queryByRole('textbox', { name: /keyword/i }),
    ).not.toBeInTheDocument();
  });

  it('新建两种类型各提交一条契约形状的请求体', async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    handlers = {
      ...handlers,
      'POST finance-requests': (call) => {
        created.push(call.json);
        return rawRequest({
          id: 'r9',
          docNo: 'QK-20261128-0009',
          ...(call.json as Raw),
          handler: { userId: PERSON.userId, name: PERSON.name },
          expenseTypeLabel: TYPE.name,
          projectLabel: PROJECT.name,
          status: 'draft',
          files: [],
        });
      },
      'GET finance-requests/r9': () =>
        rawRequest({ id: 'r9', docNo: 'QK-20261128-0009' }),
    };

    // 请款单：选经办人，请求体带 handlerUserId。
    await renderAt('/finance-requests/new', writer);
    await choose(user, L.fields.docType, L.docTypes.payment_request);
    await choose(user, L.fields.expenseType, TYPE.name);
    await choose(user, L.fields.handler, PERSON.name);
    await choose(user, L.fields.project, PROJECT.name);
    const amount = await screen.findByRole('textbox', { name: L.fields.amount }, WAIT);
    await user.type(amount, '50.25');
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.reason }, WAIT),
      'Sample reason',
    );
    await user.click(
      await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT),
    );
    await waitFor(() => expect(created).toHaveLength(1), WAIT);
    expect(created[0]).toEqual({
      docType: 'payment_request',
      requestDate: expect.any(String),
      expenseTypeCode: TYPE.code,
      amount: 50.25,
      reason: 'Sample reason',
      handlerUserId: PERSON.userId,
      projectCode: PROJECT.code,
      fileIds: [],
    });
  });

  it('新建报销单：经办人不选时不带该键，交给服务端默认登录人', async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    handlers = {
      ...handlers,
      'POST finance-requests': (call) => {
        created.push(call.json);
        return rawRequest({
          id: 'r8',
          docNo: 'BX-20261128-0008',
          docType: 'expense_claim',
          ...(call.json as Raw),
          handler: { userId: PERSON.userId, name: PERSON.name },
          status: 'draft',
          files: [],
        });
      },
      'GET finance-requests/r8': () =>
        rawRequest({ id: 'r8', docNo: 'BX-20261128-0008', docType: 'expense_claim' }),
    };

    await renderAt('/finance-requests/new', writer);
    await choose(user, L.fields.docType, L.docTypes.expense_claim);
    const amount = await screen.findByRole('textbox', { name: L.fields.amount }, WAIT);
    await user.type(amount, '88');
    await user.click(
      await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT),
    );
    await waitFor(() => expect(created).toHaveLength(1), WAIT);
    expect(created[0]).toEqual({
      docType: 'expense_claim',
      requestDate: expect.any(String),
      amount: 88,
      reason: '',
      fileIds: [],
    });
  });

  it.each([
    ['draft', true, true, true],
    ['approving', false, false, false],
    ['approved', false, false, false],
    ['rejected', true, true, true],
  ] as const)(
    '详情按状态显隐写动作：%s',
    async (status, editable, submittable, voidable) => {
      handlers = {
        ...handlers,
        'GET finance-requests/r1': () => rawRequest({ status }),
      };
      await renderAt('/finance-requests/r1', writer);

      expect(await screen.findByText('QK-20261128-0001', {}, WAIT)).toBeVisible();
      expect(screen.getByText(L.status[status])).toBeInTheDocument();
      const link =
        screen.queryByRole('link', { name: L.actions.edit }) ??
        screen.queryByRole('button', { name: L.actions.edit });
      expect(Boolean(link)).toBe(editable);
      expect(
        Boolean(screen.queryByRole('button', { name: L.actions.submit })),
      ).toBe(submittable);
      expect(
        Boolean(screen.queryByRole('button', { name: L.actions.void })),
      ).toBe(voidable);
      // writer 没有 convert 动作：任何一种状态都不画转支出记录。
      expect(
        screen.queryByRole('button', { name: L.actions.convert }),
      ).not.toBeInTheDocument();
    },
  );

  it('finance 会话只在已通过时看到转支出记录，跳到生成的草稿', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'GET finance-requests/r1': () => rawRequest({ status: 'approved' }),
      'POST finance-requests/r1/create-expense': () => ({
        request: rawRequest({ status: 'converted', expenseRecordId: 'e2' }),
        expenseRecordId: 'e2',
      }),
    };
    const view = await renderAt('/finance-requests/r1', finance);

    expect(await screen.findByText('QK-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: L.actions.submit }),
    ).not.toBeInTheDocument();
    const convert = await screen.findByRole(
      'button',
      { name: L.actions.convert },
      WAIT,
    );
    await user.click(convert);
    await waitFor(
      () =>
        expect(calls('POST', 'finance-requests/r1/create-expense')).toHaveLength(
          1,
        ),
      WAIT,
    );
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent('/expenses/e2'),
      WAIT,
    );
    expect(view.toasts()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'success' })]),
    );
  });

  it('草稿详情有审批入口时给出链接，转过的单给出支出记录链接', async () => {
    handlers = {
      ...handlers,
      'GET finance-requests/r1': () =>
        rawRequest({ approvalId: 'a1', expenseRecordId: 'e2', status: 'converted' }),
    };
    await renderAt('/finance-requests/r1', finance);

    expect(await screen.findByText('QK-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('link', { name: L.actions.openApproval }, WAIT),
    ).toHaveAttribute('href', '/approvals/a1');
    expect(
      await screen.findByRole('link', { name: L.actions.openRecord }, WAIT),
    ).toHaveAttribute('href', '/expenses/e2');
  });
});
