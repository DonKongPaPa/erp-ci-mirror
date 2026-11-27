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
import ApprovalDetailPage from '../../client/pages/approvals/detail.js';
import ApprovalMinePage from '../../client/pages/approvals/mine.js';
import ApprovalTasksPage from '../../client/pages/approvals/tasks.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-017 M5：三个审批页面的组件测试。真实页面、真实 hook 与路由容器，只把 HTTP 换成夹具。
 * 验的四件事：列表请求参数与地址栏状态、按钮两层显隐、时间线（含转交加签）、转交弹窗只显示姓名。
 * 所有人员与业务数据都是编造的。
 */
const T = 15_000;
const WAIT = { timeout: T };
const submitOnly: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'composite', id: 'approval' }, actions: ['submit'] },
  ],
};
const both: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    {
      resource: { type: 'composite', id: 'approval' },
      actions: ['submit', 'review'],
    },
  ],
};

const CREATED = '2026-11-20T08:00:00.000Z';
const UPDATED = '2026-11-21T09:30:00.000Z';

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions'
    ? { data: permissions }
    : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

function LocationProbe(): ReactElement {
  const { pathname, search } = useLocation();
  return (
    <>
      <span data-testid='location'>{pathname}</span>
      <span data-testid='search'>{search}</span>
    </>
  );
}

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/approvals/mine' element={<ApprovalMinePage />} />
        <Route path='/approvals/tasks' element={<ApprovalTasksPage />} />
        <Route path='/approvals/:id' element={<ApprovalDetailPage />} />
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

const mineRow = {
  id: 'a1',
  status: 'approved',
  currentRound: 1,
  workflowKey: 'leave',
  collectionName: 'leaveRequests',
  dataKey: 'L-1',
  lifecycleVersion: 3,
  createdAt: CREATED,
  updatedAt: UPDATED,
};
const taskRow = {
  id: 't1',
  approvalId: 'a1',
  nodeKey: 'manager',
  status: 'pending',
  seq: 1,
  dueAt: null,
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    roundId: 'r1',
    nodeKey: 'manager',
    status: 'pending',
    seq: 1,
    origin: 'normal',
    assigneeName: '审批甲',
    comment: null,
    actedAt: null,
    prevRecordId: null,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    status: 'submitted',
    currentRound: 1,
    lifecycleVersion: 1,
    workflowKey: 'leave',
    collectionName: 'leaveRequests',
    dataKey: 'L-1',
    available: ['withdraw', 'abort'],
    rounds: [
      {
        id: 'r1',
        approvalId: 'a1',
        round: 1,
        status: 'processing',
        snapshot: { amount: 10, reason: '休息' },
        startedAt: CREATED,
        endedAt: null,
      },
    ],
    records: [record()],
    ...overrides,
  };
}

function callsTo(path: string): ApiCall[] {
  return api.mock.calls.map(([call]) => call).filter((call) => call.path === path);
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = (call) => {
    if (call.path === 'approvals/mine')
      return { data: [mineRow], meta: { page: 1, pageSize: 20, total: 1 } };
    if (call.path === 'approvals/tasks')
      return { data: [taskRow], meta: { page: 1, pageSize: 20, total: 1 } };
    if (call.path === 'approvals/a1') return { data: detail() };
    return new Response(null, { status: 404 });
  };
});

