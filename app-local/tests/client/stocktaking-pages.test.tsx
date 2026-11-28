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
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import StocktakingDetailPage from '../../client/pages/stocktaking/detail.js';
import StocktakingEditPage from '../../client/pages/stocktaking/edit.js';
import StocktakingListPage from '../../client/pages/stocktaking/index.js';
import StocktakingNewPage from '../../client/pages/stocktaking/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/** R-020 波 2：盘点单页面。真实 hook 与路由容器，HTTP 用夹具；数据一律编造。 */
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

const WAREHOUSE = { id: 'w1', code: 'WH01', name: 'Sample Main Warehouse', status: 'active' };
const HANDLER = {
  userId: 'u1',
  name: 'Sample Handler',
  departmentId: 'd1',
  departmentName: 'Sample Dept',
};
const SUPERVISOR = {
  userId: 'u2',
  name: 'Sample Supervisor',
  departmentId: 'd1',
  departmentName: 'Sample Dept',
};
const ITEM = {
  id: 'i1',
  code: 'M2611180001',
  name: 'Sample Steel Sheet',
  spec: null,
  itemType: 'material',
  categoryCode: null,
  unitCode: 'KG',
  status: 'active',
};
const L = enUS.stocktaking;

type Raw = Record<string, unknown>;
function rawStocktaking(overrides: Raw = {}): Raw {
  return {
    id: 'r1',
    docNo: 'PD-20261127-0001',
    docDate: '2026-11-27',
    status: 'staging',
    warehouse: { id: WAREHOUSE.id, name: WAREHOUSE.name },
    handler: { userId: HANDLER.userId, name: HANDLER.name },
    supervisor: null,
    remark: 'Sample remark',
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: 'l1',
        itemId: ITEM.id,
        systemQty: 10,
        actualQty: null,
        deltaQty: null,
        result: null,
        note: null,
        item: {
          id: ITEM.id, code: ITEM.code, name: ITEM.name,
          spec: null, unitCode: ITEM.unitCode, barcode: null,
        },
      },
    ],
    files: [],
    ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawStocktaking(overrides);
  return rest;
};

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
/** 仓管：建、改、暂存、作废与读，没有结束盘点的 finish。 */
const warehouse: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('stocktakings', ['view', 'create', 'update', 'void']),
    grant('items', ['view']),
    grant('inventory', ['warehouseView', 'stockView']),
    grant('bizOptions', ['view']),
  ],
};
/** 财务：读与监盘结束，没有建、改、作废。 */
const finance: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('stocktakings', ['view', 'finish']),
    grant('inventory', ['warehouseView']),
    grant('bizOptions', ['view']),
  ],
};

let storedFinish: Raw = {};
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
        <Route path='/stocktakings' element={<StocktakingListPage />} />
        <Route path='/stocktakings/new' element={<StocktakingNewPage />} />
        <Route path='/stocktakings/:stocktakingId' element={<StocktakingDetailPage />} />
        <Route path='/stocktakings/:stocktakingId/edit' element={<StocktakingEditPage />} />
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
    'GET items': () => page(ITEM),
    'GET warehouses': () => page(WAREHOUSE),
    'GET person-options': () => page(HANDLER, SUPERVISOR),
    'GET stock/balances': () =>
      page({ itemId: ITEM.id, warehouseId: WAREHOUSE.id, batchNo: '', qty: 10 }),
    'GET stocktakings': () => page(listRow()),
    'GET stocktakings/r1': () => rawStocktaking(),
  };
});

