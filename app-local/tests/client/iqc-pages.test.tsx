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
import InspectionDetailPage from '../../client/pages/inspections/detail.js';
import InspectionEditPage from '../../client/pages/inspections/edit.js';
import InspectionsPage from '../../client/pages/inspections/index.js';
import InspectionNewPage from '../../client/pages/inspections/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-070 页面片：真实 hook 与路由容器，只把 HTTP 换成夹具；数据一律编造。
 * 算列由服务端给出，页面只回显；新建请求体不带算列与采购数量。
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

const ITEM = {
  id: 'i1', code: 'M2611280001', name: 'Sample Steel Sheet',
  spec: null, unitCode: 'KG',
};
const SUPPLIER = { id: 's1', code: 'SU1', name: 'Sample Vendor' };
const ORDER = { id: 'po1', orderNo: 'CG-20261128-0001', orderDate: '2026-11-28' };
const INSPECTOR = { userId: 'u1', name: 'Sample Inspector' };

const LINE = {
  id: 'l1', itemId: ITEM.id, item: ITEM, purchaseQty: 10,
  inspectionTypeCode: 'full', receivedQty: 10, inspectionQty: 8,
  qualifiedQty: 7, unqualifiedQty: 1, releasableQty: 7, returnQty: 3,
  samplingQty: 2, samplingQualifiedQty: 2, lossQty: 0, retainedQty: 0,
  note: null,
};

type Raw = Record<string, unknown>;
function rawInspection(overrides: Raw = {}): Raw {
  return {
    id: 'ins1', docNo: 'JY-20261128-0001', inspectionDate: '2026-11-28',
    status: 'pending', purchaseOrder: ORDER, supplier: SUPPLIER,
    inspector: INSPECTOR, remark: 'Sample remark', createdAt: NOW, updatedAt: NOW,
    lines: [LINE], files: [],
    ...overrides,
  };
}
const summary = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawInspection();
  return { ...rest, ...overrides };
};
const orderOption = {
  id: 'po1', orderNo: ORDER.orderNo, orderDate: ORDER.orderDate,
  supplier: { id: SUPPLIER.id, code: SUPPLIER.code, name: SUPPLIER.name },
  lines: [{
    itemId: ITEM.id, item: ITEM, purchaseQty: 10, receivedRemainQty: 8,
  }],
};

const L = enUS.inspections;
const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
/** 质量员：建、改、完成、读。 */
const inspector: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('inspectionOrders', ['view', 'create', 'update', 'complete'])],
};
/** 质量主管：读与作废。 */
const manager: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('inspectionOrders', ['view', 'void'])],
};
/** 采购：只读。 */
const buyer: AuthorizationSnapshot = {
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
        <Route path='/inspections' element={<InspectionsPage />}>
          <Route path='new' element={<InspectionNewPage />} />
          <Route path=':inspectionId' element={<InspectionDetailPage />}>
            <Route path='edit' element={<InspectionEditPage />} />
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
    'GET inspections': () => page(summary()),
    'GET inspections/order-options': () => page(orderOption),
    'GET inspections/ins1': () => rawInspection(),
  };
});

