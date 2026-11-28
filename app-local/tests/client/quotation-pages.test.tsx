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
import QuotationDetailPage from '../../client/pages/quotations/detail/index.js';
import QuotationEditPage from '../../client/pages/quotations/edit.js';
import QuotationsPage from '../../client/pages/quotations/index.js';
import QuotationNewPage from '../../client/pages/quotations/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-022 波 2：报价单页面。真实 hook 与路由容器，只把 HTTP 换成夹具；数据一律编造。
 * 六个合计由服务端算，页面只回显；请求体里不许出现任何一个合计键。
 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-28T08:00:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

const CUSTOMER = { id: 'c1', code: 'C001', name: 'Sample Customer' };
const WAREHOUSE = { id: 'w1', code: 'W01', name: 'Sample Warehouse', status: 'active' };
const PERSON = {
  userId: 'u1',
  name: 'Sample Salesperson',
  departmentId: null,
  departmentName: null,
};
const ITEM = {
  id: 'i1',
  code: 'M2611280001',
  name: 'Sample Steel Sheet',
  spec: null,
  itemType: 'material',
  categoryCode: null,
  unitCode: 'KG',
  status: 'active',
};
const ITEM_SUMMARY = {
  id: ITEM.id,
  code: ITEM.code,
  name: ITEM.name,
  spec: ITEM.spec,
  unitCode: ITEM.unitCode,
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
const SETTLEMENT = { ...PROJECT, id: 's1', dictType: 'settlement', code: 'S1', name: 'Sample Settlement' };
const TAX_RATE = { ...PROJECT, id: 't1', dictType: 'tax_rate', code: '13', name: '13%' };
const L = enUS.quotations;

type Raw = Record<string, unknown>;
function rawQuotation(overrides: Raw = {}): Raw {
  return {
    id: 'r1',
    docNo: 'QT-20261128-0001',
    quoteDate: '2026-11-28',
    validUntil: '2026-12-28',
    status: 'draft',
    expired: false,
    warehouse: WAREHOUSE,
    customer: CUSTOMER,
    contactName: 'Sample Contact',
    contactPhone: '123456',
    deliveryAddress: 'Sample Address',
    projectCode: 'PJ01',
    projectLabel: PROJECT.name,
    settlementCode: 'S1',
    settlementLabel: SETTLEMENT.name,
    customerOrderNo: 'CO-1',
    handler: { userId: PERSON.userId, name: PERSON.name },
    discountAmount: 12,
    totalQty: 10,
    taxIncludedTotal: 2260,
    taxExcludedTotal: 2000,
    taxTotal: 260,
    payableTotal: 2248,
    convertedOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: 'l1',
        quotationId: 'r1',
        itemId: ITEM.id,
        qty: 10,
        price: 226,
        deliveryDate: '2026-12-01',
        taxRate: 13,
        taxExcludedPrice: 200,
        taxExcludedAmount: 2000,
        taxAmount: 260,
        taxIncludedAmount: 2260,
        note: null,
        item: ITEM_SUMMARY,
      },
    ],
    files: [],
    ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawQuotation(overrides);
  return rest;
};

const grant = (id: string, actions: string[]) => ({ resource: { type: 'composite', id }, actions });
/** 销售：六个动作全有。 */
const seller: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('quotations', ['view', 'create', 'update', 'confirm', 'convert', 'void']),
    grant('items', ['view']),
    grant('customers', ['view']),
    grant('inventory', ['warehouseView']),
    grant('bizDict', ['view']),
    grant('bizOptions', ['view']),
  ],
};
/** 只持读与转单的销售子账号：转单入口只在已确定时出现，别的一个写动作都没有。 */
const converter: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('quotations', ['view', 'convert']),
    grant('items', ['view']),
  ],
};
/** 只读会话：一个写入口都不画。 */
const reader: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('quotations', ['view']), grant('items', ['view'])],
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
        <Route path='/quotations' element={<QuotationsPage />}>
          <Route path='new' element={<QuotationNewPage />} />
          <Route path=':quotationId' element={<QuotationDetailPage />}>
            <Route path='edit' element={<QuotationEditPage />} />
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

async function action(name: string) {
  return (
    screen.queryByRole('button', { name }) ??
    screen.queryByRole('link', { name })
  );
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET items': () => page(ITEM),
    'GET partners': () => page(CUSTOMER),
    'GET warehouses': () => page(WAREHOUSE),
    'GET biz-dict/entries': () => page(PROJECT, SETTLEMENT, TAX_RATE),
    'GET person-options': () => page(PERSON),
    'GET quotations': () => page(listRow()),
    'GET quotations/r1': () => rawQuotation(),
  };
});

