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
import PurchaseOrderDetailPage from '../../client/pages/purchase-orders/detail/index.js';
import PurchaseOrderEditPage from '../../client/pages/purchase-orders/edit.js';
import PurchaseOrdersPage from '../../client/pages/purchase-orders/index.js';
import PurchaseOrderNewPage from '../../client/pages/purchase-orders/new.js';
import PurchaseOrderReceiptPage from '../../client/pages/purchase-orders/receipt.js';
import SalesOrderDetailPage from '../../client/pages/sales-orders/detail/index.js';
import SalesOrderEditPage from '../../client/pages/sales-orders/edit.js';
import SalesOrdersPage from '../../client/pages/sales-orders/index.js';
import SalesOrderNewPage from '../../client/pages/sales-orders/new.js';
import SalesOrderReceiptPage from '../../client/pages/sales-orders/receipt.js';
import { today } from '../../client/pages/orders/model.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-021 采购订单、R-022 销售订单的页面。真实的应用 hook 与路由容器，只把 HTTP 换成夹具；
 * 两类订单同形，同一组用例各跑一遍。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-27T08:00:00.000Z';
const DENIED = 'You do not have permission for this action.';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});
const rejected = (reason: string, message: string): Response =>
  Response.json(
    {
      error: {
        message: 'raw',
        reason,
        localizedMessage: { locale: 'en-US', message },
      },
    },
    { status: 422 },
  );

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
const PARTNER = {
  id: 'p1',
  code: 'SU202611080002',
  name: 'Sample Vendor Co.',
  status: 'active',
};
const WAREHOUSE = {
  id: 'w1',
  code: 'WH01',
  name: 'Sample Warehouse',
  status: 'active',
};

interface Kind {
  readonly kind: 'purchase' | 'sales';
  readonly path: string;
  readonly api: string;
  readonly l: 'purchaseOrders' | 'salesOrders';
  readonly partner: string;
  readonly partnerKey: 'supplierId' | 'customerId';
  readonly doneKey: 'receivedQty' | 'shippedQty';
  readonly makeAction: 'createReceipt' | 'createIssue';
  readonly makeSegment: 'create-receipt' | 'create-issue';
  readonly no: {
    first: string;
    created: string;
    doc: string;
  };
}

const KINDS: readonly Kind[] = [
  {
    kind: 'purchase',
    path: '/purchase-orders',
    api: 'purchase-orders',
    l: 'purchaseOrders',
    partner: 'suppliers',
    partnerKey: 'supplierId',
    doneKey: 'receivedQty',
    makeAction: 'createReceipt',
    makeSegment: 'create-receipt',
    no: {
      first: 'CG-20261127-0001',
      created: 'CG-20261127-0002',
      doc: 'RK-20261127-0001',
    },
  },
  {
    kind: 'sales',
    path: '/sales-orders',
    api: 'sales-orders',
    l: 'salesOrders',
    partner: 'customers',
    partnerKey: 'customerId',
    doneKey: 'shippedQty',
    makeAction: 'createIssue',
    makeSegment: 'create-issue',
    no: {
      first: 'XS-20261127-0001',
      created: 'XS-20261127-0002',
      doc: 'CK-20261127-0001',
    },
  },
];

type Raw = Record<string, unknown>;
/** 端点的原始形状（采购、销售字段名不同），页面负责换成共用的形状。 */
function rawOrder(kind: Kind, overrides: Raw = {}): Raw {
  const lines = [
    {
      id: 'l1',
      itemId: 'i1',
      qty: 10,
      price: 2.5,
      receivedQty: 0,
      shippedQty: 0,
      remainingQty: 10,
    },
    {
      id: 'l2',
      itemId: 'i2',
      qty: 4,
      price: null,
      receivedQty: 0,
      shippedQty: 0,
      remainingQty: 4,
    },
  ];
  return {
    id: 'o1',
    orderNo: kind.no.first,
    status: 'draft',
    orderDate: '2026-11-27',
    remark: 'Sample remark',
    submittedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    [kind.partnerKey]: PARTNER.id,
    [kind.kind === 'purchase' ? 'supplier' : 'customer']: PARTNER,
    lines,
    ...overrides,
  };
}

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const writer = (kind: Kind): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [
    grant(kind.l, [
      'view',
      'create',
      'update',
      'submit',
      'cancel',
      kind.makeAction,
    ]),
    grant('items', ['view']),
    grant('inventory', ['warehouseView']),
    grant(kind.partner, ['view']),
  ],
});
const viewer = (kind: Kind): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: [grant(kind.l, ['view']), grant('items', ['view'])],
});

