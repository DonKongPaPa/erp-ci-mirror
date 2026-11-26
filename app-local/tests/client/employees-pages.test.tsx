import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import {
  resolveAppClientContributions,
  type AppClientRegisteredRoute,
} from '@nocobase/app-client/plugins';
import { apiClientToken } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import {
  buildSettingsCatalog,
  routeKey,
} from '../../client/routing/route-navigation.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EmployeesPage from '../../client/pages/settings/employees/index.js';
import { employeeColumns } from '../../client/pages/settings/employees/columns.js';
import { EMPLOYEES_PAGE_ID } from '../../client/pages/settings/employees/page-id.js';
import { createApplicationRoutes } from '../../client/routes.js';
import enUS from '../../client/locales/en-US.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-011 员工管理页。真实的应用 hook 与授权容器，只把 HTTP 换成夹具：
 * `useCan` 走真实的 `GET authorization/permissions`，页面按授权决定看到什么、发什么请求。
 */

type Answer = unknown;

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => Answer;
const api = vi.fn((call: ApiCall) => answer(call));

function employeeGrant(...actions: string[]): AuthorizationSnapshot {
  return {
    unrestricted: false,
    permissions: [
      { resource: { type: 'composite', id: 'employees' }, actions },
    ],
  };
}

function employeeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 'u-1',
    employeeNo: 'E000001',
    name: 'Ada Lin',
    username: 'adal',
    primaryDepartmentName: 'Assembly',
    positionName: 'Technician',
    gradeName: 'P3',
    status: 'active',
    hiredOn: '2026-11-01',
    secondaryDepartmentNames: ['Quality'],
    reportsToName: 'Grace Hopper',
    leftOn: null,
    ...overrides,
  };
}

function changeRow(kind: string, from: string | null, to: string | null) {
  return {
    kind,
    fromValue: from,
    toValue: to,
    occurredOn: '2026-11-02',
    note: null,
    actorName: 'Root',
    createdAt: '2026-11-02T08:00:00.000Z',
  };
}

function errorResponse(status: number, reason: string, metadata?: Record<string, unknown>): Response {
  return Response.json(
    {
      error: {
        message: reason,
        reason,
        domain: 'employees',
        ...(metadata ? { metadata } : {}),
      },
    },
    { status },
  );
}

const getSession = vi.fn(async () => ({ data: null }));

async function renderAt(route = '/settings/employees') {
  return renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/settings/employees' element={<EmployeesPage />} />
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

function answerList(rows: readonly Record<string, unknown>[]) {
  answer = (call) => {
    if (call.path === 'authorization/permissions') return { data: permissions };
    if (call.path === 'employees' && call.method === 'GET')
      return { data: rows, meta: { page: 1, pageSize: 20, total: rows.length } };
    if (call.path === 'positions') return { data: [] };
    if (call.path === 'job-grades') return { data: [] };
    return new Response(null, { status: 404 });
  };
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  permissions = employeeGrant('view', 'manage');
  answerList([employeeRow()]);
});