describe('R-017 审批页面', () => {
  it('我的申请：按地址栏的页签、关键字、页码与排序发请求，并保留页签状态', async () => {
    await renderAt(
      '/approvals/mine?scope=completed&q=leaf&page=2&pageSize=10&sort=updatedAt&order=asc',
      submitOnly,
    );

    const link = await screen.findByTestId('approval-link', {}, WAIT);
    expect(link).toHaveTextContent('leave');
    expect(callsTo('approvals/mine')).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        query: {
          scope: 'completed',
          q: 'leaf',
          page: '2',
          pageSize: '10',
          sortBy: 'updatedAt',
          sortDir: 'asc',
        },
      }),
    );
    // 链接把列表自己的查询串带到详情，返回时才不丢页签。
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining(
        '/approvals/a1?scope=completed&q=leaf&page=2&pageSize=10&sort=updatedAt&order=asc',
      ),
    );

    await userEvent.click(
      screen.getByRole('tab', { name: enUS.approvals.scope.all }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('search')).toHaveTextContent('scope=all'),
    );
    expect(screen.getByTestId('search')).not.toHaveTextContent('page=2');
  });

  it('我的审批：按 scope=pending 取数，切到已完成时页签写进地址栏', async () => {
    await renderAt('/approvals/tasks?scope=pending', both);

    expect(await screen.findByTestId('task-link', {}, WAIT)).toHaveTextContent(
      'manager',
    );
    expect(callsTo('approvals/tasks')).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        query: { scope: 'pending', page: '1', pageSize: '20', sortBy: 'createdAt', sortDir: 'desc' },
      }),
    );

    await userEvent.click(
      screen.getByRole('tab', { name: enUS.approvals.scope.done }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('search')).toHaveTextContent('scope=done'),
    );
    await waitFor(() =>
      expect(callsTo('approvals/tasks')).toContainEqual(
        expect.objectContaining({ query: expect.objectContaining({ scope: 'done' }) }),
      ),
    );
  });

  it('按钮显隐第一层：没有 review 就没有审批操作，有 submit 才能撤回', async () => {
    answer = (call) =>
      call.path === 'approvals/a1'
        ? { data: detail({ available: ['withdraw', 'abort', 'approve', 'reject', 'return', 'delegate', 'add-sign'] }) }
        : new Response(null, { status: 404 });
    await renderAt('/approvals/a1', submitOnly);
    expect(await screen.findByTestId('approval-detail', {}, WAIT)).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: enUS.approvals.actions.withdraw }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enUS.approvals.actions.approve }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enUS.approvals.actions.delegate }),
    ).not.toBeInTheDocument();
  });

  it('按钮显隐第二层：审批按钮按 available 给，不再靠地址栏的任务 id', async () => {
    answer = (call) =>
      call.path === 'approvals/a1'
        ? { data: detail({ available: ['approve', 'reject', 'return', 'delegate', 'add-sign'] }) }
        : new Response(null, { status: 404 });
    await renderAt('/approvals/a1', both);
    const panel = await screen.findByTestId('approval-detail', {}, WAIT);
    await waitFor(() => expect(panel).not.toHaveAttribute('aria-busy'));

    for (const key of ['approve', 'reject', 'return', 'delegate', 'addSign'] as const)
      expect(
        within(panel).getByRole('button', { name: enUS.approvals.actions[key] }),
      ).toBeInTheDocument();
  });

  it('available 不含审批动作时，地址栏即便带着待处理任务 id 也不显示审批按钮', async () => {
    await renderAt('/approvals/a1?task=t1', both);
    const panel = await screen.findByTestId('approval-detail', {}, WAIT);
    await waitFor(() => expect(panel).not.toHaveAttribute('aria-busy'));

    for (const key of ['approve', 'reject', 'return', 'delegate', 'addSign'] as const)
      expect(
        within(panel).queryByRole('button', { name: enUS.approvals.actions[key] }),
      ).not.toBeInTheDocument();
  });

  it('详情时间线按轮分组，并显示转交与加签的行', async () => {
    answer = (call) =>
      call.path === 'approvals/a1'
        ? {
            data: detail({
              rounds: [
                {
                  id: 'r1',
                  approvalId: 'a1',
                  round: 1,
                  status: 'withdrawn',
                  snapshot: { amount: 10, reason: '休息' },
                  startedAt: CREATED,
                  endedAt: UPDATED,
                },
                {
                  id: 'r2',
                  approvalId: 'a1',
                  round: 2,
                  status: 'processing',
                  snapshot: { amount: 20, reason: '再休息' },
                  startedAt: UPDATED,
                  endedAt: null,
                },
              ],
              records: [
                record({ id: 't0', roundId: 'r1', status: 'withdrawn' }),
                record({ id: 't2', roundId: 'r2', status: 'delegated', origin: 'delegated', assigneeName: '审批乙', comment: '转交给审批乙', prevRecordId: 't0' }),
                record({ id: 't3', roundId: 'r2', origin: 'added', assigneeName: '审批丙', prevRecordId: 't2' }),
              ],
            }),
          }
        : new Response(null, { status: 404 });
    await renderAt('/approvals/a1?task=t2', both);

    const panel = await screen.findByTestId('approval-detail', {}, WAIT);
    await waitFor(() => expect(panel).not.toHaveAttribute('aria-busy'));
    const first = within(panel).getByTestId('approval-round-group-1');
    const second = within(panel).getByTestId('approval-round-group-2');
    expect(within(first).getAllByTestId('approval-record')).toHaveLength(1);
    expect(within(first).getByText('审批甲')).toBeInTheDocument();
    expect(within(second).getAllByTestId('approval-record')).toHaveLength(2);
    expect(
      await within(second).findByText(enUS.approvals.timeline.delegated, {}, WAIT),
    ).toBeInTheDocument();
    expect(within(second).getByText(enUS.approvals.timeline.added)).toBeInTheDocument();
    expect(within(second).getByText('审批乙')).toBeInTheDocument();
    expect(within(second).getByText('审批丙')).toBeInTheDocument();
  });

  it('转交弹窗只显示姓名，并发出正确的请求体', async () => {
    answer = (call) => {
      if (call.path === 'approvals/a1')
        return { data: detail({ available: ['approve', 'reject', 'return', 'delegate', 'add-sign'] }) };
      if (call.path === 'approvals/tasks/t1/candidates')
        return {
          data: [{ id: 'u2', name: '王五', username: 'wangwu' }],
          meta: { page: 1, pageSize: 20, total: 1 },
        };
      if (call.path === 'approvals/tasks/t1/delegate') return { data: {} };
      return new Response(null, { status: 404 });
    };
    await renderAt('/approvals/a1?task=t1', both);

    const panel = await screen.findByTestId('approval-detail', {}, WAIT);
    await userEvent.click(
      within(panel).getByRole('button', { name: enUS.approvals.actions.delegate }),
    );
    const dialog = await screen.findByRole('dialog', {}, WAIT);
    await userEvent.type(
      within(dialog).getByRole('searchbox', { name: enUS.approvals.candidates.search }),
      '王',
    );

    const search = await within(dialog).findByText('王五', {}, WAIT);
    expect(search).toBeInTheDocument();
    expect(within(dialog).queryByText('wangwu')).not.toBeInTheDocument();
    expect(callsTo('approvals/tasks/t1/candidates')).toContainEqual(
      expect.objectContaining({
        query: { type: 'delegate', q: '王', page: '1', pageSize: '20' },
      }),
    );

    await userEvent.click(search);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: enUS.approvals.actions.comment }),
      '交给你',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.approvals.actions.confirm }),
    );

    await waitFor(() =>
      expect(callsTo('approvals/tasks/t1/delegate')).toContainEqual(
        expect.objectContaining({
          method: 'POST',
          json: { toUserId: 'u2', comment: '交给你' },
        }),
      ),
    );
  });
});
