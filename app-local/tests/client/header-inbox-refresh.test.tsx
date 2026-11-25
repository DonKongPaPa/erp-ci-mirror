import { realtimeClientToken } from '@nocobase/app-client';
import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import packageMetadata from '../../package.json' with { type: 'json' };
import locales from '../../client/locales/index.js';
import { AppThemeProvider } from '../../client/theme/index.js';
import { HeaderActions } from '../../client/layouts/components/header-actions.js';

/**
 * R-013 顶栏的未读数要跟实时推送走。
 *
 * 头部只调 `useInboxUnreadCount()` 时，查询在进入时取一次（`staleTime` 30 秒、
 * 窗口聚焦不重取），推一条 `inbox.changed` 角标不动。头部接上 `useInboxRefresh()`
 * 之后，与收件箱页共用同一份订阅，事件到达时未读数与标签页标题一起刷新。
 */

const handlers: {
  readonly topic: string;
  readonly onEvent?: (event: unknown) => void;
}[] = [];

const unreadCountPath = 'notificationInApp/messages/unreadCount';

beforeEach(() => {
  handlers.length = 0;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }));
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

async function renderHeader(api: ReturnType<typeof vi.fn>) {
  return renderWithApp(
    <AuthenticationProvider>
      <AppThemeProvider>
        <HeaderActions />
      </AppThemeProvider>
    </AuthenticationProvider>,
    {
      route: '/quality',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: locales },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, {
          getSession: async () => ({
            data: { user: { id: 'user-1' }, session: { id: 'session-1' } },
          }),
        });
        // Keep the inbox hooks real while replacing the transport with a
        // subscription we can trigger by hand.
        const realtime = app.container.resolve(realtimeClientToken);
        vi.spyOn(realtime, 'watch').mockImplementation((topic, options) => {
          handlers.push({ topic, onEvent: options?.onEvent });
          // Acknowledging the topic immediately is what a live connection does:
          // it releases the readiness gate that enables the unread-count query.
          options?.onReady?.();
          return {
            state: 'subscribed',
            error: undefined,
            retry: vi.fn(),
            close: vi.fn(),
          };
        });
        vi.spyOn(realtime, 'subscribe').mockReturnValue(vi.fn());
        vi.spyOn(realtime, 'onOpen').mockReturnValue(vi.fn());
      },
    },
  );
}

it('refreshes the header badge and tab title when the inbox pushes a change', async () => {
  let count = 1;
  const api = vi.fn(({ path }: ApiCall) =>
    path === unreadCountPath
      ? { data: { count } }
      : new Response(null, { status: 404 }),
  );
  await renderHeader(api);

  expect(
    await screen.findByRole('link', { name: 'Inbox, 1 unread' }),
  ).toBeVisible();
  expect(document.title).toContain('(1)');

  count = 2;
  await act(async () => {
    for (const handler of handlers) {
      if (handler.topic !== 'notifications:in-app') continue;
      handler.onEvent?.({
        payload: { kind: 'inbox.changed', change: 'created' },
      });
    }
  });

  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Inbox, 2 unread' })).toBeVisible(),
  );
  expect(document.title).toContain('(2)');
});