describe('R-070 来料检验页面', () => {
  it('列表按端点支持的筛选项取数，不发明参数', async () => {
    const user = userEvent.setup();
    await renderAt('/inspections', inspector);

    expect(await screen.findByText('JY-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: L.actions.new }, WAIT),
    ).toHaveAttribute('href', '/inspections/new');
    expect(calls('GET', 'inspections').map((call) => call.query)).toEqual([
      { page: '1', pageSize: '20' },
    ]);

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await choose(user, L.filters.status, L.status.partial);
    await waitFor(
      () =>
        expect(calls('GET', 'inspections').at(-1)?.query).toEqual({
          status: 'partial',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
    await choose(user, L.filters.purchaseOrder, ORDER.orderNo);
    await waitFor(
      () =>
        expect(calls('GET', 'inspections').at(-1)?.query?.purchaseOrderId).toBe(
          'po1',
        ),
      WAIT,
    );
    await choose(user, L.filters.supplier, SUPPLIER.name);
    await waitFor(
      () =>
        expect(calls('GET', 'inspections').at(-1)?.query?.supplierId).toBe('s1'),
      WAIT,
    );
    const from = await screen.findByRole(
      'textbox',
      { name: L.filters.from },
      WAIT,
    );
    await user.type(from, '2026-11-01');
    await user.tab();
    await waitFor(
      () =>
        expect(
          calls('GET', 'inspections').at(-1)?.query?.from,
        ).toEqual(expect.any(String)),
      WAIT,
    );
  });

  it('新建：从采购订单选行，提交体只带原始输入，不带算列与采购数量', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      [`POST inspections`]: (call) => {
        stored.created = call.json;
        return rawInspection({
          id: 'ins9',
          docNo: 'JY-20261128-0002',
          ...(call.json as Raw),
          purchaseOrder: ORDER,
          supplier: SUPPLIER,
          inspector: INSPECTOR,
          files: [],
          lines: [],
        });
      },
      'GET inspections/ins9': () => stored.created as Raw,
    };
    await renderAt('/inspections/new', inspector);

    const dateField = await screen.findByRole(
      'textbox',
      { name: L.fields.inspectionDate },
      WAIT,
    );
    await user.clear(dateField);
    await user.type(dateField, '2026-11-28');
    await user.click(
      await screen.findByRole('button', { name: L.actions.pickOrder }, WAIT),
    );
    expect(
      await screen.findByRole('columnheader', { name: L.fields.purchaseOrder }, WAIT),
    ).toBeVisible();
    await user.click(
      await screen.findByRole('button', { name: L.pickOrder.replace('{{orderNo}}', ORDER.orderNo) }, WAIT),
    );

    // 从订单带出一行，收货默认填尚可收货数量 8；三个算列页面回显。
    expect(await screen.findByRole('textbox', { name: L.fields.receivedQtyLine.replace('{{n}}', '1') }, WAIT)).toHaveValue('8');
    expect(screen.getByTestId('unqualified-0')).toHaveTextContent('0');
    expect(screen.getByTestId('releasable-0')).toHaveTextContent('8');
    expect(screen.getByTestId('return-0')).toHaveTextContent('0');

    // 改合格数量为 7、抽检为 2：提交体里没有 unqualified/releasable/return/purchaseQty。
    await user.clear(
      screen.getByRole('textbox', { name: L.fields.qualifiedQtyLine.replace('{{n}}', '1') }),
    );
    await user.type(
      screen.getByRole('textbox', { name: L.fields.qualifiedQtyLine.replace('{{n}}', '1') }),
      '7',
    );
    await user.clear(
      screen.getByRole('textbox', { name: L.fields.samplingQtyLine.replace('{{n}}', '1') }),
    );
    await user.type(
      screen.getByRole('textbox', { name: L.fields.samplingQtyLine.replace('{{n}}', '1') }),
      '2',
    );
    await user.click(
      await screen.findByRole('button', { name: L.actions.save }, WAIT),
    );

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      inspectionDate: '2026-11-28',
      purchaseOrderId: 'po1',
      fileIds: [],
      lines: [{
        itemId: 'i1',
        inspectionTypeCode: 'full',
        receivedQty: 8,
        inspectionQty: 8,
        qualifiedQty: 7,
        samplingQty: 2,
        samplingQualifiedQty: 0,
        lossQty: 0,
        retainedQty: 0,
      }],
    });
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/inspections/ins9'),
      WAIT,
    );
  });

  it('详情回显服务端算出的算列与可入库数量', async () => {
    await renderAt('/inspections/ins1', inspector);

    expect(await screen.findByText('JY-20261128-0001', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('detail-releasable-0')).toHaveTextContent('7');
    expect(screen.getByTestId('inspection-total-releasable')).toHaveTextContent('7');
  });

  it.each([
    ['inspector', inspector, true, false],
    ['manager', manager, false, true],
    ['buyer', buyer, false, false],
  ] as const)('详情按角色显隐完成与作废：%s', async (_name, grants, canComplete, canVoid) => {
    await renderAt('/inspections/ins1', grants);

    expect(await screen.findByText('JY-20261128-0001', {}, WAIT)).toBeVisible();
    const complete = screen.queryByRole('button', { name: L.actions.complete });
    const voidButton = screen.queryByRole('button', { name: L.actions.void });
    const edit =
      screen.queryByRole('button', { name: L.actions.edit }) ??
      screen.queryByRole('link', { name: L.actions.edit });
    expect(Boolean(complete)).toBe(canComplete);
    expect(Boolean(voidButton)).toBe(canVoid);
    expect(Boolean(edit)).toBe(canComplete);
  });

  it('非 pending 的单据不画任何写动作', async () => {
    handlers = {
      ...handlers,
      'GET inspections/ins1': () => rawInspection({ status: 'passed' }),
    };
    await renderAt('/inspections/ins1', inspector);

    expect(await screen.findByText('JY-20261128-0001', {}, WAIT)).toBeVisible();
    expect(screen.queryByRole('button', { name: L.actions.complete })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: L.actions.void })).not.toBeInTheDocument();
  });

  it('点完成检验发 POST /complete 并重读这一张', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'POST inspections/ins1/complete': () =>
        rawInspection({ status: 'passed' }),
    };
    await renderAt('/inspections/ins1', inspector);

    const button = await screen.findByRole(
      'button',
      { name: L.actions.complete },
      WAIT,
    );
    await user.click(button);
    await waitFor(
      () => expect(calls('POST', 'inspections/ins1/complete')).toHaveLength(1),
      WAIT,
    );
    await waitFor(
      () => expect(calls('GET', 'inspections/ins1')).toHaveLength(2),
      WAIT,
    );
  });

  it('只读会话在列表上不画新建按钮', async () => {
    await renderAt('/inspections', buyer);
    expect(await screen.findByText('JY-20261128-0001', {}, WAIT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: L.actions.new }),
    ).not.toBeInTheDocument();
  });
});