const say = (kind: Kind) => {
  const group = enUS[kind.l];
  const fill = (text: string, name: string): string =>
    text.replace('{{name}}', name);
  return {
    newLabel: group.newTitle,
    submit: group.actions.submit,
    make: group.actions.make,
    ordered: group.status.ordered,
    cancelled: group.status.cancelled,
    partnerLabel: group.partnerLabel,
    receiptLineTitle: group.receiptLineTitle,
    createdToast: fill(group.createdToast, kind.no.created),
    submittedToast: fill(group.submittedToast, kind.no.created),
    madeToast: fill(group.madeToast, kind.no.doc),
    savedToast: fill(group.savedToast, kind.no.first),
    cancelledToast: fill(group.cancelledToast, kind.no.first),
    cancelTitle: fill(group.cancelTitle, kind.no.first),
    exceeds: enUS.orderDocs.errors.receiptExceeds.replace(
      '{{done}}',
      group.actions.doneWord,
    ),
    notDraft: enUS.orderDocs.form.notDraft,
  };
};

let permissions: AuthorizationSnapshot;
/** 「方法 路径」→ 应答；没登记的一律 404。 */
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
        <Route path='/purchase-orders' element={<PurchaseOrdersPage />}>
          <Route path='new' element={<PurchaseOrderNewPage />} />
          <Route path=':purchaseOrderId' element={<PurchaseOrderDetailPage />}>
            <Route path='edit' element={<PurchaseOrderEditPage />} />
            <Route
              path='create-receipt'
              element={<PurchaseOrderReceiptPage />}
            />
          </Route>
        </Route>
        <Route path='/sales-orders' element={<SalesOrdersPage />}>
          <Route path='new' element={<SalesOrderNewPage />} />
          <Route path=':salesOrderId' element={<SalesOrderDetailPage />}>
            <Route path='edit' element={<SalesOrderEditPage />} />
            <Route path='create-issue' element={<SalesOrderReceiptPage />} />
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

/** 在一个下拉里选一项。默认整个页面里找；对话框里的控件传对话框的节点。 */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
  scope: HTMLElement = document.body,
): Promise<void> {
  await user.click(await within(scope).findByRole('combobox', { name }, WAIT));
  await user.click(await screen.findByRole('option', { name: option }, WAIT));
}

/**
 * 等对话框里的某个控件出现（权限落定、读到这一张单之前对话框里是一句「加载中」），
 * 返回它此刻所在的对话框。
 */
async function liveDialog(
  name: string,
  role: 'textbox' | 'combobox',
): Promise<HTMLElement> {
  const field = await screen.findByRole(role, { name }, WAIT);
  return field.closest<HTMLElement>('[role="dialog"]')!;
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET items': () => page(ITEM_A, ITEM_B),
    'GET partners': () => page(PARTNER),
    'GET warehouses': () => page(WAREHOUSE),
    'GET purchase-orders': () => page(rawOrder(KINDS[0]!)),
    'GET sales-orders': () => page(rawOrder(KINDS[1]!)),
    'GET purchase-orders/o1': () => rawOrder(KINDS[0]!),
    'GET sales-orders/o1': () => rawOrder(KINDS[1]!),
  };
});

