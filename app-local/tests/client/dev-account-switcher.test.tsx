import {
  ClientApplicationContext,
  createAppClientConfig,
  type ClientApplication,
} from '@nocobase/app-client';
import { AppThemeProvider } from '../../client/theme/index.js';
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import devAccountSwitcher from '../../client/extensions/dev-account-switcher/plugin.js';
import { UserMenu } from '../../client/layouts/components/user-menu.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-037 开发环境专用的多用户快捷切换，头像菜单部分。
 *
 * 验收标准第 2 条的前半（关着时菜单里没有这一段）与第 1 条里「列出四个演示账户与各自的角色」。
 * 测试应用按开发环境启动并打开开关，演示账户由服务端在启动时建出来；客户端配置用一个只覆盖
 * `config.public` 的包装传进去 —— `renderWithApp()` 不读页面里的公开配置，它总是给空对象。
 */

const SWITCH_ON = { devTools: { accountSwitcher: { enabled: true } } };
const SWITCH_OFF = { devTools: { accountSwitcher: { enabled: false } } };

/**
 * 只替换 `config.public`，其余仍走真实的客户端应用：会话、服务与 API 客户端都保持原样。
 * 公开配置是服务端发布给浏览器的那一份，测试里用这个包装扮演服务端已经发布过它。
 */
function PublicConfigOverride({
  values,
  children,
}: PropsWithChildren<{
  readonly values: Record<string, unknown>;
}>): ReactElement {
  const app = useContext(ClientApplicationContext);
  const overridden = useMemo(() => {
    if (!app) throw new Error('The application context is missing.');
    const config = createAppClientConfig({
      rawConfig: app.config.raw(),
      rawPublicConfig: { ...app.config.public.raw(), ...values },
    });
    return new Proxy(app, {
      get(target, property) {
        if (property === 'config') return config;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) satisfies ClientApplication;
  }, [app, values]);
  return (
    <ClientApplicationContext.Provider value={overridden}>
      {children}
    </ClientApplicationContext.Provider>
  );
}

// jsdom has no media queries; the real account menu includes the theme provider.
// 整页刷新在 jsdom 里没有实现（会打一条 “Not implemented: navigation”），测试里手动刷新会话代替它。
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
});

async function openAccountMenu(): Promise<void> {
  act(() => screen.getByRole('button', { name: 'Open account menu' }).focus());
  await userEvent.keyboard('{Enter}');
}

const ROLE_ENTRIES = [
  ['演示 · 质量主管', 'Quality manager'],
  ['演示 · 质量员', 'Quality inspector'],
  ['演示 · 部门主管', 'Department manager'],
  ['演示 · 普通员工', 'Staff'],
] as const;

describe('account switcher in the avatar menu', () => {
  it('contributes nothing outside a development build', () => {
    const registration = devAccountSwitcher({ enabled: false });
    expect(registration.serviceProviders).toEqual([]);
    expect(registration.reactProviders).toEqual([]);
    expect(registration.routes).toEqual([]);
  });

  it('renders nothing when the server switch is off', async () => {
    await renderAuthenticatedClient(
      <PublicConfigOverride values={SWITCH_OFF}>
        <AppThemeProvider>
          <UserMenu />
        </AppThemeProvider>
      </PublicConfigOverride>,
      { plugins: [devAccountSwitcher({ enabled: true })] },
    );
    await openAccountMenu();
    expect(
      await screen.findByRole('menuitem', { name: 'Sign out' }),
    ).toBeVisible();
    expect(screen.queryByText('Switch account')).toBeNull();
    expect(screen.queryByText('Development only')).toBeNull();
  });

  it('lists the demo accounts with their roles and marks the current one after a switch', async () => {
    const switched: Response[] = [];
    const view = await renderAuthenticatedClient(
      <PublicConfigOverride values={SWITCH_ON}>
        <AppThemeProvider>
          <UserMenu />
        </AppThemeProvider>
      </PublicConfigOverride>,
      {
        plugins: [devAccountSwitcher({ enabled: true })],
        env: { NODE_ENV: 'development' },
        config: { devTools: { accountSwitcher: { enabled: true } } },
        afterResponse(request, response) {
          if (request.url.endsWith('/dev-tools/switch-account')) {
            switched.push(response);
          }
        },
      },
    );
    const listed = (await (
      await view.session.fetch('/dev-tools/accounts')
    ).json()) as {
      data: readonly { id: string; name: string; username: string }[];
    };
    const staff = listed.data.find(
      (account) => account.username === 'demo.staff',
    );
    expect(staff).toBeDefined();

    await openAccountMenu();
    expect(await screen.findByText('Switch account')).toBeVisible();
    expect(screen.getByText('Development only')).toBeVisible();
    for (const [name, role] of ROLE_ENTRIES) {
      const item = await screen.findByRole('menuitem', {
        name: new RegExp(name, 'u'),
      });
      expect(item).toHaveTextContent(role);
      // 登录的是管理员，四个演示账户都不是当前账户。
      expect(within(item).queryByLabelText('Current account')).toBeNull();
    }

    fireEvent.click(screen.getByRole('menuitem', { name: /演示 · 普通员工/u }));
    await waitFor(() => expect(switched).toHaveLength(1));
    expect(switched[0]!.status).toBe(200);

    // 真机上这里会整页刷新；测试里手动刷新会话，效果相同：重新取身份与权限。
    await act(async () => {
      await view.identity().refresh();
    });
    expect(view.identity().session?.user.id).toBe(staff!.id);

    await openAccountMenu();
    const current = await screen.findByRole('menuitem', {
      name: /演示 · 普通员工/u,
    });
    expect(within(current).getByLabelText('Current account')).toBeVisible();
    for (const [name] of ROLE_ENTRIES.slice(0, 3)) {
      const other = await screen.findByRole('menuitem', {
        name: new RegExp(name, 'u'),
      });
      expect(within(other).queryByLabelText('Current account')).toBeNull();
    }
  });
});
