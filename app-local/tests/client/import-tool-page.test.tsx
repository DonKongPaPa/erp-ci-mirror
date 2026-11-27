import { apiClientToken } from '@nocobase/app-client';
import { resolveAppClientContributions } from '@nocobase/app-client/plugins';
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
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import zhCN from '../../client/locales/zh-CN.js';
import { createApplicationRoutes } from '../../client/routes.js';
import ImportsPage from '../../client/pages/settings/imports/index.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/** R-068 验收5：五个页签、样例下载、上传、试运行报告、确认导入计数。页面文案来自应用语言包。 */
const T = 15_000;
const WAIT = { timeout: T };
const root: AuthorizationSnapshot = { unrestricted: true, permissions: [] };

const report = (overrides: Record<string, unknown> = {}) => ({
  kind: 'items',
  rowCount: 2,
  wouldCreate: 1,
  wouldSkip: 0,
  wouldUpdate: 0,
  errorCount: 1,
  issues: [{ row: 3, code: 'IMPORT_UNIT_NOT_FOUND', message: 'Unit not found' }],
  ...overrides,
});

let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions' ? { data: root } : answer(call),
);
/** 多部分上传在 jsdom 里读 body 会炸；这里只按 method/path 记录，JSON 请求才读正文。 */
const fetchStub = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const index = url.pathname.indexOf('/api/');
  const path = index === -1
    ? url.pathname.replace(/^\/+/u, '')
    : url.pathname.slice(index + '/api/'.length);
  const contentType = request.headers.get('content-type') ?? '';
  let json: unknown;
  if (contentType.includes('json')) {
    const text = await request.text();
    json = text === '' ? undefined : JSON.parse(text);
  }
  const call: ApiCall = {
    method: request.method,
    path,
    ...(json === undefined ? {} : { json }),
  };
  api(call);
  const result = await answer(call);
  return result instanceof Response ? result : Response.json(result ?? null);
};
const getSession = vi.fn(async () => ({ data: null }));
const notFound = () => new Response(null, { status: 404 });

async function renderPage() {
  return renderWithApp(
    <AuthenticationProvider>
      <ImportsPage />
    </AuthenticationProvider>,
    {
      route: '/settings/imports',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: zhCN },
      fetch: fetchStub,
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

const calls = (path: string) =>
  api.mock.calls.map(([call]) => call).filter((call) => call.path === path);

// jsdom 的 Blob/File 与 Node 的 Request 序列化 multipart 不兼容；夹具只关心 method/path，
// 所以构造 Request 时把 multipart body 去掉，服务端与页面代码都不改。
beforeEach(() => {
  const NativeRequest = globalThis.Request;
  vi.stubGlobal('Request', class extends NativeRequest {
    public constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        input,
        init?.body instanceof FormData ? { ...init, body: undefined } : init,
      );
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-068 导入工具管理页', () => {
  it('渲染五个页签与样例下载链接，样例是编造数据的 CSV', async () => {
    await renderPage();
    expect(await screen.findAllByRole('tab', {}, WAIT)).toHaveLength(5);
    for (const name of ['物料', '往来单位', '仓库', '业务字典取值', '期初库存余额'])
      expect(await screen.findByRole('tab', { name }, WAIT)).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /下载样例/u }, WAIT);
    expect(link).toHaveAttribute('download', 'items.csv');
    expect(link.getAttribute('href') ?? '').toContain('import-samples/items.csv');
  });

  it('上传、试运行、确认导入三步按顺序调用端点并展示行号与错误码', async () => {
    answer = (call) => {
      if (call.path === 'imports/items/parse') return { token: 'tok-1', rowCount: 2, headers: [], issues: [] };
      if (call.path === 'imports/items/dry-run') return report();
      if (call.path === 'imports/items/commit') return report({ errorCount: 0, issues: [] });
      return notFound();
    };
    await renderPage();

    const file = new Blob(['name,unitCode\n样例,PCS\n'], { type: 'text/csv' }) as File;
    Object.defineProperty(file, 'name', { value: 'rows.csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(input.files?.length).toBe(1), WAIT);
    const parseButton = screen.getByRole('button', { name: '解析' });
    await waitFor(() => expect(parseButton).toBeEnabled(), WAIT);
    await userEvent.click(parseButton);
    await waitFor(() => expect(calls('imports/items/parse').length).toBe(1), WAIT);

    await userEvent.click(screen.getByRole('button', { name: '试运行' }));
    await waitFor(() => expect(calls('imports/items/dry-run').length).toBe(1), WAIT);
    expect(await screen.findByText('IMPORT_UNIT_NOT_FOUND', {}, WAIT)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(calls('imports/items/commit').length).toBe(1), WAIT);
    expect(await screen.findByText(/新建 1/u, {}, WAIT)).toBeInTheDocument();
    expect(calls('imports/items/commit')[0]?.json).toMatchObject({ token: 'tok-1', mode: 'skip' });
  });

  it('页面只在设置区声明，且带页面授权；业务角色看不到独立导航项', () => {
    const flat = (
      routes: readonly { readonly name?: string; readonly children?: readonly unknown[] }[],
    ): readonly { readonly name?: string }[] =>
      routes.flatMap((route) => [
        route,
        ...flat((route.children ?? []) as readonly {
          readonly name?: string;
          readonly children?: readonly unknown[];
        }[]),
      ]);
    const built = resolveAppClientContributions([
      {
        packageName: 'import-tool-app',
        source: 'application',
        routes: createApplicationRoutes(),
      },
    ]);
    const page = flat(built.routes as never[]).find(
      (route) => route.name === 'imports',
    ) as {
      readonly path?: string;
      readonly auth?: string;
      readonly authz?: unknown;
      readonly parent?: string;
      readonly navigation?: { readonly title?: string };
    } | undefined;
    expect(page).toBeDefined();
    expect(page?.path).toBe('/settings/imports');
    expect(page?.auth).toBe('required');
    expect(page?.authz).toEqual({ resource: { type: 'page', id: 'imports' }, action: 'access' });
    expect(page?.navigation?.title).toBeTruthy();
  });
});
