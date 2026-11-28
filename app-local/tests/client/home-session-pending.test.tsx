import { apiClientToken } from '@nocobase/app-client';
import { authenticationClientToken } from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import HomePage from '../../client/pages/home/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

const T = 15_000;
const WAIT = { timeout: T };
const unrestricted: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
const auth = vi.hoisted(() => ({ pending: true }));
vi.mock('@nocobase/app-plugin-authentication/client', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@nocobase/app-plugin-authentication/client')
    >();
  return {
    ...actual,
    useAuthentication: () => ({
      client: {},
      session: { user: { id: 'u-pending' }, session: { id: 's-pending' } },
      isPending: auth.pending,
      refresh: vi.fn(),
      preparation: auth.pending ? 'preparing' : 'ready',
      retryPreparation: vi.fn(),
    }),
  };
});

const calls: ApiCall[] = [];

async function renderHome() {
  calls.length = 0;
  return renderWithApp(<HomePage />, {
    namespace: packageMetadata.name,
    namespaces: { [packageMetadata.name]: enUS },
    fetch: answerApi((call) => {
      calls.push(call);
      if (call.path === 'authorization/permissions') return { data: unrestricted };
      if (call.path.startsWith('users/me/preferences')) return {};
      if (call.path.startsWith('approvals/')) return { items: [], total: 0 };
      if (call.path === 'home/delivery-reminders') return { items: [], total: 0 };
      return new Response(null, { status: 404 });
    }),
    services: (app) => {
      app.container.instance(authenticationClientToken, {});
      app.container.singleton(
        authorizationClientToken,
        (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
      );
    },
  });
}

const widgetCalls = () =>
  calls.filter(
    (call) =>
      call.path.startsWith('approvals/') ||
      call.path === 'home/delivery-reminders',
  );

describe('home workbench during identity change (R-085 加片)', () => {
  it('does not fetch widget data while the session and role are still pending', async () => {
    auth.pending = true;
    await renderHome();
    await waitFor(
      () => {
        expect(
          calls.some((call) => call.path === 'authorization/permissions'),
        ).toBe(true);
      },
      WAIT,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(widgetCalls()).toEqual([]);
    expect(screen.queryByText(enUS.dashboard.widgets.quickActions)).not.toBeInTheDocument();
  });

  it('renders the widgets once the session is ready', async () => {
    auth.pending = false;
    await renderHome();
    expect(
      await screen.findByText(enUS.dashboard.widgets.quickActions, {}, WAIT),
    ).toBeVisible();
  });
});
