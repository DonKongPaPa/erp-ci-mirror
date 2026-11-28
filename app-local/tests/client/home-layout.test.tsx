import { apiClientToken } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import { Dashboard } from '../../client/pages/home/dashboard.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * 首页改版的布局门：页面不限宽、部件按 12 栏栅格跨栏、快捷入口是图标加名称的按钮网格、
 * 待我处理是两块数字磁贴。授权过滤与偏好回写在 home.test.tsx 与 dashboard-preferences.test.tsx。
 */
const T = 15_000;
const WAIT = { timeout: T };
const root: AuthorizationSnapshot = { unrestricted: true, permissions: [] };

const calls: ApiCall[] = [];
let approvalsTotals = { tasks: 0, mine: 0 };

function fetchAnswers(call: ApiCall) {
  calls.push(call);
  if (call.path === 'authorization/permissions') return { data: root };
  if (call.path === 'approvals/tasks') return { items: [], total: approvalsTotals.tasks };
  if (call.path === 'approvals/mine') return { items: [], total: approvalsTotals.mine };
  return new Response(null, { status: 404 });
}

async function renderDashboard(ui: ReactElement) {
  calls.length = 0;
  return renderWithApp(ui, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi(fetchAnswers),
    services: (app: { container: { singleton: (...args: unknown[]) => unknown } }) => {
      app.container.singleton(
        authorizationClientToken,
        (resolver: { resolve: (token: unknown) => unknown }) =>
          new AuthorizationClient(resolver.resolve(apiClientToken) as never),
      );
    },
  });
}

const cell = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector(`[data-widget-id="${id}"]`);

async function cellVisible(container: HTMLElement, id: string): Promise<void> {
  await waitFor(() => expect(cell(container, id)).not.toBeNull(), WAIT);
}

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  approvalsTotals = { tasks: 0, mine: 0 };
});

