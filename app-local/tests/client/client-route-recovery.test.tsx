import type {
  AppClientRegisteredRoute,
  AppClientRouteComponentModule,
} from '@nocobase/app-client/plugins';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Activity, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ClientRoute } from '../../client/routing/client-route.tsx';
import {
  cachedClientRouteModule,
  primeClientRouteModule,
} from '../../client/routing/route-module-cache.ts';
import FeedbackDetailPage from '../../client/pages/feedbacks/detail.js';
import FeedbackNewPage from '../../client/pages/feedbacks/new.js';
import {
  loadFeedbackDetailModule,
  loadFeedbackNewModule,
} from '../../client/pages/feedbacks/preload.js';

import { renderWithApp } from '@nocobase/app-testing/client';
import { apiClientToken } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
} from '@nocobase/app-plugin-authorization/client';
import packageMetadata from '../../package.json' with { type: 'json' };
import enUS from '../../client/locales/en-US.js';

const options = {
  namespace: packageMetadata.name,
  namespaces: { [packageMetadata.name]: enUS },
  services(app: import('@nocobase/app-client').ClientApplication) {
    app.container.singleton(
      authorizationClientToken,
      (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
    );
  },
};

const route: AppClientRegisteredRoute = {
  id: 'recoverable',
  name: 'recoverable',
  path: '/recoverable',
  auth: 'required',
  authz: 'skip',
  packageName: 'test',
  source: 'application',
  componentLoader: async () => {
    throw new Error('Module unavailable');
  },
};

// Loading a lazy route and rendering its error boundary can take longer than Testing Library's one-second default on
// a loaded CI runner. A page that never renders still fails, well inside the 30-second test timeout.
const ROUTE_LOAD_TIMEOUT = { timeout: 10_000 };

const healthyModule: AppClientRouteComponentModule = {
  default: () => <h2>Recovered page</h2>,
};

describe('client route loading recovery', () => {
  it('keeps a loaded wrapped component when an ancestor Activity reconnects its effects', async () => {
    let loads = 0;
    const componentLoader = async () => {
      loads += 1;
      return {
        default: function Editor() {
          const [draft, setDraft] = useState('');
          return (
            <input
              aria-label='Draft'
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          );
        },
      };
    };
    const definition = { ...route, componentLoader };
    const view = (hidden: boolean) => (
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <ClientRoute route={definition} />
      </Activity>
    );
    const { rerender } = await renderWithApp(view(false), options);
    const input = await screen.findByRole(
      'textbox',
      { name: 'Draft' },
      ROUTE_LOAD_TIMEOUT,
    );
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    rerender(view(true));
    await waitFor(() => expect(input).not.toBeVisible());
    rerender(view(false));
    await waitFor(() => expect(input).toBeVisible());
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input);
    expect(input).toHaveValue('Keep this draft');
    expect(loads).toBe(1);
  });

  it('loads a replacement after a successful module and ignores a superseded successful response', async () => {
    const pending = Promise.withResolvers<AppClientRouteComponentModule>();
    const { rerender } = await renderWithApp(
      <ClientRoute
        route={{ ...route, componentLoader: async () => healthyModule }}
      />,
      options,
    );
    await screen.findByText('Recovered page', {}, ROUTE_LOAD_TIMEOUT);
    rerender(
      <ClientRoute
        route={{ ...route, componentLoader: () => pending.promise }}
      />,
    );
    const replacement = { default: () => <h2>Replacement page</h2> };
    rerender(
      <ClientRoute
        route={{ ...route, componentLoader: async () => replacement }}
      />,
    );
    await screen.findByText('Replacement page', {}, ROUTE_LOAD_TIMEOUT);
    await act(async () =>
      pending.resolve({ default: () => <h2>Stale page</h2> }),
    );
    expect(screen.getByText('Replacement page')).toBeVisible();
    expect(screen.queryByText('Stale page')).toBeNull();
  });

  it('invokes the same loader again on retry after a failed attempt', async () => {
    let loads = 0;
    const componentLoader = async () => {
      loads += 1;
      if (loads === 1) throw new Error('Temporary failure');
      return healthyModule;
    };
    await renderWithApp(
      <ClientRoute route={{ ...route, componentLoader }} />,
      options,
    );
    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Retry', exact: true },
        ROUTE_LOAD_TIMEOUT,
      ),
    );
    expect(
      await screen.findByText('Recovered page', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();
    expect(loads).toBe(2);
  });

  it('clears a previous failure when the same mounted route loads successfully', async () => {
    const { rerender } = await renderWithApp(
      <ClientRoute route={route} />,
      options,
    );
    expect(
      await screen.findByText('Unable to load page', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();

    rerender(
      <ClientRoute
        route={{ ...route, componentLoader: async () => healthyModule }}
      />,
    );

    expect(
      await screen.findByText('Recovered page', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();
    expect(screen.queryByText('Unable to load page')).not.toBeInTheDocument();
  });

  it('ignores a superseded loader failure after the replacement succeeds', async () => {
    let rejectLoad!: (error: Error) => void;
    const pending = new Promise<AppClientRouteComponentModule>(
      (_resolve, reject) => {
        rejectLoad = reject;
      },
    );
    const { rerender } = await renderWithApp(
      <ClientRoute route={{ ...route, componentLoader: () => pending }} />,
      options,
    );
    rerender(
      <ClientRoute
        route={{ ...route, componentLoader: async () => healthyModule }}
      />,
    );
    expect(
      await screen.findByText('Recovered page', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();

    await act(async () => {
      rejectLoad(new Error('Stale failure'));
      await pending.catch(() => undefined);
    });
    expect(screen.getByText('Recovered page')).toBeVisible();
    expect(screen.queryByText('Unable to load page')).not.toBeInTheDocument();
  });
});

/** 首帧是否出页面，取决于模块能否在 state 初值里拿到 —— 与 loader 何时 resolve 无关。 */
describe('client route first render from a ready module', () => {
  it('预填缓存的 loader 第一次渲染就是页面，没有占位文案', async () => {
    const loader = () =>
      new Promise<AppClientRouteComponentModule>(() => undefined);
    primeClientRouteModule(loader, {
      default: () => <h2>Primed page</h2>,
    });

    await renderWithApp(
      <ClientRoute route={{ ...route, componentLoader: loader }} />,
      options,
    );

    expect(screen.getByText('Primed page'), '首帧就是页面').toBeVisible();
    expect(
      screen.queryByText('Loading page'),
      '没有占位文案',
    ).not.toBeInTheDocument();
  });

  it('未预填的 loader 先占位，模块到达后才渲染页面', async () => {
    const pending = Promise.withResolvers<AppClientRouteComponentModule>();
    const loader = () => pending.promise;

    await renderWithApp(
      <ClientRoute route={{ ...route, componentLoader: loader }} />,
      options,
    );

    expect(screen.getByText('Loading page'), '模块未到时先占位').toBeVisible();
    expect(screen.queryByText('Later page')).not.toBeInTheDocument();

    await act(async () =>
      pending.resolve({ default: () => <h2>Later page</h2> }),
    );
    expect(
      await screen.findByText('Later page', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();
    expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
  });

  it('原路径加载成功后写缓存，再挂载时首帧就是页面且不重复调用 loader', async () => {
    let loads = 0;
    const page = { default: () => <h2>Cached after load</h2> };
    const loader = async () => {
      loads += 1;
      return page;
    };
    const definition = { ...route, componentLoader: loader };

    const first = await renderWithApp(<ClientRoute route={definition} />, options);
    expect(
      await screen.findByText('Cached after load', {}, ROUTE_LOAD_TIMEOUT),
    ).toBeVisible();
    first.unmount();

    await renderWithApp(<ClientRoute route={definition} />, options);
    expect(screen.getByText('Cached after load'), '第二挂载首帧就是页面').toBeVisible();
    expect(screen.queryByText('Loading page')).not.toBeInTheDocument();
    expect(loads, '缓存命中不再调用 loader').toBe(1);
  });

  it('反馈单两个 loader 在模块求值时就把真页面同步填进缓存', () => {
    expect(cachedClientRouteModule(loadFeedbackNewModule)?.default).toBe(
      FeedbackNewPage,
    );
    expect(cachedClientRouteModule(loadFeedbackDetailModule)?.default).toBe(
      FeedbackDetailPage,
    );
  });
});
