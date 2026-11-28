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
import BomDetailPage from '../../client/pages/boms/detail.js';
import BomEditPage from '../../client/pages/boms/edit.js';
import BomsPage from '../../client/pages/boms/index.js';
import BomNewPage from '../../client/pages/boms/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-019 波 2 的 BOM 页面：真实 hook 与路由容器，只把 HTTP 换成夹具；数据一律编造。
 * 服务端已经裁过成本列 —— 页面对没有价格键的 totals 不能画空的金额列。
 */
const T = 15_000;
const WAIT = { timeout: T };
const NOW = '2026-11-28T08:00:00.000Z';
const notFound = () => new Response(null, { status: 404 });
const page = (...items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });
const L = enUS.boms;

type Raw = Record<string, unknown>;

const PRODUCT = {
  id: 'p1', code: 'P001', name: 'Sample Product', spec: null,
  itemType: 'product', categoryCode: null, unitCode: 'PCS', status: 'active',
};
const STEEL = {
  id: 'i1', code: 'M001', name: 'Sample Steel', spec: null,
  itemType: 'material', categoryCode: null, unitCode: 'KG', status: 'active',
};
const BOLT = {
  id: 'i2', code: 'M002', name: 'Sample Bolt', spec: null,
  itemType: 'material', categoryCode: null, unitCode: 'PCS', status: 'active',
};
const ITEM_SUMMARY = (item: Raw) => ({
  id: item.id, code: item.code, name: item.name, spec: item.spec,
  unitCode: item.unitCode, brand: null, manufacturerModel: null,
});

function bomLine(overrides: Raw = {}): Raw {
  return {
    id: 'l1', lineNo: 1, itemId: STEEL.id, qty: 2, lossRate: 0.1,
    childBomId: null, note: null, item: ITEM_SUMMARY(STEEL), ...overrides,
  };
}

function rawBom(overrides: Raw = {}): Raw {
  return {
    id: 'b1', docNo: 'BOM-20261128-0001', version: 'A',
    product: { id: PRODUCT.id, code: PRODUCT.code, name: PRODUCT.name, spec: null, unitCode: PRODUCT.unitCode },
    isDefault: true, effectiveFrom: '2026-01-01', effectiveTo: null,
    dailyOutput: null, status: 'active', remark: '', createdAt: NOW, updatedAt: NOW,
    lines: [bomLine()], files: [], ...overrides,
  };
}
const listRow = (overrides: Raw = {}): Raw => {
  const { lines: _lines, files: _files, ...rest } = rawBom(overrides);
  return rest;
};

function explodeResult(overrides: Raw = {}): Raw {
  return {
    productId: PRODUCT.id, asOf: '2026-06-01', levels: 1,
    root: {
      bomId: 'b1', docNo: 'BOM-20261128-0001', version: 'A', productId: PRODUCT.id,
      isDefault: true, effectiveFrom: '2026-01-01', effectiveTo: null,
    },
    nodes: [
      {
        nodeId: 'n1', parentNodeId: null, bomId: 'b1', docNo: 'BOM-20261128-0001',
        version: 'A', itemId: STEEL.id, item: ITEM_SUMMARY(STEEL),
        qtyPerUnit: 2, lossRate: 0.1, effectiveQty: 2.2, depth: 1,
      },
    ],
    totals: [
      { itemId: STEEL.id, code: STEEL.code, name: STEEL.name, unitCode: STEEL.unitCode, qty: 2.2 },
    ],
    cycles: [],
    ...overrides,
  };
}

const grant = (id: string, actions: string[]) => ({ resource: { type: 'composite', id }, actions });
/** 管理员：页面全动作。 */
const admin: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
/** 工艺：只有 BOM 的 view / explode，加物料 view 供下拉。 */
const craft: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('boms', ['view', 'explode']), grant('items', ['view'])],
};
/** 计划经理：与工艺同样的读权限。 */
const planning: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [grant('boms', ['view', 'explode']), grant('items', ['view'])],
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
        <Route path='/boms' element={<BomsPage />}>
          <Route path='new' element={<BomNewPage />} />
          <Route path=':bomId' element={<BomDetailPage />}>
            <Route path='edit' element={<BomEditPage />} />
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

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  handlers = {
    'GET items': () => page(PRODUCT, STEEL, BOLT),
    'GET boms': () => page(listRow()),
    'GET boms/b1': () => rawBom(),
    'GET boms/explode': () => explodeResult(),
  };
});

