import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
import {
  AuthorizationClient,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { describe, expect, it } from 'vitest';

import applicationRoutes from '../../client/routes.js';
import {
  buildRouteNavigation,
  buildSettingsCatalog,
  routeKey,
} from '../../client/routing/route-navigation.js';

/**
 * R-042 第 4 条：没有 AI 授权的用户看不到主导航里的 AI 分组，也进不了 `/models` 与 `/agents`。
 *
 * 导航是客户端拿 `/authorization/permissions` 的快照按每条路由的 `authz` 过滤出来的，所以这里用
 * 真实的 `AuthorizationClient` 复现同一套判定，而不是自己写一份「AI 路由都拒掉」的集合。
 * 服务端那一半（真实用户、真实快照、真实接口）在 `tests/server/ai-pages.test.ts`。
 */

const resolved = resolveAppClientContributions([
  {
    packageName: '@nocobase/app-template-default',
    routes: applicationRoutes,
    source: 'application',
  },
]).routes;

/** 与 `useRouteNavigation` 相同的判定：逐条路由问快照能不能开，不能开的记进 denied。 */
async function deniedFor(
  snapshot: AuthorizationSnapshot,
): Promise<ReadonlySet<string>> {
  const client = new AuthorizationClient({
    request: async () => ({ data: snapshot }),
  } as unknown as ConstructorParameters<typeof AuthorizationClient>[0]);
  const denied = new Set<string>();
  const visit = async (
    routes: readonly (typeof resolved)[number][],
  ): Promise<void> => {
    for (const route of routes) {
      if (route.componentLoader && route.authz !== 'skip') {
        try {
          if (!(await client.can(route.authz))) denied.add(routeKey(route));
        } catch {
          denied.add(routeKey(route));
        }
      }
      await visit(route.children ?? []);
    }
  };
  await visit(resolved);
  return denied;
}

function routeNamed(name: string) {
  const find = (
    routes: readonly (typeof resolved)[number][],
  ): (typeof resolved)[number] | undefined => {
    for (const route of routes) {
      if (route.name === name) return route;
      const nested = find(route.children ?? []);
      if (nested) return nested;
    }
    return undefined;
  };
  return find(resolved);
}

const memberSnapshot: AuthorizationSnapshot = {
  unrestricted: false,
  // 一个只拿得到质量页的业务用户：没有任何 AI 页面或 agents.* 设置项的授权。
  permissions: [
    { resource: { type: 'page', id: 'quality' }, actions: ['access'] },
  ],
};

describe('R-042: AI navigation follows authorization', () => {
  it('hides the AI group from a signed-in user without AI grants', async () => {
    const denied = await deniedFor(memberSnapshot);
    const menu = buildRouteNavigation(resolved, denied);

    // R-017 M5：审批入口对所有登录用户可见，和业务用户能不能开 AI 无关。
    expect(menu.map(({ route }) => route.name)).toEqual([
      'home',
      'businessQuality',
      'approvals',
    ]);
    expect(menu.some(({ route }) => route.name === 'ai')).toBe(false);

    for (const name of ['models', 'agents']) {
      const route = routeNamed(name);
      expect(route, `路由 ${name} 不在注册树里`).toBeDefined();
      const authz = route!.authz;
      if (authz === 'skip' || authz === 'unrestricted')
        throw new Error(`${name} 的授权声明不对`);
      const client = new AuthorizationClient({
        request: async () => ({ data: memberSnapshot }),
      } as unknown as ConstructorParameters<typeof AuthorizationClient>[0]);
      // 直接打开 `/models` 或 `/agents` 时，路由守卫问的就是这一条。
      await expect(client.can(authz), `${name} 不应当能开`).resolves.toBe(
        false,
      );
    }
  });

  it('puts root the five AI pages in System settings, not in the sidebar', async () => {
    const denied = await deniedFor({ unrestricted: true, permissions: [] });
    expect(denied.size).toBe(0);
    const menu = buildRouteNavigation(resolved, denied);
    expect(menu.some(({ route }) => route.name === 'ai')).toBe(false);

    const ai = buildSettingsCatalog(resolved, denied).find(
      (category) => category.route.name === 'settingsAi',
    );
    expect(ai?.modules.map(({ route }) => route.name)).toEqual([
      'models',
      'agents',
      'runtimes',
      'skills',
      'usage',
    ]);
  });
});
