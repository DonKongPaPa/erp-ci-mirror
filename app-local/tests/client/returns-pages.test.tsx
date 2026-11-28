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
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import PurchaseReturnsDetailPage from '../../client/pages/purchase-returns/detail.js';
import PurchaseReturnsListPage from '../../client/pages/purchase-returns/index.js';
import PurchaseReturnsNewPage from '../../client/pages/purchase-returns/new.js';
import SalesReturnsListPage from '../../client/pages/sales-returns/index.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/** R-020 波 2 加片二：退货页面。真实 hook 与路由容器，HTTP 用夹具，数据一律编造。 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-27T08:00:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const rejected = (reason: string): Response =>
  Response.json(
    {
      error: {
        message: 'raw',
        reason,
        localizedMessage: { locale: 'en-US', message: 'raw' },
      },
    },
    { status: 422 },
  );
const page = (...items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

const WAREHOUSE = { id: 'w1', code: 'WH01', name: 'Sample Main Warehouse', status: 'active' };
const HANDLER = {
  userId: 'u1',
  name: 'Sample Handler',
  departmentId: 'd1',
  departmentName: 'Sample Dept',
};
const ITEM = {
  id: 'i1',
  code: 'M2611180001',
  name: 'Sample Steel Sheet',
  spec: null,
  unitCode: 'KG',
};
const SOURCE = {
  id: 'sd1',
  docNo: 'RK-20261127-0001',
  docDate: '2026-11-27',
  partner: { id: 'p1', code: 'SUP1', name: 'Sample Supplier' },
  lines: [
    {
      sourceLineId: 'sl1',
      itemId: ITEM.id,
      warehouseId: WAREHOUSE.id,
      batchNo: 'B1',
      remainQty: 10,
    },
  ],
};
const ORDER = {
  id: 'o1',
  orderNo: 'PO-20261127-0001',
  orderDate: '2026-11-27',
  status: 'ordered',
  remark: '',
  warehouseId: WAREHOUSE.id,
  supplier: { id: 'p1', code: 'SUP1', name: 'Sample Supplier' },
  submittedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  lines: [
    {
      id: 'ol1',
      itemId: ITEM.id,
      qty: 10,
      receivedQty: 8,
      remainingQty: 2,
    },
  ],
};
const L = enUS.returns;

type Raw = Record<string, unknown>;
function rawReturn(overrides: Raw = {}): Raw {
  return {
    id: 'r1',
    docNo: 'TH-20261127-0001',
    docType: 'purchase',
    sourceType: 'stock_doc',
    sourceId: SOURCE.id,
    status: 'draft',
    partner: SOURCE.partner,
    handler: { userId: HANDLER.userId, name: HANDLER.name },
    warehouse: { id: WAREHOUSE.id, name: WAREHOUSE.name },
    remark: 'Sample return remark',
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: 'rl1',
        sourceLineId: 'sl1',
        itemId: ITEM.id,
        warehouseId: WAREHOUSE.id,
        batchNo: 'B1',
        qty: 10,
        returnQty: 3,
        remainQty: 7,
        note: null,
        item: { ...ITEM },
      },
    ],
    files: [],
    ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawReturn(overrides);
  return rest;
};

const grant = (id: string, actions: string[]) => ({ resource: { type: 'composite', id }, actions });
/** 采购：建、改、读、作废；没有过账。 */
const purchase: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('purchaseReturns', ['view', 'create', 'update', 'void']),
    grant('purchaseOrders', ['view']),
    grant('inventory', ['warehouseView']),
    grant('bizOptions', ['view']),
  ],
};
/** 仓管：只有两页的 postView 窄读与过账；没有建、改、作废。 */
const warehouse: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('purchaseReturns', ['postView', 'post']),
    grant('inventory', ['warehouseView']),
    grant('bizOptions', ['view']),
  ],
};
/** 财务：只有销售退货的 financeView 窄读。 */
const finance: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('salesReturns', ['financeView'])],
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
        <Route path='/purchase-returns' element={<PurchaseReturnsListPage />} />
        <Route path='/purchase-returns/new' element={<PurchaseReturnsNewPage />} />
        <Route path='/purchase-returns/:returnId' element={<PurchaseReturnsDetailPage />} />
        <Route path='/sales-returns' element={<SalesReturnsListPage />} />
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

const financeRow = {
  id: 'r2',
  docNo: 'TH-20261127-0002',
  returnDate: '2026-11-27',
  status: 'posted',
  customerId: 'c1',
  lines: [{ itemId: ITEM.id, qty: 3 }],
};

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET warehouses': () => page(WAREHOUSE),
    'GET person-options': () => page(HANDLER),
    'GET purchase-orders': () => page(ORDER),
    'GET purchase-returns': () => page(listRow()),
    'GET purchase-returns/r1': () => rawReturn(),
    'GET purchase-returns/source-options': () => page(SOURCE),
    'GET sales-returns/finance-options': () => page(financeRow),
    'GET stock-docs': () =>
      page({ id: 'd1', docNo: 'CK-20261127-0001', docType: 'out', reason: 'purchase_return', status: 'posted' }),
  };
});