describe('home layout redesign', () => {
  it('fills the shell: no width cap and no centering on the page frame', async () => {
    const { container } = await renderDashboard(<Dashboard roleKey='root' />);
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.quickActions },
      WAIT,
    );
    const page = container.firstElementChild;
    expect(page?.tagName).toBe('SECTION');
    expect(page?.className).not.toContain('max-w-6xl');
    expect(page?.className).not.toContain('mx-auto');
    expect(page?.className).toContain('w-full');
  });

  it('places each widget on the 12-column grid and merges the two shortcut widgets', async () => {
    const { container } = await renderDashboard(<Dashboard roleKey='root' />);
    await Promise.all([
      cellVisible(container, 'quickActions'),
      cellVisible(container, 'myTasks'),
      cellVisible(container, 'deliveryReminders'),
      cellVisible(container, 'favoriteReports'),
    ]);
    expect(cell(container, 'quickActions')?.className).toContain('col-span-12');
    expect(cell(container, 'quickActions')?.className).toContain('xl:col-span-8');
    expect(cell(container, 'myTasks')?.className).toContain('col-span-12');
    expect(cell(container, 'myTasks')?.className).toContain('md:col-span-6');
    expect(cell(container, 'myTasks')?.className).toContain('xl:col-span-4');
    expect(cell(container, 'deliveryReminders')?.className).toContain('col-span-12');
    expect(cell(container, 'deliveryReminders')?.className).toContain('xl:col-span-8');
    expect(cell(container, 'favoriteReports')?.className).toContain('col-span-12');
    expect(cell(container, 'favoriteReports')?.className).toContain('md:col-span-6');
    expect(cell(container, 'favoriteReports')?.className).toContain('xl:col-span-4');
    // 合并显示后，库存快捷入口不再单独占一格。
    expect(cell(container, 'inventoryShortcuts')).toBeNull();
    // 上面四格都等到稳定后，这里同步断言「不存在」才是有意义的（testing 篇的等待规则）。
    expect(
      // eslint-disable-next-line app-local/no-sync-query-after-action -- await 的封装结束时 DOM 已同步落地，查的是它的同步产出
      screen.queryByRole('heading', { name: enUS.dashboard.widgets.inventoryShortcuts }),
    ).not.toBeInTheDocument();
  });

  it('renders the inventory shortcuts inside the merged quick access block', async () => {
    const { container } = await renderDashboard(<Dashboard roleKey='root' />);
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.quickActions },
      WAIT,
    );
    const block = cell(container, 'quickActions');
    expect(block).not.toBeNull();
    expect(
      await within(block as HTMLElement).findByRole(
        'link',
        { name: enUS.navigation.stock },
        WAIT,
      ),
    ).toHaveAttribute('href', '/stock');
  });

  it('keeps the inventory shortcuts block alone when quick actions are hidden', async () => {
    const { container } = await renderDashboard(
      <Dashboard
        roleKey='warehouse'
        preference={{ widgets: [{ id: 'inventoryShortcuts', collapsed: false }] }}
      />,
    );
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.inventoryShortcuts },
      WAIT,
    );
    expect(
      screen.queryByRole('heading', { name: enUS.dashboard.widgets.quickActions }),
    ).not.toBeInTheDocument();
    const block = cell(container, 'inventoryShortcuts');
    expect(
      await within(block as HTMLElement).findByRole(
        'link',
        { name: enUS.navigation.inboundOrders },
        WAIT,
      ),
    ).toHaveAttribute('href', '/inbound-orders');
  });

  it('renders quick access as a button grid with an icon and a name per tile', async () => {
    await renderDashboard(<Dashboard roleKey='root' />);
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.quickActions },
      WAIT,
    );
    const grid = await screen.findByTestId('quick-access-grid', {}, WAIT);
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).toContain('sm:grid-cols-3');
    expect(grid.className).toContain('xl:grid-cols-4');
    expect(grid.className).toContain('2xl:grid-cols-6');
    // 网格先出现，逐项授权落定后磁贴才挂上来：这里必须等，不能同步查。
    const tile = await within(grid).findByRole(
      'link',
      { name: enUS.dashboard.quick.newPurchaseOrder },
      WAIT,
    );
    expect(tile).toHaveAttribute('href', '/purchase-orders');
    expect(tile.querySelector('svg')).not.toBeNull();
    expect(within(tile).getByText(enUS.dashboard.quick.newPurchaseOrder)).toBeVisible();
  });

  it('shows my work as two number tiles with an icon, linking to the approval pages', async () => {
    approvalsTotals = { tasks: 3, mine: 5 };
    const { container } = await renderDashboard(<Dashboard roleKey='root' />);
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.myTasks },
      WAIT,
    );
    const block = cell(container, 'myTasks');
    expect(block).not.toBeNull();
    const scope = within(block as HTMLElement);
    const tiles = scope.getByTestId('my-tasks-tiles');
    expect(tiles.className).toContain('grid-cols-2');
    const tasksTile = await scope.findByRole(
      'link',
      { name: new RegExp(enUS.dashboard.tasks.approvals) },
      WAIT,
    );
    expect(tasksTile).toHaveAttribute('href', '/approvals/tasks');
    expect(tasksTile.querySelector('svg')).not.toBeNull();
    const tasksCount = within(tasksTile).getByText('3');
    expect(tasksCount.className).toContain('text-2xl');
    const mineTile = await scope.findByRole(
      'link',
      { name: new RegExp(enUS.dashboard.tasks.mine) },
      WAIT,
    );
    expect(mineTile).toHaveAttribute('href', '/approvals/mine');
    const mineCount = within(mineTile).getByText('5');
    expect(mineCount.className).toContain('text-2xl');
  });

  it('gives the favorite reports empty state an icon and an explanation', async () => {
    const { container } = await renderDashboard(<Dashboard roleKey='root' />);
    await screen.findByRole(
      'heading',
      { name: enUS.dashboard.widgets.favoriteReports },
      WAIT,
    );
    const block = cell(container, 'favoriteReports');
    expect(block).not.toBeNull();
    const empty = within(block as HTMLElement).getByTestId('favorite-reports-empty');
    expect(empty.querySelector('svg')).not.toBeNull();
    expect(within(empty).getByText(enUS.dashboard.reports.empty)).toBeVisible();
  });
});
