import { scopedApiKeysToken } from '@nocobase/app-plugin-api-keys/server';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';

import MyApiKeysPage from '../../client/pages/account/api-keys.js';
import enUS from '../../client/locales/en-US.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-032 第 2、3 条的界面这一半：页面按 `mayCreate` 显示「创建」，创建成功后明文只
 * 出现一次，列表里不带明文。
 *
 * 还有复查抓到的缺陷：创建的结果未知之后，页面必须给出真实原因与两条出路 ——
 * 原样重试（同一个幂等键），或核对列表后解锁表单（新的幂等键）。
 *
 * 用真实的应用与会话：密钥接口真的写进 `apikey` 表，页面拿真实响应渲染。
 * 权限收紧本身（root 能建、非 root 不能建）在 `tests/server/api-keys-own-policy.test.ts`。
 */

beforeEach(() => window.sessionStorage.clear());

type User = ReturnType<typeof userEvent.setup>;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}

const isCreatePost = (request: Request) =>
  request.method === 'POST' &&
  new URL(request.url).pathname.endsWith('/api/apiKeys');

const createPosts = (requests: readonly Recorded[]) =>
  requests.filter(
    (request) =>
      request.method === 'POST' && request.path.endsWith('/api/apiKeys'),
  );

function recordRequests(requests: Recorded[]) {
  return (request: Request) =>
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      headers: new Headers(request.headers),
    });
}

/**
 * 「结果未知」的提示会随第一次尝试的 pending 一起渲染，此时它自己的动作仍是禁用的。
 * 等第一次尝试落定、动作可用再点，否则点击被禁用状态吞掉，一个请求都不会发。
 */
async function clickWhenEnabled(user: User, button: HTMLElement) {
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 15_000 });
  await user.click(button);
}

/** 「创建密钥」按钮要等策略接口回来才出现；远端的机器慢，等它出现再点。 */
async function openCreateDialog(user: User) {
  await user.click(
    await screen.findByRole(
      'button',
      { name: enUS.apiKeys.personal.create },
      { timeout: 15_000 },
    ),
  );
  return screen.findByRole(
    'dialog',
    { name: enUS.apiKeys.personal.createTitle },
    { timeout: 15_000 },
  );
}

it('lets root create a key and shows the secret once, never in the list', async () => {
  const user = userEvent.setup();
  const view = await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
  });
  await screen.findByRole('heading', { name: enUS.apiKeys.personal.title });
  // 「创建」按钮与下面的「没有权限」提示要等策略接口回来才出现；标题先出来。
  // 远端的机器慢一拍，同步地去取会扑空（PR #2 的单测线在 CI 上红过两条），所以等它出现。断言不变。
  await user.click(
    await screen.findByRole(
      'button',
      { name: enUS.apiKeys.personal.create },
      { timeout: 15_000 },
    ),
  );
  const dialog = await screen.findByRole('dialog');
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'CI key',
  );
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.purpose),
    'For the pipeline',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );

  const secretDialog = await screen.findByRole('dialog', {
    name: enUS.apiKeys.personal.createdTitle,
  });
  const secret = (
    within(secretDialog).getByLabelText(
      enUS.apiKeys.common.secret,
    ) as HTMLInputElement
  ).value;
  expect(secret.length).toBeGreaterThan(10);
  expect(
    within(secretDialog).getByText(enUS.apiKeys.common.secretHint),
  ).toBeVisible();
  await user.click(
    within(secretDialog).getByRole('button', {
      name: enUS.apiKeys.common.done,
    }),
  );

  expect(await screen.findByText('CI key')).toBeVisible();
  expect(screen.getByText('For the pipeline')).toBeVisible();
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(secret);

  // 列表真的读回来了：服务端的那一行带着同一把密钥的名称。
  const response = await view.session.fetch('/apiKeys');
  const payload = (await response.json()) as {
    data: { name: string; description: string }[];
  };
  expect(payload.data).toEqual([
    expect.objectContaining({
      name: 'CI key',
      description: 'For the pipeline',
    }),
  ]);
});