describe('R-020 退货页面：列表按角色显示不同的列与按钮', () => {
  it('采购看得到备注列、新建与作废，看不到过账按钮', async () => {
    await renderAt('/purchase-returns', purchase);
    // 先等到单据落定，再断言「没有」的东西。
    expect(await screen.findByText('TH-20261127-0001', {}, WAIT)).toBeVisible();
    expect(screen.getByText('Sample return remark')).toBeVisible();
    expect(screen.getByRole('button', { name: L.actions.new })).toBeVisible();
    expect(screen.getByRole('button', { name: L.actions.void })).toBeVisible();
    expect(screen.queryByRole('button', { name: L.actions.post })).not.toBeInTheDocument();
  });

  it('仓管只看待过账列表：有过账按钮，没有新建与备注列', async () => {
    await renderAt('/purchase-returns', warehouse);
    expect(await screen.findByText('TH-20261127-0001', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('returns-pending-hint')).toBeVisible();
    expect(screen.getByRole('button', { name: L.actions.post })).toBeVisible();
    expect(screen.queryByRole('button', { name: L.actions.void })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: L.actions.new })).not.toBeInTheDocument();
    expect(screen.queryByText('Sample return remark')).not.toBeInTheDocument();
    const listCall = api.mock.calls.find((call) => call[0].path === 'purchase-returns');
    expect(listCall?.[0].query?.status).toBe('draft');
  });

  it('财务只看到销售退货的窄列：没有备注、经办人与新建', async () => {
    await renderAt('/sales-returns', finance);
    expect(await screen.findByText('TH-20261127-0002', {}, WAIT)).toBeVisible();
    expect(screen.getByText('c1')).toBeVisible();
    expect(screen.queryByText('Sample return remark')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: L.actions.new })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: L.actions.post })).not.toBeInTheDocument();
  });
});

describe('R-020 退货页面：新建提交与错误提示', () => {
  it('从出入库单选择后带出仓库与批次，提交体只含服务端接受的键', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST purchase-returns': (call) => {
        stored.created = call.json;
        return rawReturn({ id: 'r9', docNo: 'TH-20261127-0009', ...(call.json as Raw) });
      },
      'GET purchase-returns/r9': () => rawReturn({ id: 'r9', docNo: 'TH-20261127-0009' }),
    };
    await renderAt('/purchase-returns/new', purchase);
    await user.click(await screen.findByRole('button', { name: L.actions.pickSource }, WAIT));
    await user.click(await screen.findByRole('button', { name: L.source.pick.replace('{{docNo}}', SOURCE.docNo) }, WAIT));
    const qty = await screen.findByRole('textbox', { name: L.fields.returnQtyLine.replace('{{n}}', '1') }, WAIT);
    fireEvent.change(qty, { target: { value: '3' } });
    await user.click(await screen.findByRole('button', { name: L.actions.save }, WAIT));

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      sourceType: 'stock_doc',
      sourceId: SOURCE.id,
      remark: '',
      fileIds: [],
      lines: [{ sourceLineId: 'sl1', returnQty: 3, warehouseId: WAREHOUSE.id }],
    });
  });

  it('从订单发起时带出订单行的已收数量与订单头仓库', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST purchase-returns': (call) => {
        stored.created = call.json;
        return rawReturn({ id: 'r9', docNo: 'TH-20261127-0009' });
      },
      'GET purchase-returns/r9': () => rawReturn({ id: 'r9', docNo: 'TH-20261127-0009' }),
    };
    await renderAt('/purchase-returns/new', purchase);
    await user.click(await screen.findByRole('button', { name: L.actions.pickSource }, WAIT));
    await user.click(await screen.findByRole('button', { name: L.source.modeOrder }, WAIT));
    await user.click(await screen.findByRole('button', { name: L.source.pickOrder.replace('{{orderNo}}', ORDER.orderNo) }, WAIT));
    const qty = await screen.findByRole('textbox', { name: L.fields.returnQtyLine.replace('{{n}}', '1') }, WAIT);
    fireEvent.change(qty, { target: { value: '2' } });
    await user.click(await screen.findByRole('button', { name: L.actions.save }, WAIT));

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      sourceType: 'order',
      sourceId: ORDER.id,
      remark: '',
      fileIds: [],
      lines: [{ sourceLineId: 'ol1', returnQty: 2, warehouseId: WAREHOUSE.id }],
    });
  });

  it('退货数量超上限时把规则码翻成页面提示', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'POST purchase-returns': () => rejected('RETURN_QTY_EXCEED'),
    };
    await renderAt('/purchase-returns/new', purchase);
    await user.click(await screen.findByRole('button', { name: L.actions.pickSource }, WAIT));
    await user.click(await screen.findByRole('button', { name: L.source.pick.replace('{{docNo}}', SOURCE.docNo) }, WAIT));
    const qty = await screen.findByRole('textbox', { name: L.fields.returnQtyLine.replace('{{n}}', '1') }, WAIT);
    fireEvent.change(qty, { target: { value: '99' } });
    await user.click(await screen.findByRole('button', { name: L.actions.save }, WAIT));

    expect(await screen.findByText(L.errors.qtyExceed, {}, WAIT)).toBeVisible();
  });
});