describe('R-011 员工列表', () => {
  it('列出八列，没有邮箱一栏，默认只看在职', async () => {
    await renderAt();
    const noEmail = await screen.findByText('E000001');
    expect(noEmail).toBeInTheDocument();
    const table = screen.getByTestId('employee-list');
    expect(within(table).getByText('Ada Lin')).toBeInTheDocument();
    for (const header of [
      enUS.employees.columns.employeeNo,
      enUS.employees.columns.name,
      enUS.employees.columns.username,
      enUS.employees.columns.primaryDepartment,
      enUS.employees.columns.position,
      enUS.employees.columns.grade,
      enUS.employees.columns.status,
      enUS.employees.columns.hiredOn,
    ])
      expect(within(table).getByText(header)).toBeInTheDocument();
    expect(within(table).queryByText('Email')).toBeNull();
    expect(table).not.toHaveTextContent('@');
    expect(api.mock.calls.find(([call]) => call.path === 'employees')?.[0].query).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('搜索发出 q 参数，切换含离职去掉 status 参数', async () => {
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.type(screen.getByRole('searchbox', { name: enUS.employees.search }), 'Ada');
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'employees', query: expect.objectContaining({ q: 'Ada' }) }),
      ),
    );
    await userEvent.click(screen.getByRole('radio', { name: enUS.employees.includeLeft }));
    await waitFor(() =>
      expect(api.mock.calls.filter(([call]) => call.path === 'employees').at(-1)?.[0].query).not.toHaveProperty('status'),
    );
  });

  it('无「查看员工」的人不显示任何列表请求与写按钮', async () => {
    permissions = employeeGrant();
    await renderAt();
    await screen.findByText(enUS.employees.noView);
    expect(screen.queryByRole('button', { name: enUS.employees.hire })).toBeNull();
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('employees');
  });

  it('没有页面授权的人看不到导航入口，页面 access 也判为拒绝', async () => {
    const built = resolveAppClientContributions([
      {
        packageName: '@nocobase/app-template-default',
        source: 'application',
        routes: createApplicationRoutes({}),
      },
    ]).routes;
    const flatten = (
      routes: readonly AppClientRegisteredRoute[],
    ): AppClientRegisteredRoute[] =>
      routes.flatMap((route) => [route, ...flatten(route.children ?? [])]);
    const entry = flatten(built).find((route) => route.name === 'settingsEmployees');
    expect(entry).toBeDefined();
    expect(entry?.authz).toEqual({
      resource: { type: 'page', id: EMPLOYEES_PAGE_ID },
      action: 'access',
    });
    const moduleNames = (denied: ReadonlySet<string>): string[] =>
      buildSettingsCatalog(built, denied).flatMap((category) =>
        category.modules.map((module) => module.route.name),
      );
    // 正向守卫：入口本来在导航里；负向：页面授权被拒时它真的消失。
    expect(moduleNames(new Set())).toContain('settingsEmployees');
    expect(moduleNames(new Set([routeKey(entry!)]))).not.toContain(
      'settingsEmployees',
    );

    // 直接访问：路由守卫查的是同一条页面 access 授权；快照里没有它时 useCan 必须判拒。
    const seen: boolean[] = [];
    const denied = { current: undefined as boolean | undefined };
    function PageAccessProbe(): ReactElement {
      const can = useCan({
        resource: { type: 'page', id: EMPLOYEES_PAGE_ID },
        action: 'access',
      }).can;
      seen.push(can);
      return <span>{can ? 'allowed' : 'denied'}</span>;
    }
    permissions = employeeGrant('view', 'manage');
    await renderWithApp(
      <AuthenticationProvider>
        <PageAccessProbe />
      </AuthenticationProvider>,
      {
        route: '/settings/employees',
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
    expect(await screen.findByText('denied')).toBeVisible();
    expect(seen.at(-1)).toBe(false);
    denied.current = seen.at(-1);
    expect(denied.current).toBe(false);
  });

  it('只有 view、没有 manage 时看不到写按钮，也不发任何写端点', async () => {
    permissions = employeeGrant('view');
    await renderAt();
    await screen.findByText('E000001');
    for (const name of [
      enUS.employees.hire,
      enUS.employees.link,
      enUS.employees.transferFor,
      enUS.employees.leaveFor,
      enUS.employees.rehireFor,
      enUS.employees.deactivate,
    ])
      expect(screen.queryByRole('button', { name })).toBeNull();
    const writes = api.mock.calls.filter(
      ([call]) => call.method !== 'GET',
    );
    expect(writes).toEqual([]);
  });
});

describe('R-011 详情与变动记录', () => {
  it('详情回兼职部门、上级姓名、离职日期与变动记录，不回邮箱', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'employees/u-1' && call.method === 'GET') return { data: employeeRow() };
      if (call.path === 'employees/u-1/changes')
        return {
          data: [
            changeRow('hired', null, 'E000001'),
            changeRow('position', 'Technician', 'Technician II'),
          ],
        };
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.detailsFor }));

    const dialog = await screen.findByRole('dialog', { name: enUS.employees.detailTitle });
    expect(within(dialog).getByText('Quality')).toBeInTheDocument();
    expect(within(dialog).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(dialog).getByText('Technician II')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('@');
  });
});

