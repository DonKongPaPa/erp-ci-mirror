import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import notificationInApp from '@nocobase/app-plugin-notification-in-app/client';
import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication/server';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import { AppLayout } from '../../client/layouts/app-layout.tsx';
import {
  createAppSidebarPreferenceStore,
  SidebarPreferenceProvider,
} from '../../client/layouts/use-sidebar-preference.ts';
import { renderRouteTree } from '../../client/routing/route-tree.tsx';
import { createApplicationRoutes } from '../../client/routes.ts';
import packageMetadata from '../../package.json' with { type: 'json' };
import { createAuthenticatedClientRenderer } from '../helpers/authenticated-client.js';

/**
 * R-032 补充设计的验收第 5 条：服务账号旁能看到它的角色，调整角色的对话框里没有
 * root 的权限集 —— 在真实的应用外壳里、经由真实的注册路由渲染。
 *
 * 走的是真应用（进程内服务端、真实会话、真实授权）：角色清单由服务端给
 * （`/application-api-keys/accounts/:userId/roles`），页面不自己拼，所以这条测试
 * 同时钉住了「可选项的清单由服务端给」和「root 不给出去」。
 */

const routes = resolveAppClientContributions([
  {
    packageName: packageMetadata.name,
    routes: createApplicationRoutes({}),
    source: 'application',
  },
]).routes;

const render = createAuthenticatedClientRenderer();

/** 与 `useSubmission` 生成的幂等键同形：毫秒时间戳 + UUID v4。 */
const OPERATION_KEY =
  /^\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

beforeEach(() =>
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
afterEach(() => vi.unstubAllGlobals());

it('shows a service account’s roles beside it and never offers root to give', async () => {
  const user = userEvent.setup();
  const requests: { method: string; path: string; headers: Headers }[] = [];
  let accountId = '';
  const accountName = 'R032 shell roles';

  const view = await render(
    <SidebarPreferenceProvider value={createAppSidebarPreferenceStore('/main')}>
      <Routes>
        <Route element={<AppLayout routes={routes} />}>
          {renderRouteTree(routes)}
        </Route>
      </Routes>
    </SidebarPreferenceProvider>,
    {
      route: '/settings/api-keys',
      locale: 'en-US',
      plugins: [notificationInApp()],
      beforeRequest: (request) => {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          headers: new Headers(request.headers),
        });
      },
      prepare: async (server) => {
        const users = server.application.container.resolve(
          userAdministrationServiceToken,
        );
        const authz = server.application.container.resolve(authorizationToken);
        const account = await users.createServiceAccount({ name: accountName });
        accountId = account.id;
        // 角色是「已经给过的」：页面要把它显示在服务账号旁边。
        await authz.permissionSets.assign({
          subject: { type: 'user', id: account.id },
          permissionSet: 'quality_manager',
        });
      },
    },
  );

  // 服务账号旁的角色：等它从角色接口回来，不在标题出来之后同步地取。
  expect(
    await screen.findByText(accountName, {}, { timeout: 10_000 }),
  ).toBeVisible();
  expect(
    await screen.findByText('Quality manager', {}, { timeout: 10_000 }),
    '服务账号旁边看不到它持有的角色',
  ).toBeVisible();
  expect(screen.queryByText('System administrator')).toBeNull();
  expect(
    screen.queryByText(/Unable to load page/),
    '页面被外壳的失败页顶掉了',
  ).toBeNull();

  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.adjustRoles }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: enUS.apiKeys.application.rolesTitle.replace('{{name}}', accountName),
  });
  expect(
    within(dialog).getByRole('checkbox', { name: 'Quality manager' }),
    '已经持有的角色在对话框里应当是勾上的',
  ).toBeChecked();
  expect(
    within(dialog).queryByRole('checkbox', { name: 'System administrator' }),
    'root 的权限集不该出现在可选项里',
  ).toBeNull();
  expect(
    within(dialog).queryByText('root', { exact: true }),
    'root 的标识也不该出现在对话框里',
  ).toBeNull();

  // 换掉角色：撤掉质量主管、给普通员工，保存后按服务端的结果更新。
  await user.click(
    within(dialog).getByRole('checkbox', { name: 'Quality manager' }),
  );
  await user.click(within(dialog).getByRole('checkbox', { name: 'Staff' }));
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.save }),
  );

  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
  expect(
    await screen.findByText('Staff', {}, { timeout: 10_000 }),
    '保存后的角色没有显示出来',
  ).toBeVisible();
  expect(screen.queryByText('Quality manager')).toBeNull();

  const write = requests.find(
    (request) =>
      request.method === 'PUT' &&
      request.path.endsWith(
        `/application-api-keys/accounts/${accountId}/roles`,
      ),
  );
  expect(write, '保存应当整体替换服务账号的角色').toBeDefined();
  expect(
    write?.headers.get('idempotency-key'),
    '写操作都带 Idempotency-Key',
  ).toMatch(OPERATION_KEY);

  const response = await view.session.fetch(
    `/application-api-keys/accounts/${accountId}/roles`,
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    data: { roles: { key: string }[] };
  };
  expect(payload.data.roles.map((role) => role.key)).toEqual(['staff']);
});