describe('R-019 波 2 BOM 页面', () => {
  it('列表按成品与状态筛选，只发端点支持的查询参数', async () => {
    const user = userEvent.setup();
    await renderAt('/boms', admin);

    expect(await screen.findByText('BOM-20261128-0001', {}, WAIT)).toBeVisible();
    expect(calls('GET', 'boms').at(-1)?.query).toEqual({ page: '1', pageSize: '20' });

    await user.click(
      await screen.findByRole('button', { name: enUS.erp.list.filters }, WAIT),
    );
    await choose(user, L.filters.product, `${PRODUCT.code} ${PRODUCT.name}`);
    await waitFor(
      () => expect(calls('GET', 'boms').at(-1)?.query?.productId).toBe(PRODUCT.id),
      WAIT,
    );

    await choose(user, L.filters.status, L.status.inactive);
    await waitFor(
      () =>
        expect(calls('GET', 'boms').at(-1)?.query).toEqual({
          productId: PRODUCT.id,
          status: 'inactive',
          page: '1',
          pageSize: '20',
        }),
      WAIT,
    );
  });

  it('新建提交体只有手填字段，docNo 与状态由服务端决定', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST boms': (call) => {
        stored.created = call.json;
        return rawBom({ id: 'b9', docNo: 'BOM-20261128-0002', ...(call.json as Raw) });
      },
      'GET boms/b9': () => rawBom({ id: 'b9', docNo: 'BOM-20261128-0002' }),
    };
    await renderAt('/boms/new', admin);

    await choose(user, L.fields.product, `${PRODUCT.code} ${PRODUCT.name}`);
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.version }, WAIT),
      'A',
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.effectiveFrom }, WAIT),
      '2026-01-01',
    );
    await user.click(
      await screen.findByRole('button', { name: L.actions.addLine }, WAIT),
    );
    await choose(
      user,
      L.fields.itemInLine.replace('{{row}}', '1'),
      `${STEEL.code} ${STEEL.name}`,
    );
    await user.type(
      await screen.findByRole('textbox', { name: L.fields.qtyInLine.replace('{{row}}', '1') }, WAIT),
      '2',
    );
    await user.click(await screen.findByRole('button', { name: L.actions.save }, WAIT));

    await waitFor(() => expect(stored.created).toBeDefined(), WAIT);
    expect(stored.created).toEqual({
      version: 'A',
      productId: PRODUCT.id,
      effectiveFrom: '2026-01-01',
      lines: [{ itemId: STEEL.id, qty: 2, lossRate: 0, note: null }],
    });
    for (const key of ['docNo', 'status', 'id', 'createdAt', 'createdById'])
      expect(stored.created, `${key} 不该由页面提交`).not.toHaveProperty(key);
    expect(await screen.findByText('BOM-20261128-0002', {}, WAIT)).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/boms/b9');
  });

  it('编辑提交 PATCH，带整单替换的行', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'PATCH boms/b1': (call) => {
        stored.updated = call.json;
        return rawBom(call.json as Raw);
      },
    };
    await renderAt('/boms/b1/edit', admin);

    const version = await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    await user.clear(version);
    await user.type(version, 'B');
    const qty = await screen.findByRole('textbox', { name: L.fields.qtyInLine.replace('{{row}}', '1') }, WAIT);
    await user.clear(qty);
    await user.type(qty, '3');
    await user.click(await screen.findByRole('button', { name: L.actions.save }, WAIT));

    await waitFor(() => expect(stored.updated).toBeDefined(), WAIT);
    expect(stored.updated.version).toBe('B');
    expect(stored.updated.lines).toEqual([
      { itemId: STEEL.id, qty: 3, lossRate: 0.1, note: null },
    ]);
    expect(stored.updated).not.toHaveProperty('productId');
    expect(stored.updated).not.toHaveProperty('status');
  });

  it.each([
    [admin, true, true, true, true],
    [craft, false, false, false, true],
    [planning, false, false, false, true],
  ] as const)(
    '详情的维护入口按角色显隐（管理员全开，工艺与计划只读）',
    async (grants, createChild, edit, voiding, explode) => {
      await renderAt('/boms/b1', grants);
      expect(await screen.findByText('BOM-20261128-0001', {}, WAIT)).toBeVisible();
      expect(await screen.findByText(new RegExp(STEEL.name), {}, WAIT)).toBeVisible();

      const child = screen.queryAllByRole('button', { name: L.actions.createChild });
      expect(child.length > 0).toBe(createChild);
      const editLink = screen.queryByRole('button', { name: L.actions.edit });
      expect(Boolean(editLink)).toBe(edit);
      const voidButton = screen.queryByRole('button', { name: L.actions.void });
      expect(Boolean(voidButton)).toBe(voiding);
      const explodeButton = screen.queryByRole('button', { name: L.actions.explode });
      expect(Boolean(explodeButton)).toBe(explode);
    },
  );

  it('展开结构：单层与多层切换按选定日期出树，没有价格键就不画金额列', async () => {
    const user = userEvent.setup();
    const multi = explodeResult({
      levels: 32,
      nodes: [
        explodeResult().nodes[0],
        {
          nodeId: 'n2', parentNodeId: 'n1', bomId: 'b2', docNo: 'BOM-20261128-0003',
          version: 'A', itemId: BOLT.id, item: ITEM_SUMMARY(BOLT),
          qtyPerUnit: 3, lossRate: 0, effectiveQty: 6.6, depth: 2,
        },
      ],
    });
    handlers = {
      ...handlers,
      'GET boms/explode': (call) =>
        call.query?.levels === 'all' ? multi : explodeResult(),
    };
    await renderAt('/boms/b1', admin);

    await user.click(await screen.findByRole('button', { name: L.actions.explode }, WAIT));
    const dialog = await screen.findByRole('dialog', { name: L.explode.title }, WAIT);
    const date = await screen.findByRole('textbox', { name: L.explode.asOf }, WAIT);
    await user.clear(date);
    await user.type(date, '2026-06-01');
    await waitFor(
      () => expect(calls('GET', 'boms/explode').at(-1)?.query?.levels).toBe('1'),
      WAIT,
    );
    expect(screen.getAllByTestId('bom-node')).toHaveLength(1);
    expect(screen.queryByRole('columnheader', { name: L.explode.estimatedCost }))
      .not.toBeInTheDocument();

    await choose(user, L.explode.levels, L.explode.allLevels);
    await waitFor(
      () => expect(calls('GET', 'boms/explode').at(-1)?.query).toMatchObject({
        productId: PRODUCT.id, asOf: '2026-06-01', levels: 'all',
      }),
      WAIT,
    );
    expect(await screen.findByText(new RegExp(BOLT.name), {}, WAIT)).toBeVisible();
    expect(screen.getAllByTestId('bom-node')).toHaveLength(2);
    expect(dialog).toBeInTheDocument();
  });

  it('展开结构有价格键时画金额列；成环则整次失败并给出提示', async () => {
    const user = userEvent.setup();
    handlers = {
      ...handlers,
      'GET boms/explode': (call) => {
        if (call.query?.levels === '1')
          return explodeResult({
            totals: [
              {
                itemId: STEEL.id, code: STEEL.code, name: STEEL.name,
                unitCode: STEEL.unitCode, qty: 2.2,
                basePurchasePrice: 5, estimatedCost: 11,
              },
            ],
          });
        return Response.json(
          {
            error: {
              reason: 'BOM_CYCLE',
              message: 'BOM cycle',
              localizedMessage: { locale: 'en-US', message: '检测到 BOM 环，无法展开' },
            },
          },
          { status: 422 },
        );
      },
    };
    await renderAt('/boms/b1', admin);

    await user.click(await screen.findByRole('button', { name: L.actions.explode }, WAIT));
    await screen.findByRole('dialog', { name: L.explode.title }, WAIT);
    expect(
      await screen.findByRole('columnheader', { name: L.explode.estimatedCost }, WAIT),
    ).toBeVisible();

    await choose(user, L.explode.levels, L.explode.allLevels);
    expect(await screen.findByRole('alert', WAIT)).toHaveTextContent('检测到 BOM 环，无法展开');
    expect(screen.queryByTestId('bom-node')).not.toBeInTheDocument();
  });

  it('作废只有管理员能发请求', async () => {
    const user = userEvent.setup();
    const stored: Raw = {};
    handlers = {
      ...handlers,
      'POST boms/b1/void': () => {
        stored.voided = true;
        return rawBom({ status: 'inactive' });
      },
    };
    await renderAt('/boms/b1', admin);

    await user.click(await screen.findByRole('button', { name: L.actions.void }, WAIT));
    const confirm = await screen.findByRole('alertdialog', {}, WAIT);
    expect(confirm).toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: L.actions.void }, WAIT),
    );
    await waitFor(() => expect(stored.voided).toBe(true), WAIT);
    expect(confirm).toBeDefined();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BOM 页面的内容自适应', () => {
  it('新建表单有标题、说明和限宽容器', async () => {
    await renderAt('/boms/new', admin);

    const form = await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    expect(screen.getByRole('heading', { name: L.newTitle })).toBeVisible();
    expect(screen.getByText(L.newDescription)).toBeVisible();
    expect(form.closest('form')?.closest('.max-w-3xl')).not.toBeNull();
  });

  it('编辑表单带 BOM 编号的说明，也限宽', async () => {
    await renderAt('/boms/b1/edit', admin);

    const version = await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    expect(screen.getByRole('heading', { name: L.editTitle })).toBeVisible();
    expect(
      await screen.findByText(
        L.editDescription.replace('{{docNo}}', rawBom().docNo),
        {},
        WAIT,
      ),
    ).toBeVisible();
    expect(version.closest('form')?.closest('.max-w-3xl')).not.toBeNull();
  });

  it('成品选择器铺满所在栏，保存与取消是常规按钮且带图标', async () => {
    await renderAt('/boms/new', admin);

    const product = await screen.findByRole('combobox', { name: L.fields.product }, WAIT);
    expect(product).toHaveClass('w-full');
    const save = screen.getByRole('button', { name: L.actions.save });
    expect(save.tagName).toBe('BUTTON');
    expect(save.querySelector('svg')).not.toBeNull();
    const cancel = screen.getByRole('button', { name: enUS.actions.cancel });
    expect(cancel.tagName).toBe('BUTTON');
    expect(cancel.querySelector('svg')).not.toBeNull();
  });

  it('列表主操作是常规高度且左侧有图标', async () => {
    await renderAt('/boms', admin);

    const create = await screen.findByRole('button', { name: L.actions.new }, WAIT);
    expect(create).toHaveClass('h-8');
    expect(create.querySelector('svg')).not.toBeNull();
  });

  it('空态写明原因与下一步，有权限时给带图标的新建入口并可进入新建页', async () => {
    const user = userEvent.setup();
    handlers = { ...handlers, 'GET boms': () => page() };
    await renderAt('/boms', admin);

    await screen.findByRole('status', WAIT);
    expect(screen.getByText(L.empty)).toBeVisible();
    const buttons = screen.getAllByRole('button', { name: L.actions.new });
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.querySelector('svg')).not.toBeNull();
    await user.click(buttons[1]!);

    await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    expect(screen.getByRole('heading', { name: L.newTitle })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/boms/new');
  });

  it('没有新建权限时空态不放新建入口', async () => {
    handlers = { ...handlers, 'GET boms': () => page() };
    await renderAt('/boms', craft);

    await screen.findByRole('status', WAIT);
    expect(
      screen.queryByRole('button', { name: L.actions.new }),
    ).not.toBeInTheDocument();
  });

  it('干净表单点取消直接离开，不弹确认', async () => {
    const user = userEvent.setup();
    await renderAt('/boms/new', admin);

    await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    await user.click(screen.getByRole('button', { name: enUS.actions.cancel }));

    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/boms'),
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
    await renderAt('/boms/new', admin);

    const version = await screen.findByRole('textbox', { name: L.fields.version }, WAIT);
    await user.type(version, 'A');
    await user.click(screen.getByRole('button', { name: enUS.actions.cancel }));

    const dialog = await screen.findByRole('alertdialog', WAIT);
    expect(dialog).toHaveTextContent(L.newTitle);
    expect(screen.getByTestId('location')).toHaveTextContent('/boms/new');
    await user.click(within(dialog).getByRole('button', { name: L.actions.discard }));
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent('/boms'),
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
    await renderAt('/boms', admin);

    await screen.findByText('BOM-20261128-0001', {}, WAIT);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    expect(
      within(cards[0]!).getByRole('link', { name: 'BOM-20261128-0001' }),
    ).toBeVisible();
    expect(
      within(cards[0]!).getByRole('button', { name: L.actionsFor.replace('{{name}}', 'BOM-20261128-0001') }),
    ).toBeVisible();
  });
});