it('hides creating and rotating from a non-root user but still lists their keys', async () => {
  const user = userEvent.setup();
  await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    member: true,
    prepare: async (server, session) => {
      // 页面加载前就有一把（由 root 早先签发），非 root 只应当看到它、能吊销它。
      const keys = server.application.container.resolve(scopedApiKeysToken);
      await keys.create(
        session.user.id,
        { name: 'Existing key' },
        await keys.identityOf(session.user.id),
      );
    },
  });
  expect(await screen.findByText('Existing key')).toBeVisible();
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: enUS.apiKeys.personal.create }),
    ).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByText(
      enUS.apiKeys.personal.createForbidden,
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();

  await user.click(
    screen.getByRole('button', {
      name: enUS.apiKeys.common.actionsFor.replace('{{name}}', 'Existing key'),
    }),
  );
  expect(
    await screen.findByRole('menuitem', { name: enUS.apiKeys.common.revoke }),
  ).toBeVisible();
  expect(
    screen.queryByRole('menuitem', { name: enUS.apiKeys.common.rotate }),
  ).not.toBeInTheDocument();
});

it('explains an unknown create outcome instead of blaming the name', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropCreate = true;
  await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropCreate && isCreatePost(request)) {
        dropCreate = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openCreateDialog(user);
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'CI key',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );

  expect(
    await within(dialog).findByText(
      enUS.apiKeys.common.outcomeUnknown,
      {},
      {
        timeout: 15_000,
      },
    ),
  ).toBeVisible();
  await waitFor(
    () =>
      expect(
        within(dialog).getByRole('button', {
          name: enUS.apiKeys.common.retryOriginal,
        }),
      ).toBeEnabled(),
    { timeout: 15_000 },
  );
  await waitFor(
    () =>
      expect(
        within(dialog).getByRole('button', {
          name: enUS.apiKeys.common.acknowledgeNotCommitted,
        }),
      ).toBeEnabled(),
    { timeout: 15_000 },
  );
  expect(
    within(dialog).queryByText(enUS.apiKeys.personal.createFailed),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
  ).toBeDisabled();
  expect(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  ).toBeDisabled();
});

it('retries the original create with the same idempotency key', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropCreate = true;
  await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropCreate && isCreatePost(request)) {
        dropCreate = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openCreateDialog(user);
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'CI key',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );
  expect(
    await within(dialog).findByText(
      enUS.apiKeys.common.outcomeUnknown,
      {},
      {
        timeout: 15_000,
      },
    ),
  ).toBeVisible();
  expect(createPosts(requests)).toHaveLength(1);

  await clickWhenEnabled(
    user,
    within(dialog).getByRole('button', {
      name: enUS.apiKeys.common.retryOriginal,
    }),
  );
  await waitFor(() => expect(createPosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = createPosts(requests);
  expect(first?.headers.get('idempotency-key')).toBeTruthy();
  expect(
    second?.headers.get('idempotency-key'),
    '原样重试沿用原来的幂等键',
  ).toBe(first?.headers.get('idempotency-key'));

  const secretDialog = await screen.findByRole(
    'dialog',
    { name: enUS.apiKeys.personal.createdTitle },
    { timeout: 15_000 },
  );
  expect(
    (
      within(secretDialog).getByLabelText(
        enUS.apiKeys.common.secret,
      ) as HTMLInputElement
    ).value.length,
  ).toBeGreaterThan(10);
});