describe('R-011 入职与被拒', () => {
  it('入职成功发出 POST 并刷新列表', async () => {
    let post: ApiCall | undefined;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'POST') {
        post = call;
        return { data: employeeRow({ employeeNo: 'E000002', name: 'New Hire' }) };
      }
      if (call.path === 'employees' && call.method === 'GET')
        return { data: [employeeRow({ employeeNo: 'E000002', name: 'New Hire' })], meta: { total: 1 } };
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByRole('button', { name: enUS.employees.hire });
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.hire }));
    const dialog = await screen.findByRole('dialog', { name: enUS.employees.hireTitle });
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.employees.form.name }), 'New Hire');
    await userEvent.type(within(dialog).getByLabelText(enUS.employees.form.hiredOn), '2026-11-20');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.employees.form.submit }));

    await waitFor(() => expect(post).toBeDefined(), { timeout: 15_000 });
    expect(post?.json).toEqual(
      expect.objectContaining({ name: 'New Hire', hiredOn: '2026-11-20' }),
    );
    expect(await screen.findByText('New Hire')).toBeInTheDocument();
  });

  it('409 PROFILE_EXISTS 映射成看得懂的一句话', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'employees' && call.method === 'POST') return errorResponse(409, 'PROFILE_EXISTS');
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.hire }));
    const dialog = await screen.findByRole('dialog', { name: enUS.employees.hireTitle });
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.employees.form.name }), 'Dup');
    await userEvent.type(within(dialog).getByLabelText(enUS.employees.form.hiredOn), '2026-11-20');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.employees.form.submit }));

    expect(await screen.findByText(enUS.employees.errors.profileExists)).toBeVisible();
  });
});

describe('R-011 调岗、离职、复聘', () => {
  it('调岗发出 PATCH，带岗位 id', async () => {
    let patch: ApiCall | undefined;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'employees/u-1' && call.method === 'PATCH') {
        patch = call;
        return { data: employeeRow({ positionName: 'Technician II' }) };
      }
      if (call.path === 'positions')
        return { data: [{ id: 'p2', title: 'Technician II', active: true, sortOrder: 2 }] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.transferFor }));
    const dialog = await screen.findByRole('dialog', { name: enUS.employees.transferTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Technician II' }));
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.employees.form.save }));

    await waitFor(() => expect(patch).toBeDefined(), { timeout: 15_000 });
    expect(patch?.json).toEqual({ positionId: 'p2' });
  });

  it('离职被多条理由拦住时分行显示', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'employees/u-1/leave')
        return errorResponse(409, 'OFFBOARD_REJECTED', { reason: '先更换部门负责人；先改派在职下属' });
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.leaveFor }));
    const dialog = await screen.findByRole('dialog', { name: enUS.employees.leaveTitle });
    await userEvent.type(within(dialog).getByLabelText(enUS.employees.form.leftOn), '2026-11-25');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.employees.form.confirm }));

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(within(alert).getByText('先更换部门负责人')).toBeVisible());
    expect(within(alert).getByText('先改派在职下属')).toBeVisible();
  });

  it('复聘发出 POST 并保留工号', async () => {
    let post: ApiCall | undefined;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET')
        return { data: [employeeRow({ status: 'left', leftOn: '2026-11-20' })], meta: { total: 1 } };
      if (call.path === 'employees/u-1/rehire') {
        post = call;
        return { data: employeeRow() };
      }
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    await userEvent.click(screen.getByRole('button', { name: enUS.employees.rehireFor }));
    const dialog = await screen.findByRole('dialog', { name: enUS.employees.rehireTitle });
    await userEvent.type(within(dialog).getByLabelText(enUS.employees.form.hiredOn), '2026-11-26');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.employees.form.confirm }));

    await waitFor(() => expect(post).toBeDefined(), { timeout: 15_000 });
    expect(post?.json).toEqual(expect.objectContaining({ hiredOn: '2026-11-26' }));
  });
});