describe.each(KINDS)('$kind order pages', (kind: Kind) => {
  const text = say(kind);
  const makePath = `${kind.api}/o1/${kind.makeSegment}`;

  it('lists orders with a link to each one and sends only the list parameters of the contract', async () => {
    const user = userEvent.setup();
    await renderAt(kind.path, writer(kind));

    expect(await screen.findByText(kind.no.first, {}, WAIT)).toBeVisible();
    // 首列点开这一张单；「新建」带着列表的查询串。
    expect(screen.getByRole('link', { name: kind.no.first })).toHaveAttribute(
      'href',
      `${kind.path}/o1`,
    );
    expect(
      await screen.findByRole('button', { name: text.newLabel }, WAIT),
    ).toHaveAttribute('href', `${kind.path}/new`);
    expect(calls('GET', kind.api).map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);
    // 默认只有搜索框；点「筛选」才展开第二行（状态、往来单位、创建时间）。
    expect(
      screen.queryByRole('combobox', { name: 'Status' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    const status = await screen.findByRole(
      'combobox',
      { name: 'Status' },
      WAIT,
    );
    expect(
      await screen.findByRole('combobox', { name: text.partnerLabel }, WAIT),
    ).toBeInTheDocument();
    // 选一个状态就带着它重新取数。
    await user.click(status);
    await user.click(
      await screen.findByRole('option', { name: text.ordered }, WAIT),
    );
    await waitFor(
      () =>
        expect(calls('GET', kind.api).at(-1)?.query).toEqual({
          status: 'ordered',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
  });

  it('shows the arrived / shipped status on the list row, the same as on the detail', async () => {
    const done = kind.kind === 'purchase' ? 'received' : 'shipped';
    const label = enUS[kind.l].status.done;
    handlers = {
      ...handlers,
      [`GET ${kind.api}`]: () => page(rawOrder(kind, { status: done })),
    };
    await renderAt(kind.path, writer(kind));

    // 先等到列表真的渲染出来，再断言状态列里的那枚徽标。
    const row = await screen.findByRole('link', { name: kind.no.first }, WAIT);
    expect(row.closest('tr')).not.toBeNull();
    expect(
      within(row.closest('tr')!).getByText(label),
    ).toBeInTheDocument();
  });

  it('shows an inactive partner by code and name in the edit form, with a hint', async () => {
    handlers = {
      ...handlers,
      [`GET ${kind.api}/o1`]: () =>
        rawOrder(kind, {
          [kind.kind === 'purchase' ? 'supplier' : 'customer']: {
            ...PARTNER,
            status: 'inactive',
          },
        }),
    };
    await renderAt(`${kind.path}/o1/edit`, writer(kind));

    const trigger = await screen.findByRole(
      'combobox',
      { name: text.partnerLabel },
      WAIT,
    );
    await waitFor(
      () =>
        expect(trigger).toHaveTextContent(
          `${PARTNER.code} ${PARTNER.name}（Deactivated）`,
        ),
      WAIT,
    );
    expect(
      screen.getByText('That partner is inactive; reactivate it first.'),
    ).toBeInTheDocument();
  });

  it('shows a read-only viewer no create button and no row menu', async () => {
    await renderAt(kind.path, viewer(kind));

    expect(await screen.findByText(kind.no.first, {}, WAIT)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), WAIT);

    expect(
      screen.queryByRole('button', { name: text.newLabel }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Actions for ${kind.no.first}` }),
    ).not.toBeInTheDocument();
  });

  it('creates a draft on the new page, lands on it and submits it', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      [`POST ${kind.api}`]: (call) => {
        const body = call.json as {
          lines: { itemId: string; qty: number; price?: number }[];
          remark?: string;
        };
        stored.created = body;
        stored.order = rawOrder(kind, {
          id: 'o9',
          orderNo: kind.no.created,
          remark: body.remark ?? '',
          lines: body.lines.map((line, index) => ({
            id: `n${index + 1}`,
            itemId: line.itemId,
            qty: line.qty,
            price: line.price ?? null,
            receivedQty: 0,
            shippedQty: 0,
            remainingQty: line.qty,
          })),
        });
        return stored.order;
      },
      [`GET ${kind.api}/o9`]: () => stored.order,
      [`POST ${kind.api}/o9/submit`]: () => {
        stored.order = {
          ...(stored.order as object),
          status: 'ordered',
          submittedAt: NOW,
        };
        return stored.order;
      },
    };
    const view = await renderAt(`${kind.path}/new`, writer(kind));

    await choose(user, text.partnerLabel, `${PARTNER.code} ${PARTNER.name}`);
    await user.click(
      await screen.findByRole('button', { name: 'Add line' }, WAIT),
    );
    await choose(user, 'Item, line 1', `${ITEM_A.code} ${ITEM_A.name}`);
    await user.type(
      await screen.findByRole('textbox', { name: 'Quantity, line 1' }, WAIT),
      '10',
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Unit price, line 1' }, WAIT),
      '2.5',
    );
    await user.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    await waitFor(
      () =>
        expect(stored.created).toEqual({
          [kind.partnerKey]: PARTNER.id,
          orderDate: today(),
          remark: '',
          lines: [{ itemId: ITEM_A.id, qty: 10, price: 2.5 }],
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: text.createdToast }),
    ]);
    // 新建的到了这张单的页面：单号、状态、明细里的物料。
    expect(await screen.findByText(kind.no.created, {}, WAIT)).toBeVisible();
    expect(await screen.findByText(ITEM_A.name, {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(`${kind.path}/o9`);

    // 下单（确认）之后：明细锁定，没有「编辑」，主按钮变成生成入库单（出库单）。
    await user.click(
      await screen.findByRole('button', { name: text.submit }, WAIT),
    );
    await waitFor(
      () => expect(calls('POST', `${kind.api}/o9/submit`)).toHaveLength(1),
      WAIT,
    );
    expect(await screen.findByText(text.ordered, {}, WAIT)).toBeVisible();
    expect(view.toasts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'success',
          title: text.submittedToast,
        }),
      ]),
    );
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: text.make })).toHaveAttribute(
      'href',
      `${kind.path}/o9/${kind.makeSegment}`,
    );
  });

  it('generates a draft stock document from the order and returns to the order', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      [`POST ${makePath}`]: () => ({
        id: 'd1',
        docNo: kind.no.doc,
        status: 'draft',
      }),
    };
    const view = await renderAt(
      `${kind.path}/o1/${kind.makeSegment}`,
      writer(kind),
    );

    const firstName = `${text.receiptLineTitle} 1`;
    const dialog = await liveDialog(firstName, 'textbox');
    const first = () =>
      within(dialog).findByRole('textbox', { name: firstName }, WAIT);
    // 每一行的本次数量默认就是未到货（未发货）数量。
    expect(await first()).toHaveValue('10');
    await choose(
      user,
      'Warehouse',
      `${WAREHOUSE.code} ${WAREHOUSE.name}`,
      dialog,
    );
    // 改小可以：第一行只生成 4。
    await user.clear(await first());
    await user.type(await first(), '4');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Generate' }, WAIT),
    );

    await waitFor(
      () =>
        expect(calls('POST', makePath)[0]?.json).toEqual({
          warehouseId: WAREHOUSE.id,
          lines: [
            { lineId: 'l1', qty: 4 },
            { lineId: 'l2', qty: 4 },
          ],
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: text.madeToast }),
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WAIT);
    expect(screen.getByTestId('location')).toHaveTextContent(`${kind.path}/o1`);
  });

  it('keeps the dialog open with the server sentence when the endpoint answers 422', async () => {
    const user = userEvent.setup();
    const sentence = 'The quantity exceeds what remains on that line.';
    handlers = {
      ...handlers,
      [`POST ${makePath}`]: () =>
        rejected('ORDER_QTY_EXCEEDS_REMAINING', sentence),
    };
    const view = await renderAt(
      `${kind.path}/o1/${kind.makeSegment}`,
      writer(kind),
    );

    const firstName = `${text.receiptLineTitle} 1`;
    const dialog = await liveDialog(firstName, 'textbox');
    const first = () =>
      within(dialog).findByRole('textbox', { name: firstName }, WAIT);
    await choose(
      user,
      'Warehouse',
      `${WAREHOUSE.code} ${WAREHOUSE.name}`,
      dialog,
    );

    // 页面自己先拦：超过未到货数量不发请求，话标在这一行下面。
    await user.clear(await first());
    await user.type(await first(), '11');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Generate' }, WAIT),
    );
    expect(
      await within(dialog).findByText(text.exceeds, {}, WAIT),
    ).toBeVisible();
    expect(calls('POST', makePath)).toEqual([]);

    // 改回未到货数量再提交，服务端仍拒绝（别人刚生成过）：显示服务端那句话，
    // 对话框不关、填的值还在、不发提示。
    await user.clear(await first());
    await user.type(await first(), '10');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Generate' }, WAIT),
    );
    // 一句在上面的提示条里，一句标在这一行的数量下面，光标落到那一行。
    expect(await screen.findAllByText(sentence, {}, WAIT)).toHaveLength(2);
    expect(await first()).toHaveValue('10');
    expect(await first()).toHaveFocus();
    expect(
      await screen.findByRole('dialog', { name: text.make }, WAIT),
    ).toBeInTheDocument();
    expect(view.toasts()).toEqual([]);
    expect(calls('POST', makePath)).toHaveLength(1);
  });

  it('cancels an order only after the confirmation', async () => {
    const user = userEvent.setup();
    let current: Raw = rawOrder(kind);
    handlers = {
      ...handlers,
      [`GET ${kind.api}/o1`]: () => current,
      [`POST ${kind.api}/o1/cancel`]: () => {
        current = rawOrder(kind, { status: 'cancelled' });
        return current;
      },
    };
    const view = await renderAt(`${kind.path}/o1`, writer(kind));
    expect(
      await screen.findByRole('button', { name: 'Cancel order' }, WAIT),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    const confirm = await screen.findByRole('alertdialog', {}, WAIT);
    expect(
      await within(confirm).findByText(text.cancelTitle, {}, WAIT),
    ).toBeVisible();
    expect(
      within(confirm).getByRole('button', { name: 'Cancel order' }),
    ).toBeInTheDocument();
    // 没确认之前不发请求。
    expect(calls('POST', `${kind.api}/o1/cancel`)).toEqual([]);
    await user.click(
      within(confirm).getByRole('button', { name: 'Cancel order' }),
    );

    await waitFor(
      () => expect(calls('POST', `${kind.api}/o1/cancel`)).toHaveLength(1),
      WAIT,
    );
    expect(await screen.findByText(text.cancelled, {}, WAIT)).toBeVisible();
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: text.cancelledToast }),
    ]);
    // 已取消的单没有任何操作。
    await waitFor(
      () =>
        expect(
          screen.queryByRole('button', { name: 'Cancel order' }),
        ).toBeNull(),
      WAIT,
    );
    expect(
      screen.queryByRole('button', { name: text.submit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: text.make }),
    ).not.toBeInTheDocument();
  });

  it('saves a draft with its whole document and returns to the order', async () => {
    const user = userEvent.setup();
    let patched: unknown;
    let saved: Raw = rawOrder(kind);
    handlers = {
      ...handlers,
      [`GET ${kind.api}/o1`]: () => saved,
      [`PATCH ${kind.api}/o1`]: (call) => {
        patched = call.json;
        // 保存之后回到这一张单，页面重新读一次：读到的就是刚存的那一份备注。
        const body = call.json as { remark?: string };
        saved = rawOrder(kind, { remark: body.remark ?? '' });
        return saved;
      },
    };
    const view = await renderAt(`${kind.path}/o1/edit`, writer(kind));

    await user.type(
      await screen.findByRole('textbox', { name: 'Note' }, WAIT),
      ' changed',
    );
    await user.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    // 可改的字段全带上；单价没填的第二行不带 price 这个键。
    await waitFor(
      () =>
        expect(patched).toEqual({
          [kind.partnerKey]: PARTNER.id,
          orderDate: '2026-11-27',
          remark: 'Sample remark changed',
          lines: [
            { itemId: ITEM_A.id, qty: 10, price: 2.5 },
            { itemId: ITEM_B.id, qty: 4 },
          ],
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: text.savedToast }),
    ]);
    // 保存之后回到这一张单（不是列表），页面重新读一次：读到的就是刚存的那一份备注。
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          `${kind.path}/o1`,
        ),
      WAIT,
    );
    // 等编辑的子页真的卸掉，再对这一张单上的备注（表单还在的那一瞬，备注框里也是这句）。
    await waitFor(
      () =>
        expect(
          screen.queryByRole('textbox', { name: 'Note' }),
        ).not.toBeInTheDocument(),
      WAIT,
    );
    expect(
      await screen.findByText('Sample remark changed', {}, WAIT),
    ).toBeVisible();
  });

  it('refuses to edit an order that is no longer a draft', async () => {
    handlers = {
      ...handlers,
      [`GET ${kind.api}/o1`]: () =>
        rawOrder(kind, { status: 'ordered', submittedAt: NOW }),
    };
    await renderAt(`${kind.path}/o1/edit`, writer(kind));

    expect(await screen.findByText(text.notDraft, {}, WAIT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Save draft' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: text.partnerLabel }),
    ).not.toBeInTheDocument();
    expect(calls('PATCH', `${kind.api}/o1`)).toEqual([]);
  });

  it('turns the edit page into the explanation when the server says the order was submitted meanwhile', async () => {
    const user = userEvent.setup();
    let reads = 0;
    handlers = {
      ...handlers,
      [`GET ${kind.api}/o1`]: () => {
        reads += 1;
        // 保存被拒之后页面重新读一次：这时它已经是已下单（已确认）。
        return reads > 1
          ? rawOrder(kind, { status: 'ordered', submittedAt: NOW })
          : rawOrder(kind);
      },
      [`PATCH ${kind.api}/o1`]: () =>
        rejected(
          'ORDER_NOT_DRAFT',
          'Only a draft order can be changed or submitted.',
        ),
    };
    await renderAt(`${kind.path}/o1/edit`, writer(kind));

    await user.type(
      await screen.findByRole('textbox', { name: 'Note' }, WAIT),
      ' changed',
    );
    await user.click(
      await screen.findByRole('button', { name: 'Save draft' }, WAIT),
    );

    expect(await screen.findByText(text.notDraft, {}, WAIT)).toBeVisible();
    expect(
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: 'Save draft' }),
        ).not.toBeInTheDocument();
      }),
    ).toBeUndefined();
    expect(calls('PATCH', `${kind.api}/o1`)).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it('sends the wave-0 fields in the create body and leaves server amounts alone', async () => {
    const user = userEvent.setup();
    let created: unknown;
    const waveWriter = (): AuthorizationSnapshot => ({
      unrestricted: false,
      permissions: [
        ...writer(kind).permissions,
        grant('bizDict', ['view']),
        grant('bizOptions', ['view']),
      ],
    });
    handlers = {
      ...handlers,
      'GET biz-dict/entries': (call) => {
        const type = call.query?.dictType;
        if (type === 'tax_rate')
          return page({
            id: 't1', dictType: type, code: '13', name: '13%', rate: 13,
            isDefault: true, sort: 0,
          });
        if (type === 'project')
          return page({
            id: 'pr1', dictType: type, code: 'PRJ-1', name: 'Sample Project',
            isDefault: false, sort: 0,
          });
        return page({
          id: 'st1', dictType: 'settlement', code: 'CASH', name: 'Cash',
          isDefault: false, sort: 0,
        });
      },
      'GET person-options': () =>
        page({ userId: 'u1', name: 'Sam Buyer', departmentId: null, departmentName: null }),
      [`POST ${kind.api}`]: (call) => {
        created = call.json;
        return rawOrder(kind, { id: 'o9', orderNo: kind.no.created });
      },
      [`GET ${kind.api}/o9`]: () => rawOrder(kind, { id: 'o9', orderNo: kind.no.created }),
    };
    await renderAt(`${kind.path}/new`, waveWriter());

    await choose(user, text.partnerLabel, `${PARTNER.code} ${PARTNER.name}`);
    await choose(user, 'Warehouse', `${WAREHOUSE.code} ${WAREHOUSE.name}`);
    await choose(user, 'Settlement method', 'Cash');
    await choose(user, 'Project', 'Sample Project');
    await choose(user, kind.kind === 'purchase' ? 'Buyer' : 'Salesperson', 'Sam Buyer');
    await user.type(await screen.findByRole('textbox', { name: 'Contact' }, WAIT), 'Sam');
    await user.type(await screen.findByRole('textbox', { name: 'Phone' }, WAIT), '000-1234');
    await user.type(await screen.findByRole('textbox', { name: kind.kind === 'purchase' ? 'Delivery address' : 'Delivery address' }, WAIT), 'Sample Street 1');
    await user.type(await screen.findByRole('textbox', { name: 'Discount amount' }, WAIT), '5');
    await user.click(await screen.findByRole('button', { name: 'Add line' }, WAIT));
    await choose(user, 'Item, line 1', `${ITEM_A.code} ${ITEM_A.name}`);
    await user.type(await screen.findByRole('textbox', { name: 'Quantity, line 1' }, WAIT), '10');
    await user.type(await screen.findByRole('textbox', { name: 'Tax-excluded price, line 1' }, WAIT), '100');
    await user.type(await screen.findByRole('textbox', { name: 'Delivery date, line 1' }, WAIT), '2026-12-01');
    await user.click(await screen.findByRole('button', { name: 'Save draft' }, WAIT));

    await waitFor(() => expect(created).toBeDefined(), WAIT);
    expect(created).toMatchObject({
      [kind.partnerKey]: PARTNER.id,
      warehouseId: WAREHOUSE.id,
      contactName: 'Sam',
      contactPhone: '000-1234',
      settlementCode: 'CASH',
      projectCode: 'PRJ-1',
      handlerUserId: 'u1',
      discountAmount: 5,
      lines: [{
        itemId: ITEM_A.id,
        qty: 10,
        taxRate: 13,
        taxExcludedPrice: 100,
        deliveryDate: '2026-12-01',
      }],
    });
    // 前端不算金额：请求体里没有服务端算的列。
    const lines = (created as { lines: Record<string, unknown>[] }).lines;
    for (const key of ['taxExcludedAmount', 'taxAmount', 'taxIncludedAmount']) {
      expect(lines[0]).not.toHaveProperty(key);
    }
    expect(created).not.toHaveProperty('taxIncludedTotal');
  });

  it('draws price and amount columns only with viewPrice', async () => {
    const priced = rawOrder(kind, {
      taxIncludedTotal: 113,
      taxExcludedTotal: 100,
      taxTotal: 13,
      discountAmount: 0,
      payableTotal: 113,
      lines: [
        {
          id: 'l1', itemId: 'i1', qty: 10, price: 11.3,
          receivedQty: 0, shippedQty: 0, remainingQty: 10,
          taxRate: 13, taxExcludedPrice: 10,
          taxExcludedAmount: 100, taxAmount: 13, taxIncludedAmount: 113,
          deliveryDate: '2026-12-01',
        },
      ],
    });
    handlers = { ...handlers, [`GET ${kind.api}/o1`]: () => priced };

    await renderAt(`${kind.path}/o1`, viewer(kind));
    expect(await screen.findByText(kind.no.first, {}, WAIT)).toBeVisible();
    expect(screen.queryByRole('columnheader', { name: 'Unit price' })).toBeNull();
    expect(screen.queryByText('¥113.00')).toBeNull();

    // 同一个会话加上 viewPrice：列与服务端合计都出现。
    const pricedGrant = viewer(kind);
    pricedGrant.permissions[0]!.actions.push('viewPrice');
    await renderAt(`${kind.path}/o1`, pricedGrant);
    expect(await screen.findByRole('columnheader', { name: 'Unit price' }, WAIT)).toBeVisible();
    expect((await screen.findAllByText('¥113.00', {}, WAIT)).length).toBeGreaterThan(0);
  });

  it('shows the other role nothing and sends no request for the order', async () => {
    const other = KINDS.find((entry) => entry.kind !== kind.kind)!;
    await renderAt(`${kind.path}/o1`, writer(other));

    expect(await screen.findByText(DENIED, {}, WAIT)).toBeVisible();
    expect(screen.queryByText(kind.no.first)).not.toBeInTheDocument();
    expect(screen.queryByText(ITEM_A.name)).not.toBeInTheDocument();
    expect(calls('GET', `${kind.api}/o1`)).toEqual([]);
    expect(calls('GET', kind.api)).toEqual([]);
  });
});

// 缺陷 5：请购单转出的采购订单详情里，purchaseRequestId 要回链到请购单。
describe('purchase order backlink to its purchase request', () => {
  it('renders a labelled link back to the source purchase request', async () => {
    handlers = {
      ...handlers,
      'GET purchase-orders/o1': () =>
        rawOrder(KINDS[0]!, { purchaseRequestId: 'pr-20261128-0001' }),
    };
    await renderAt('/purchase-orders/o1', writer(KINDS[0]!));
    expect(await screen.findByText(enUS.orderDocs.fields.sourcePurchaseRequest, {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('link', { name: enUS.orderDocs.fields.sourcePurchaseRequest }, WAIT),
    ).toHaveAttribute('href', '/purchase-requests/pr-20261128-0001');
  });

  it('shows no backlink on an order that did not come from a purchase request', async () => {
    await renderAt('/purchase-orders/o1', writer(KINDS[0]!));
    await expect(
      screen.findByText(KINDS[0]!.no.first, {}, WAIT),
    ).resolves.toBeVisible();
    await waitFor(
      () =>
        expect(
          screen.queryByText(enUS.orderDocs.fields.sourcePurchaseRequest),
        ).not.toBeInTheDocument(),
      WAIT,
    );
  });
});