describe('R-020 退货页面：过账、作废与生成单据', () => {
  it('详情的过账按钮按角色与状态显隐', async () => {
    await renderAt('/purchase-returns/r1', warehouse);
    expect(await screen.findByText('TH-20261127-0001', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('returns-detail-post')).toBeVisible();
    expect(screen.queryByTestId('returns-detail-void')).not.toBeInTheDocument();
  });

  it('采购在草稿详情里能作废、不能过账', async () => {
    await renderAt('/purchase-returns/r1', purchase);
    expect(await screen.findByText('TH-20261127-0001', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('returns-detail-void')).toBeVisible();
    expect(screen.queryByTestId('returns-detail-post')).not.toBeInTheDocument();
  });

  it('已过账的详情没有过账与作废按钮', async () => {
    handlers = { ...handlers, 'GET purchase-returns/r1': () => rawReturn({ status: 'posted' }) };
    await renderAt('/purchase-returns/r1', warehouse);
    expect(await screen.findByText('TH-20261127-0001', {}, WAIT)).toBeVisible();
    expect(screen.queryByTestId('returns-detail-post')).not.toBeInTheDocument();
    expect(screen.queryByTestId('returns-detail-void')).not.toBeInTheDocument();
  });

  it('作废必须填原因：确认按钮在填之前禁用，提交体带上原因', async () => {
    const user = userEvent.setup();
    let voidBody: unknown;
    handlers = {
      ...handlers,
      'POST purchase-returns/r1/void': (call) => {
        voidBody = call.json;
        return rawReturn({ status: 'void' });
      },
    };
    await renderAt('/purchase-returns/r1', purchase);
    await user.click(await screen.findByTestId('returns-detail-void', {}, WAIT));
    const confirm = await screen.findByTestId('returns-confirm-void', {}, WAIT);
    expect(confirm).toBeDisabled();
    const reason = await screen.findByRole('textbox', { name: L.fields.voidReason }, WAIT);
    fireEvent.change(reason, { target: { value: 'Damaged on receipt' } });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(voidBody).toBeDefined(), WAIT);
    expect(voidBody).toEqual({ reason: 'Damaged on receipt' });
  });

  it('已过账详情按 returnDocId 反查并链接到生成的出库单', async () => {
    handlers = {
      ...handlers,
      'GET purchase-returns/r1': () => rawReturn({ status: 'posted' }),
    };
    await renderAt('/purchase-returns/r1', warehouse);
    const link = await screen.findByTestId('returns-generated-doc', {}, WAIT);
    expect(link).toHaveTextContent('CK-20261127-0001');
    expect(link).toHaveAttribute('href', '/outbound-orders/d1');
  });
});


/** 前端自适应：退货列表的空态、窄屏卡片与新建页取数次序。 */
describe('return list adaptation', () => {
  const phone = () => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 767px)',
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));

  it('offers a next step in the empty state only with create permission', async () => {
    handlers = { ...handlers, 'GET purchase-returns': () => page() };
    const first = await renderAt('/purchase-returns', purchase);
    await waitFor(() => expect(document.body.textContent).toContain(enUS.returns.emptyHint), WAIT);
    const enabled = screen.getAllByRole('button', { name: L.actions.new });
    expect(enabled).toHaveLength(2);
    expect(enabled[1]?.querySelector('svg')).not.toBeNull();
    first.unmount();

    await renderAt('/purchase-returns', warehouse);
    await waitFor(() => expect(document.body.textContent).toContain(enUS.returns.emptyHint), WAIT);
    expect(screen.queryAllByRole('button', { name: L.actions.new })).toHaveLength(0);
  });

  it('renders phone cards instead of a table below md', async () => {
    phone();
    await renderAt('/purchase-returns', purchase);
    const list = await screen.findByRole('list', {}, WAIT);
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('TH-20261127-0001');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('defers warehouse options until the source picker is opened', async () => {
    const user = userEvent.setup();
    await renderAt('/purchase-returns/new', purchase);
    await screen.findByRole('button', { name: L.actions.pickSource }, WAIT);
    expect(api.mock.calls.some((call) => call[0].path === 'warehouses')).toBe(false);
    await user.click(screen.getByRole('button', { name: L.actions.pickSource }));
    await waitFor(() => expect(api.mock.calls.some((call) => call[0].path === 'warehouses')).toBe(true), WAIT);
  });
});