describe('R-022 波 2 报价单页面', () => {
  it('列表只按端点支持的筛选项取数：状态、客户、项目、有效期与关键字', async () => {
    const user = userEvent.setup();
    await renderAt('/quotations', seller);

    expect(await screen.findByText('QT-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: L.actions.new }, WAIT),
    ).toHaveAttribute('href', '/quotations/new');
    expect(calls('GET', 'quotations').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await choose(user, L.filters.status, L.status.confirmed);
    await waitFor(
      () =>
        expect(calls('GET', 'quotations').at(-1)?.query).toEqual({
          status: 'confirmed',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    await choose(user, L.filters.customer, `${CUSTOMER.code} ${CUSTOMER.name}`);
    await waitFor(
      () =>
        expect(calls('GET', 'quotations').at(-1)?.query).toEqual({
          status: 'confirmed',
          customerId: CUSTOMER.id,
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    await choose(user, L.filters.project, PROJECT.name);
    await waitFor(
      () =>
        expect(calls('GET', 'quotations').at(-1)?.query?.projectCode).toBe(PROJECT.code),
      WAIT,
    );
    const from = await screen.findByRole('textbox', { name: L.filters.validFrom }, WAIT);
    await user.type(from, '2026-11-01');
    await user.tab();
    await waitFor(
      () =>
        expect(calls('GET', 'quotations').at(-1)?.query?.validFrom).toBe('2026-11-01'),
      WAIT,
    );
    expect(
      screen.queryByRole('textbox', { name: /created from/i }),
    ).not.toBeInTheDocument();
  });

  it('新建提交体只有手填字段；六个合计只回显服务端算出的值', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST quotations': (call) => {
        stored.created = call.json;
        stored.quotation = rawQuotation({
          id: 'r9',
          docNo: 'QT-20261128-0002',
          ...(call.json as Raw),
          customer: CUSTOMER,
          warehouse: WAREHOUSE,
          handler: { userId: PERSON.userId, name: PERSON.name },
          lines: [
            {
              ...(rawQuotation().lines as { id: string }[])[0],
              id: 'n1',
              quotationId: 'r9',
            },
          ],
        });
        return stored.quotation;
      },
      'GET quotations/r9': () => stored.quotation,
    };
    await renderAt('/quotations/new', seller);

    await choose(user, L.fields.customer, `${CUSTOMER.code} ${CUSTOMER.name}`);
    const quoteDate = await screen.findByRole('textbox', { name: L.fields.quoteDate }, WAIT);
    await user.clear(quoteDate);
    await user.type(quoteDate, '2026-11-28');
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.validUntil }, WAIT),
      '2026-12-28',
    );
    await choose(user, L.fields.warehouse, `${WAREHOUSE.code} ${WAREHOUSE.name}`);
    await choose(user, L.fields.settlement, SETTLEMENT.name);
    await choose(user, L.fields.project, PROJECT.name);
    await choose(user, L.fields.handler, PERSON.name);
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.customerOrderNo }, WAIT),
      'CO-2',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.contactName }, WAIT),
      'Sample Contact',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.contactPhone }, WAIT),
      '123456',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.deliveryAddress }, WAIT),
      'Sample Address',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.discountAmount }, WAIT),
      '12',
    );
    // LinesEditor 的按钮用的是 orderDocs 的文案，与销售订单明细同一构件。
    await user.click(
      await screen.findByRole('button', { name: enUS.orderDocs.actions.addLine }, WAIT),
    );
    await choose(user, enUS.orderDocs.fields.itemInLine.replace('{{row}}', '1'), `${ITEM.code} ${ITEM.name}`);
    await user.type(
      await screen.findByRole('textbox', { name: enUS.orderDocs.fields.qtyInLine.replace('{{row}}', '1') }, WAIT),
      '10',
    );
    await user.type(
      await screen.findByRole('textbox', { name: enUS.orderDocs.fields.priceInLine.replace('{{row}}', '1') }, WAIT),
      '226',
    );
    const taxRate = await screen.findByRole(
      'textbox',
      { name: enUS.orderDocs.fields.taxRateInLine.replace('{{row}}', '1') },
      WAIT,
    );
    // 新行的税率已经按字典默认值填了 13，这里重写一遍确认可以手填。
    await user.clear(taxRate);
    await user.type(taxRate, '13');
    await user.click(await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT));

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      quoteDate: '2026-11-28',
      validUntil: '2026-12-28',
      customerId: CUSTOMER.id,
      warehouseId: WAREHOUSE.id,
      contactName: 'Sample Contact',
      contactPhone: '123456',
      deliveryAddress: 'Sample Address',
      settlementCode: SETTLEMENT.code,
      projectCode: PROJECT.code,
      customerOrderNo: 'CO-2',
      handlerUserId: PERSON.userId,
      discountAmount: 12,
      fileIds: [],
      lines: [{ itemId: ITEM.id, qty: 10, price: 226, taxRate: 13 }],
    });
    for (const key of ['totalQty', 'taxIncludedTotal', 'taxExcludedTotal', 'taxTotal', 'payableTotal', 'status', 'docNo'])
      expect(stored.created, `${key} 不该由页面算或提交`).not.toHaveProperty(key);

    expect(await screen.findByText('QT-20261128-0002', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('quotation-total-qty')).toHaveTextContent('10');
    expect(screen.getByTestId('quotation-tax-included-total')).toHaveTextContent('¥2,260.00');
    expect(screen.getByTestId('quotation-discount-amount')).toHaveTextContent('¥12.00');
    expect(screen.getByTestId('quotation-payable-total')).toHaveTextContent('¥2,248.00');
    expect(screen.getByTestId('location')).toHaveTextContent('/quotations/r9');
  });

  it.each([
    ['draft', false, ['edit', 'confirm', 'void'], ['convert']],
    ['confirmed', false, ['void', 'convert'], ['edit', 'confirm']],
    ['converted', false, [], ['edit', 'confirm', 'void', 'convert']],
    ['confirmed', true, ['void', 'convert'], ['edit', 'confirm']],
  ] as const)(
    '详情按状态与过期标记显隐动作：%s（expired=%s）',
    async (status, expired, visible, hidden) => {
      handlers = {
        ...handlers,
        'GET quotations/r1': () => rawQuotation({ status, expired }),
      };
      await renderAt('/quotations/r1', seller);

      expect(await screen.findByText('QT-20261128-0001', {}, WAIT)).toBeVisible();
      expect(screen.getByText(L.status[status])).toBeInTheDocument();
      for (const key of visible)
        expect(await action(L.actions[key]), `${key} 应当出现`).not.toBeNull();
      for (const key of hidden)
        expect(await action(L.actions[key]), `${key} 不该出现`).toBeNull();
      if (expired) expect(await screen.findByText(L.expired, {}, WAIT)).toBeVisible();
      else
        await waitFor(
          () => expect(screen.queryByText(L.expired)).not.toBeInTheDocument(),
          WAIT,
        );
    },
  );

  it('已确定的报价单可转一次销售订单，跳到生成的草稿订单', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'GET quotations/r1': () => rawQuotation({ status: 'confirmed' }),
      'POST quotations/r1/create-sales-order': () => ({
        quotation: rawQuotation({ status: 'converted', convertedOrderId: 'o2' }),
        salesOrderId: 'o2',
      }),
    };
    const view = await renderAt('/quotations/r1', converter);

    expect(await screen.findByText('QT-20261128-0001', {}, WAIT)).toBeVisible();
    expect(await action(L.actions.edit)).toBeNull();
    const convert = await screen.findByRole('button', { name: L.actions.convert }, WAIT);
    await user.click(convert);
    await waitFor(
      () =>
        expect(calls('POST', 'quotations/r1/create-sales-order')).toHaveLength(1),
      WAIT,
    );
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/sales-orders/o2'),
      WAIT,
    );
    expect(view.toasts()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'success' })]),
    );
  });

  it('只读会话不画新建、编辑、确定、作废与转销售订单', async () => {
    await renderAt('/quotations/r1', reader);

    expect(await screen.findByText('QT-20261128-0001', {}, WAIT)).toBeVisible();
    for (const key of ['edit', 'confirm', 'void', 'convert'] as const)
      expect(await action(L.actions[key]), `${key} 不该出现`).toBeNull();
    await renderAt('/quotations', reader);
    expect(await screen.findByText('QT-20261128-0001', {}, WAIT)).toBeVisible();
    await waitFor(
      () =>
        expect(
          screen.queryByRole('button', { name: L.actions.new }),
        ).not.toBeInTheDocument(),
      WAIT,
    );
  });
});

// 缺陷 6：默认销售员只预填「当前登录人确实是在职员工」的情况；root/管理员不是员工就留空。
describe('quotation salesperson default (R-022)', () => {
  const sessionOf = (userId: string) => ({
    data: { user: { id: userId }, session: { id: `s-${userId}` } },
  });

  it('prefills the signed-in user only when they are among the active employees', async () => {
    getSession.mockResolvedValue(sessionOf(PERSON.userId));
    await renderAt('/quotations/new', seller);
    const handler = await screen.findByRole('combobox', { name: L.fields.handler }, WAIT);
    expect(handler).toHaveTextContent(PERSON.name);
  });

  it('leaves the salesperson empty for a signed-in user who is not an active employee', async () => {
    getSession.mockResolvedValue(sessionOf('root-admin-not-an-employee'));
    await renderAt('/quotations/new', seller);
    const handler = await screen.findByRole('combobox', { name: L.fields.handler }, WAIT);
    expect(handler).not.toHaveTextContent(PERSON.name);
    expect(handler).not.toHaveTextContent('root-admin-not-an-employee');
  });
});
