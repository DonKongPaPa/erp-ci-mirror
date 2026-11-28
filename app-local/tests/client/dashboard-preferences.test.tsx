import { apiClientToken } from '@nocobase/app-client';
import { authenticationClientToken } from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import HomePage from '../../client/pages/home/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const T = 15_000;
const WAIT = { timeout: T };
const unrestricted: AuthorizationSnapshot = { unrestricted: true, permissions: [] };

const session = vi.hoisted(() => ({ userId: 'u-dashboard' }));
vi.mock('@nocobase/app-plugin-authentication/client', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@nocobase/app-plugin-authentication/client')
    >();
  return {
    ...actual,
    useAuthentication: () => ({
      client: {},
      session: {
        user: { id: session.userId },
        session: { id: 's-dashboard' },
      },
      isPending: false,
      refresh: vi.fn(),
      preparation: 'ready',
      retryPreparation: vi.fn(),
    }),
  };
});

let stored: unknown;
const calls: ApiCall[] = [];

async function renderHome() {
  calls.length = 0;
  return renderWithApp(<HomePage />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi((call) => {
      calls.push(call);
      if (call.path === 'authorization/permissions')
        return { data: unrestricted };
      if (call.path.startsWith('users/me/preferences')) {
        if (call.method === 'PUT' && call.json && typeof call.json === 'object') {
          stored = (call.json as { value: unknown }).value;
        }
        return {};
      }
      if (call.path.startsWith('approvals/')) return { items: [], total: 0 };
      return new Response(null, { status: 404 });
    }),
    services: (app) => {
      // 首页用这个 token 判断是否有按账户偏好服务；本测试替掉 useAuthentication，不需要真的认证插件。
      app.container.instance(authenticationClientToken, {});
      app.container.singleton(
        authorizationClientToken,
        (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
      );
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  stored = undefined;
  calls.length = 0;
});

describe('account preference storage (R-086)', () => {
  it('saves an adjustment through the framework preference endpoint', async () => {
    const user = userEvent.setup();
    await renderHome();
    await user.click(
      await screen.findByRole('button', { name: enUS.dashboard.adjust }, WAIT),
    );
    const panel = await screen.findByRole(
      'dialog',
      { name: enUS.dashboard.adjustTitle },
      WAIT,
    );
    await user.click(
      screen.getByRole('checkbox', { name: enUS.dashboard.widgets.myTasks }),
    );
    await waitFor(
      () => {
        const write = calls.find(
          (call) => call.path.startsWith('users/me/preferences/') && call.method === 'PUT',
        );
        expect(write).toBeDefined();
        expect(write?.json).toMatchObject({
          value: { widgets: expect.any(Array) },
        });
      },
      WAIT,
    );
    expect(panel).toBeVisible();
  });

  it('restores the role default by clearing the stored override', async () => {
    const user = userEvent.setup();
    await renderHome();
    await user.click(
      await screen.findByRole('button', { name: enUS.dashboard.adjust }, WAIT),
    );
    await screen.findByRole('dialog', { name: enUS.dashboard.adjustTitle }, WAIT);
    await user.click(screen.getByRole('button', { name: enUS.dashboard.reset }));
    await waitFor(
      () => {
        expect(stored).toEqual({ widgets: null });
      },
      WAIT,
    );
  });
});