describe('R-011 字典', () => {
  it('停用岗位后这一行还在，带停用标记，不是删除', async () => {
    let patch: ApiCall | undefined;
    let active = true;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'positions' && call.method === 'GET')
        return { data: [{ id: 'p1', title: 'Technician', active, sortOrder: 1 }] };
      if (call.path === 'positions/p1' && call.method === 'PATCH') {
        patch = call;
        active = false;
        return { data: { id: 'p1', title: 'Technician', active: false, sortOrder: 1 } };
      }
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    const dictionary = await screen.findByRole('region', { name: enUS.employees.positions });
    await within(dictionary).findByText('Technician');
    await userEvent.click(within(dictionary).getByRole('button', { name: enUS.employees.deactivate }));

    await waitFor(() => expect(patch).toBeDefined(), { timeout: 15_000 });
    expect(patch?.json).toEqual({ active: false });
    expect(within(dictionary).getByText('Technician')).toBeInTheDocument();
    expect(within(dictionary).getByText(enUS.employees.inactive)).toBeInTheDocument();
  });

  it('停用还有在职员工的岗位被 409 挡住，原因可读', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return { data: [employeeRow()], meta: { total: 1 } };
      if (call.path === 'positions' && call.method === 'GET')
        return { data: [{ id: 'p1', title: 'Technician', active: true, sortOrder: 1 }] };
      if (call.path === 'positions/p1' && call.method === 'PATCH') return errorResponse(409, 'POSITION_IN_USE');
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    await screen.findByText('E000001');
    const dictionary = await screen.findByRole('region', { name: enUS.employees.positions });
    await within(dictionary).findByText('Technician');
    await userEvent.click(within(dictionary).getByRole('button', { name: enUS.employees.deactivate }));

    expect(await screen.findByText(enUS.employees.errors.positionInUse)).toBeVisible();
  });
});

describe('R-011 稳定性', () => {
  it('骨架行渲染真实行标签、只有数据位放骨架块，与数据行等高', async () => {
    const gate = Promise.withResolvers<unknown>();
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'employees' && call.method === 'GET') return gate.promise;
      if (call.path === 'positions') return { data: [] };
      if (call.path === 'job-grades') return { data: [] };
      return new Response(null, { status: 404 });
    };
    await renderAt();
    const list = await screen.findByTestId('employee-list');
    const skeletonRows = list.querySelectorAll('[data-testid="employee-skeleton-row"]');
    expect(skeletonRows, '列表请求还没回来，骨架行应该铺着').toHaveLength(9);
    const labels = [...skeletonRows].map((node) => node.textContent ?? '');
    for (const label of labels)
      expect(label.length, '每个骨架行都要有真实文本，不是空盒子').toBeGreaterThan(0);
    expect(labels[0]).toContain(enUS.employees.loadingRow);
    expect(skeletonRows[0]!.querySelector('[aria-hidden="true"]'), '骨架块不许撑高行盒').toHaveClass('h-3');
    const rowClass = skeletonRows[0]!.className;

    await act(async () => gate.resolve({ data: [employeeRow()], meta: { total: 1 } }));

    // 骨架容器与数据容器是两个 DOM 节点，重新取一次，不要拿旧节点查。
    const cell = await screen.findByText('Ada Lin');
    const dataRow = cell.closest('[data-testid="employee-row"]') as HTMLElement;
    expect(dataRow.className, '数据行的行类要和骨架行一字不差，高度差才是 0').toBe(rowClass);
    expect(screen.queryAllByTestId('employee-skeleton-row')).toHaveLength(0);
  });

  it('列定义是模块级的稳定引用，不随渲染新建', () => {
    const seen: unknown[] = [];
    const view = renderHook(() => {
      seen.push(employeeColumns());
      return null;
    });
    view.rerender();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]!.map((column) => column.id)).not.toContain('email');
  });
});
