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
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import TransferDetailPage from '../../client/pages/transfer/detail.js';
import TransferEditPage from '../../client/pages/transfer/edit.js';
import TransferListPage from '../../client/pages/transfer/index.js';
import TransferNewPage from '../../client/pages/transfer/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/** R-020 波 2：调拨单页面。真实 hook 与路由容器，HTTP 用夹具；数据一律编造。 */
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

const WAREHOUSE_IN = { id: 'w1', code: 'WH01', name: 'Sample Destination', status: 'active' };
const WAREHOUSE_OUT = { id: 'w2', code: 'WH02', name: 'Sample Source', status: 'active' };
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
  itemType: 'material',
  categoryCode: null,
  unitCode: 'KG',
  status: 'active',
};
const L = enUS.transfer;

type Raw = Record<string, unknown>;
function rawTransfer(overrides: Raw = {}): Raw {
  return {
    id: 't1',
    docNo: 'DB-20261127-0001',
    docDate: '2026-11-27',
    status: 'draft',
    warehouseIn: { id: WAREHOUSE_IN.id, name: WAREHOUSE_IN.name },
    warehouseOut: { id: WAREHOUSE_OUT.id, name: WAREHOUSE_OUT.name },
    handler: { userId: HANDLER.userId, name: HANDLER.name },
    remark: 'Sample remark',
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: 'l1',
        itemId: ITEM.id,
        qty: 10,
        transferQty: 8,
        note: null,
        item: {
          id: ITEM.id, code: ITEM.code, name: ITEM.name,
          spec: null, unitCode: ITEM.unitCode,
        },
      },
    ],
    files: [],
    ...overrides,
  };
}

const grant = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const warehouse: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    grant('transfers', ['view', 'create', 'update', 'post', 'void']),
    grant('items', ['view']),
    grant('inventory', ['warehouseView']),
    grant('bizOptions', ['view']),
  ],
};

let permissions: AuthorizationSnapshot;
let storedCreated: Raw = {};
let posted = false;
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

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/transfers' element={<TransferListPage />} />
        <Route path='/transfers/new' element={<TransferNewPage />} />
        <Route path='/transfers/:transferId' element={<TransferDetailPage />} />
        <Route path='/transfers/:transferId/edit' element={<TransferEditPage />} />
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
  storedCreated = {};
  posted = false;
  handlers = {
    'GET items': () => page(ITEM),
    'GET warehouses': () => page(WAREHOUSE_IN, WAREHOUSE_OUT),
    'GET person-options': () => page(HANDLER),
    'GET transfers/t1': () => rawTransfer({ status: posted ? 'posted' : 'draft' }),
  };
});

describe('R-020 调拨单页面', () => {
  it('新建默认三行，提交时只送填过的行，实调默认等于申请数', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'POST transfers': (call) => {
        storedCreated = call.json as Raw;
        return rawTransfer({ id: 't9', docNo: 'DB-20261127-0002' });
      },
      'GET transfers/t9': () => rawTransfer({ id: 't9', docNo: 'DB-20261127-0002' }),
    };
    const view = await renderAt('/transfers/new', warehouse);

    // 默认三行，未填的行不发给端点、也不参与校验。
    expect(await screen.findAllByRole('button', { name: L.actions.removeLine }, WAIT)).toHaveLength(3);
    await choose(user, L.fields.warehouseIn, WAREHOUSE_IN.name);
    await choose(user, L.fields.warehouseOut, WAREHOUSE_OUT.name);
    await choose(user, L.fields.itemLine.replace('{{n}}', '1'), `${ITEM.code} ${ITEM.name}`);
    fireEvent.change(
      await screen.findByRole('textbox', { name: L.fields.qtyLine.replace('{{n}}', '1') }, WAIT),
      { target: { value: '10' } },
    );
    await user.click(await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT));

    await waitFor(() => expect(Object.keys(storedCreated).length).toBeGreaterThan(0), WAIT);
    expect(storedCreated).toEqual({
      transferInWarehouseId: WAREHOUSE_IN.id,
      transferOutWarehouseId: WAREHOUSE_OUT.id,
      docDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      remark: '',
      fileIds: [],
      lines: [{ itemId: ITEM.id, qty: 10, transferQty: 10 }],
    });
    expect(view.toasts()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'success' })]),
    );
  });

  // 缺陷 4：慢请求下守卫不能把「保存草稿」后的导航挡住。
  it('a slow create still opens the detail without a discard prompt', async () => {
    const user = userEvent.setup();
    const saved = rawTransfer({ id: 't-slow', docNo: 'DB-20261127-0003' });
    handlers = {
      ...handlers,
      'POST transfers': async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return saved;
      },
      'GET transfers/t-slow': () => saved,
    };
    await renderAt('/transfers/new', warehouse);
    await choose(user, L.fields.warehouseIn, WAREHOUSE_IN.name);
    await choose(user, L.fields.itemLine.replace('{{n}}', '1'), `${ITEM.code} ${ITEM.name}`);
    fireEvent.change(
      await screen.findByRole('textbox', { name: L.fields.qtyLine.replace('{{n}}', '1') }, WAIT),
      { target: { value: '10' } },
    );
    await user.click(await screen.findByRole('button', { name: L.actions.saveDraft }, WAIT));
    // 这个夹具没有 LocationProbe：详情的单号出现才说明慢保存后的导航真的发生了。
    expect(await screen.findByText('DB-20261127-0003', {}, WAIT)).toBeVisible();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('过账前先确认，明确说明过账才改库存，确认前不发请求', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'POST transfers/t1/post': () => {
        posted = true;
        return {
        transfer: rawTransfer({ status: 'posted' }),
        outDocId: 'd1',
        inDocId: 'd2',
        };
      },
      'GET stock-docs': () => page(
        { id: 'd1', docNo: 'CK-0001', docType: 'out', reason: 'other_out', status: 'posted' },
        { id: 'd2', docNo: 'RK-0001', docType: 'in', reason: 'other_in', status: 'posted' },
      ),
    };
    await renderAt('/transfers/t1', warehouse);
    const postButton = await screen.findByRole('button', { name: L.actions.post }, WAIT);
    await user.click(postButton);
    const dialog = await screen.findByRole('alertdialog', {}, WAIT);
    expect(within(dialog).getByText(L.postDescription)).toBeVisible();
    expect(calls('POST', 'transfers/t1/post')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: L.actions.post }));
    await waitFor(() => expect(calls('POST', 'transfers/t1/post')).toHaveLength(1), WAIT);
    const out = await screen.findByTestId('transfer-out-doc', {}, WAIT);
    expect(out).toHaveAttribute('href', '/outbound-orders/d1');
    const inbound = await screen.findByTestId('transfer-in-doc', {}, WAIT);
    expect(inbound).toHaveAttribute('href', '/inbound-orders/d2');
  });
});