it('unlocks a changed create after the operator checked the list', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropCreate = true;
  await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropCreate && isCreatePost(request)) {
        dropCreate = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openCreateDialog(user);
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'CI key',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );
  expect(
    await within(dialog).findByText(
      enUS.apiKeys.common.outcomeUnknown,
      {},
      {
        timeout: 15_000,
      },
    ),
  ).toBeVisible();

  await clickWhenEnabled(
    user,
    within(dialog).getByRole('button', {
      name: enUS.apiKeys.common.acknowledgeNotCommitted,
    }),
  );
  await waitFor(
    () =>
      expect(
        within(dialog).queryByText(enUS.apiKeys.common.outcomeUnknown),
      ).not.toBeInTheDocument(),
    { timeout: 15_000 },
  );
  const name = within(dialog).getByLabelText(enUS.apiKeys.common.name);
  expect(name).toBeEnabled();
  await user.clear(name);
  await user.type(name, 'Second key');
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );

  await waitFor(() => expect(createPosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = createPosts(requests);
  expect(
    second?.headers.get('idempotency-key'),
    '核对之后改内容再提交，用新的幂等键',
  ).not.toBe(first?.headers.get('idempotency-key'));

  expect(
    await screen.findByRole(
      'dialog',
      { name: enUS.apiKeys.personal.createdTitle },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
});

it('reports a response without a secret as already handled, not as created', async () => {
  const user = userEvent.setup();
  let dropSecret = true;
  await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    afterResponse: async (request, response) => {
      // 并发时后到的一方拿到的是重放：这一次已经处理过，响应里没有明文。
      if (dropSecret && isCreatePost(request)) {
        dropSecret = false;
        const payload = (await response.json()) as {
          data: { key: unknown; secret?: string };
        };
        delete payload.data.secret;
        return Response.json(payload, { status: response.status });
      }
    },
  });

  const dialog = await openCreateDialog(user);
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'CI key',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );

  expect(
    await screen.findByText(
      enUS.apiKeys.common.replayed,
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  // 列表刷新后那一行在：密钥已经建出来了，只是这次没给明文。
  expect(
    await screen.findByText('CI key', {}, { timeout: 15_000 }),
  ).toBeVisible();
  await waitFor(
    () =>
      expect(
        screen.queryByRole('dialog', {
          name: enUS.apiKeys.personal.createdTitle,
        }),
      ).not.toBeInTheDocument(),
    { timeout: 15_000 },
  );
  expect(
    screen.queryByLabelText(enUS.apiKeys.common.secret),
  ).not.toBeInTheDocument();
});

it('reports a successful revoke and does not mistake it for a replay', async () => {
  const user = userEvent.setup();
  const view = await renderAuthenticatedClient(<MyApiKeysPage />, {
    route: '/account/api-keys',
    locale: 'en-US',
    prepare: async (server, session) => {
      const keys = server.application.container.resolve(scopedApiKeysToken);
      await keys.create(
        session.user.id,
        { name: 'Revoke me' },
        await keys.identityOf(session.user.id),
      );
    },
  });
  expect(
    await screen.findByText('Revoke me', {}, { timeout: 15_000 }),
  ).toBeVisible();
  // 策略接口回来后「创建」按钮才出现；这一刻列定义稳定下来，行里的动作菜单不会在
  // 点开后被重建。等它出现再碰行菜单，和本文件创建按钮那两处的等待方式一致。
  await screen.findByRole(
    'button',
    { name: enUS.apiKeys.personal.create },
    { timeout: 30_000 },
  );
  await user.click(
    await screen.findByRole(
      'button',
      {
        name: enUS.apiKeys.common.actionsFor.replace('{{name}}', 'Revoke me'),
      },
      { timeout: 30_000 },
    ),
  );
  await user.click(
    await screen.findByRole(
      'menuitem',
      { name: enUS.apiKeys.common.revoke },
      { timeout: 30_000 },
    ),
  );
  const dialog = await screen.findByRole(
    'alertdialog',
    {
      name: enUS.apiKeys.common.revokeTitle.replace('{{name}}', 'Revoke me'),
    },
    { timeout: 30_000 },
  );
  await user.click(
    await within(dialog).findByRole(
      'button',
      { name: enUS.apiKeys.common.revoke },
      { timeout: 30_000 },
    ),
  );
  const toasts = () =>
    view.toasts().map((toast) => `${toast.type}:${toast.title}`);
  await waitFor(
    () => expect(toasts()).toContain(`success:${enUS.apiKeys.common.revoked}`),
    { timeout: 15_000 },
  );
  expect(toasts()).not.toContain(`info:${enUS.apiKeys.common.replayed}`);
  // 吊销后列表重读，这一把不在了。
  expect(
    await screen.findByText(
      enUS.apiKeys.personal.empty,
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();
});