describe('R-020 盘点单页面', () => {
  it('新建提交契约里的仓库与实盘数量，系统数量只回显不由页面计算', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST stocktakings': (call) => {
        stored.created = call.json;
        return rawStocktaking({ id: 'r9', docNo: 'PD-20261127-0002', ...(call.json as Raw) });
      },
      'GET stocktakings/r9': () => stored.request ?? rawStocktaking({ id: 'r9', docNo: 'PD-20261127-0002' }),
    };
    const view = await renderAt('/stocktakings/new', warehouse);

    await choose(user, L.fields.warehouse, WAREHOUSE.name);
    await user.click(await screen.findByRole('button', { name: L.actions.addLine }, WAIT));
    await choose(user, L.fields.itemLine.replace('{{n}}', '1'), `${ITEM.code} ${ITEM.name}`);
    fireEvent.change(
      await screen.findByRole('textbox', { name: L.fields.actualQtyLine.replace('{{n}}', '1') }, WAIT),
      { target: { value: '12' } },
    );
    await user.click(await screen.findByRole('button', { name: L.actions.stage }, WAIT));

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      remark: '',
      fileIds: [],
      lines: [{ itemId: ITEM.id, actualQty: 12 }],
      warehouseId: WAREHOUSE.id,
    });
    expect(view.toasts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'success' }),
      ]),
    );
  });

  // 缺陷 4：慢请求下守卫不能把「暂存成功」后的导航挡住。
  it('a slow staging still opens the detail without a discard prompt', async () => {
    const user = userEvent.setup();
    const saved = rawStocktaking({ id: 'r-slow', docNo: 'PD-20261127-0003', status: 'staging' });
    handlers = {
      ...handlers,
      'POST stocktakings': async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return saved;
      },
      'GET stocktakings/r-slow': () => saved,
    };
    await renderAt('/stocktakings/new', warehouse);
    await choose(user, L.fields.warehouse, WAREHOUSE.name);
    await user.click(await screen.findByRole('button', { name: L.actions.addLine }, WAIT));
    await choose(user, L.fields.itemLine.replace('{{n}}', '1'), `${ITEM.code} ${ITEM.name}`);
    fireEvent.change(
      await screen.findByRole('textbox', { name: L.fields.actualQtyLine.replace('{{n}}', '1') }, WAIT),
      { target: { value: '12' } },
    );
    await user.click(await screen.findByRole('button', { name: L.actions.stage }, WAIT));
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/stocktakings/r-slow'),
      WAIT,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('结束按钮按会话实际持有的 finish 动作显隐：仓管看不到，财务看得到', async () => {
    await renderAt('/stocktakings/r1', warehouse);
    expect(await screen.findByText('PD-20261127-0001', {}, WAIT)).toBeVisible();
    // 已经等到单据落定，才断言没有这个按钮。
    expect(screen.queryByRole('button', { name: L.actions.finish })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: L.actions.void })).toBeInTheDocument();
  });

  it('财务在详情里能看到结束盘点并填监盘人后提交', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'POST stocktakings/r1/finish': (call) => {
        storedFinish = call.json;
        return {
          stocktaking: rawStocktaking({ status: 'finished' }),
          profitDocId: 'd1',
          lossDocId: 'd2',
        };
      },
      'GET stocktakings/r1': () => rawStocktaking({ status: 'staging' }),
    };
    await renderAt('/stocktakings/r1', finance);
    const finishButton = await screen.findByRole('button', { name: L.actions.finish }, WAIT);
    expect(screen.queryByRole('button', { name: L.actions.void })).not.toBeInTheDocument();
    await user.click(finishButton);
    await choose(user, L.fields.supervisor, SUPERVISOR.name);
    await user.click(
      screen.getAllByRole('button', { name: L.actions.finish }).at(-1)!,
    );
    await waitFor(() => expect(storedFinish).toEqual({ supervisorUserId: SUPERVISOR.userId }), WAIT);
  });

  it('已结束的详情按盘点单号反查并链接到盘盈入库单与盘亏出库单', async () => {
    handlers = {
      ...handlers,
      'GET stocktakings/r1': () => rawStocktaking({ status: 'finished' }),
      'GET stock-docs': (call) =>
        call.query?.docType === 'in'
          ? page({ id: 'd1', docNo: 'RK-0001', docType: 'in', reason: 'other_in', status: 'posted' })
          : page({ id: 'd2', docNo: 'CK-0001', docType: 'out', reason: 'other_out', status: 'posted' }),
    };
    await renderAt('/stocktakings/r1', warehouse);
    const profit = await screen.findByTestId('stocktaking-profit-doc', {}, WAIT);
    expect(profit).toHaveTextContent('RK-0001');
    expect(profit).toHaveAttribute('href', '/inbound-orders/d1');
    const loss = await screen.findByTestId('stocktaking-loss-doc', {}, WAIT);
    expect(loss).toHaveTextContent('CK-0001');
    expect(loss).toHaveAttribute('href', '/outbound-orders/d2');
    expect(screen.getByTestId('stocktaking-profit-total')).toBeInTheDocument();
    expect(screen.getByTestId('stocktaking-loss-total')).toBeInTheDocument();
  });
});

