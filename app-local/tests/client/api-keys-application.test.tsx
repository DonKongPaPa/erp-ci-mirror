import { randomUUID } from 'node:crypto';

import type { TestSession } from '@nocobase/app-plugin-authentication/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';

import ApplicationApiKeysPage from '../../client/pages/settings/application-api-keys.js';
import enUS from '../../client/locales/en-US.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-032 第 4 条的界面这一半：root 能在系统设置里建服务账号、给它签一把密钥并把
 * 明文复制走；没有被授予 `application.api-keys` 的登录用户拿不到服务账号列表。
 *
 * 还有复查抓到的缺陷：签发的结果未知之后，页面必须给出真实原因与两条出路 ——
 * 原样重试（同一个幂等键），或核对列表后解锁表单（新的幂等键）。
 *
 * 服务端的六个端点与它们的授权在 `tests/server/application-api-keys.test.ts`。
 */

beforeEach(() => window.sessionStorage.clear());

const OPERATION_KEY =
  /^\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type User = ReturnType<typeof userEvent.setup>;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}

const isIssuePost = (request: Request) =>
  request.method === 'POST' &&
  /\/application-api-keys\/accounts\/[^/]+\/keys$/u.test(
    new URL(request.url).pathname,
  );

const isAccountPost = (request: Request) =>
  request.method === 'POST' &&
  /\/application-api-keys\/accounts$/u.test(new URL(request.url).pathname);

const issuePosts = (requests: readonly Recorded[]) =>
  requests.filter(
    (request) =>
      request.method === 'POST' &&
      /\/application-api-keys\/accounts\/[^/]+\/keys$/u.test(request.path),
  );

const accountPosts = (requests: readonly Recorded[]) =>
  requests.filter(
    (request) =>
      request.method === 'POST' &&
      /\/application-api-keys\/accounts$/u.test(request.path),
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

/** 建一个服务账号，然后打开它的「签发密钥」对话框。 */
async function openIssueDialog(user: User) {
  expect(
    await screen.findByText(
      enUS.apiKeys.application.noAccounts,
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.newAccount }),
  );
  const accountDialog = await screen.findByRole(
    'dialog',
    {},
    { timeout: 15_000 },
  );
  await user.type(
    within(accountDialog).getByLabelText(enUS.apiKeys.application.accountName),
    'WeCom gateway',
  );
  await user.click(
    within(accountDialog).getByRole('button', {
      name: enUS.apiKeys.common.create,
    }),
  );
  expect(
    await screen.findByRole(
      'heading',
      { name: 'Keys of WeCom gateway' },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.issue }),
  );
  return screen.findByRole(
    'dialog',
    { name: enUS.apiKeys.application.issueTitle },
    { timeout: 15_000 },
  );
}

/** 签发一次，让第一次请求在传输层断掉。 */
async function issueOnceThenDrop(
  user: User,
  dialog: HTMLElement,
): Promise<void> {
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
    'Production key',
  );
  await user.click(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  );
}

it('creates a service account and issues its key with an idempotency key', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: recordRequests(requests),
  });

  expect(
    await screen.findByText(enUS.apiKeys.application.noAccounts),
  ).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.newAccount }),
  );
  const accountDialog = await screen.findByRole('dialog');
  await user.type(
    within(accountDialog).getByLabelText(enUS.apiKeys.application.accountName),
    'WeCom gateway',
  );
  await user.click(
    within(accountDialog).getByRole('button', {
      name: enUS.apiKeys.common.create,
    }),
  );

  expect(
    await screen.findByRole('heading', { name: 'Keys of WeCom gateway' }),
  ).toBeVisible();
  expect(
    screen.queryByText(enUS.apiKeys.application.noAccounts),
  ).not.toBeInTheDocument();

  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.issue }),
  );
  const issueDialog = await screen.findByRole('dialog');
  await user.type(
    within(issueDialog).getByLabelText(enUS.apiKeys.common.name),
    'Production key',
  );
  // 应用密钥必须过期：默认 90 天，这里改成 30。
  const days = within(issueDialog).getByLabelText(enUS.apiKeys.common.validity);
  await user.clear(days);
  await user.type(days, '30');
  await user.click(
    within(issueDialog).getByRole('button', {
      name: enUS.apiKeys.common.create,
    }),
  );

  const secretDialog = await screen.findByRole('dialog', {
    name: enUS.apiKeys.application.issuedTitle,
  });
  const secret = (
    within(secretDialog).getByLabelText(
      enUS.apiKeys.common.secret,
    ) as HTMLInputElement
  ).value;
  expect(secret.length).toBeGreaterThan(10);
  await user.click(
    within(secretDialog).getByRole('button', {
      name: enUS.apiKeys.common.done,
    }),
  );

  expect(await screen.findByText('Production key')).toBeVisible();
  expect(
    screen.getByText(enUS.apiKeys.common.statusLabel.active),
  ).toBeVisible();
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
  expect(document.body.textContent).not.toContain(secret);

  const writes = requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path.includes('/application-api-keys/accounts'),
  );
  expect(
    writes.map((request) => request.path),
    '应当先建服务账号再给它签发密钥',
  ).toHaveLength(2);
  for (const write of writes) {
    expect(
      write.headers.get('idempotency-key'),
      '每一个写操作都带 Idempotency-Key',
    ).toMatch(OPERATION_KEY);
  }
});

it('tells a user without application.api-keys that they have no access', async () => {
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    member: true,
  });
  expect(await screen.findByText(enUS.settings.denied)).toBeVisible();
  expect(
    screen.queryByRole('button', { name: enUS.apiKeys.application.newAccount }),
  ).not.toBeInTheDocument();
});

it('explains an unknown issue outcome instead of blaming the name', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropIssue = true;
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropIssue && isIssuePost(request)) {
        dropIssue = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openIssueDialog(user);
  await issueOnceThenDrop(user, dialog);

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
  // 结果未知不是「名称或有效期不对」，不能再用那句提示。
  expect(
    within(dialog).queryByText(enUS.apiKeys.application.issueFailed),
  ).not.toBeInTheDocument();
  // 结果未知时表单锁住，出路只有上面的两个动作。
  expect(
    within(dialog).getByLabelText(enUS.apiKeys.common.name),
  ).toBeDisabled();
  expect(
    within(dialog).getByRole('button', { name: enUS.apiKeys.common.create }),
  ).toBeDisabled();
});

it('retries the original issue with the same idempotency key', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropIssue = true;
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropIssue && isIssuePost(request)) {
        dropIssue = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openIssueDialog(user);
  await issueOnceThenDrop(user, dialog);
  expect(
    await within(dialog).findByText(
      enUS.apiKeys.common.outcomeUnknown,
      {},
      {
        timeout: 15_000,
      },
    ),
  ).toBeVisible();
  expect(issuePosts(requests)).toHaveLength(1);

  await clickWhenEnabled(
    user,
    within(dialog).getByRole('button', {
      name: enUS.apiKeys.common.retryOriginal,
    }),
  );
  await waitFor(() => expect(issuePosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = issuePosts(requests);
  expect(first?.headers.get('idempotency-key')).toMatch(OPERATION_KEY);
  expect(
    second?.headers.get('idempotency-key'),
    '原样重试沿用原来的幂等键',
  ).toBe(first?.headers.get('idempotency-key'));

  const secretDialog = await screen.findByRole(
    'dialog',
    { name: enUS.apiKeys.application.issuedTitle },
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

it('unlocks a changed issue after the operator checked the list', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropIssue = true;
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropIssue && isIssuePost(request)) {
        dropIssue = false;
        throw new Error('network down');
      }
    },
  });

  const dialog = await openIssueDialog(user);
  await issueOnceThenDrop(user, dialog);
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

  await waitFor(() => expect(issuePosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = issuePosts(requests);
  expect(
    second?.headers.get('idempotency-key'),
    '核对之后改内容再提交，用新的幂等键',
  ).not.toBe(first?.headers.get('idempotency-key'));

  expect(
    await screen.findByRole(
      'dialog',
      { name: enUS.apiKeys.application.issuedTitle },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
});

it('tells the operator a replayed issue carries no secret and refreshes the list', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropResponse = true;
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: recordRequests(requests),
    afterResponse: (request, response) => {
      // 服务端已经处理，响应在回程丢了：这正是「结果未知」的来处。
      if (dropResponse && isIssuePost(request) && response.ok) {
        dropResponse = false;
        throw new Error('connection reset after the server committed');
      }
    },
  });

  const dialog = await openIssueDialog(user);
  await issueOnceThenDrop(user, dialog);
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
      name: enUS.apiKeys.common.retryOriginal,
    }),
  );

  // 重放的响应不带明文：说明这次已经处理过，并把列表刷新出来。
  expect(
    await screen.findByText(
      enUS.apiKeys.common.replayed,
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  expect(
    await screen.findByText('Production key', {}, { timeout: 15_000 }),
  ).toBeVisible();
  await waitFor(
    () =>
      expect(
        screen.queryByRole('dialog', {
          name: enUS.apiKeys.application.issuedTitle,
        }),
      ).not.toBeInTheDocument(),
    { timeout: 15_000 },
  );
  expect(
    screen.queryByLabelText(enUS.apiKeys.common.secret),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(issuePosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = issuePosts(requests);
  expect(second?.headers.get('idempotency-key')).toBe(
    first?.headers.get('idempotency-key'),
  );
});

it('offers the same way out when creating a service account', async () => {
  const user = userEvent.setup();
  const requests: Recorded[] = [];
  let dropAccount = true;
  await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    beforeRequest: (request) => {
      recordRequests(requests)(request);
      if (dropAccount && isAccountPost(request)) {
        dropAccount = false;
        throw new Error('network down');
      }
    },
  });

  await screen.findByText(
    enUS.apiKeys.application.noAccounts,
    {},
    { timeout: 15_000 },
  );
  await user.click(
    screen.getByRole('button', { name: enUS.apiKeys.application.newAccount }),
  );
  const dialog = await screen.findByRole('dialog', {}, { timeout: 15_000 });
  await user.type(
    within(dialog).getByLabelText(enUS.apiKeys.application.accountName),
    'WeCom gateway',
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
  expect(
    within(dialog).queryByText(enUS.apiKeys.application.newAccountFailed),
  ).not.toBeInTheDocument();
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

  await clickWhenEnabled(
    user,
    within(dialog).getByRole('button', {
      name: enUS.apiKeys.common.retryOriginal,
    }),
  );
  await waitFor(() => expect(accountPosts(requests)).toHaveLength(2), {
    timeout: 15_000,
  });
  const [first, second] = accountPosts(requests);
  expect(
    second?.headers.get('idempotency-key'),
    '原样重试沿用原来的幂等键',
  ).toBe(first?.headers.get('idempotency-key'));
  expect(
    await screen.findByRole(
      'heading',
      { name: 'Keys of WeCom gateway' },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
});

const operationKey = () => `${Date.now()}.${randomUUID()}`;

/** 通过真实端点建一个服务账号并签发一把密钥；返回账号标识。 */
async function seedAccountAndKey(
  session: TestSession,
  keyName: string,
): Promise<string> {
  const post = (path: string, body: unknown) =>
    session.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        'Idempotency-Key': operationKey(),
      },
      body: JSON.stringify(body),
    });
  const accountResponse = await post('/application-api-keys/accounts', {
    name: 'Gateway',
  });
  const accountText = await accountResponse.text();
  expect(accountResponse.status, `${accountText}`).toBe(201);
  const account = (JSON.parse(accountText) as { data: { id: string } }).data;
  const keyResponse = await post(
    `/application-api-keys/accounts/${account.id}/keys`,
    { name: keyName, expiresInDays: 30 },
  );
  const keyText = await keyResponse.text();
  expect(keyResponse.status, `${keyText}`).toBe(201);
  return account.id;
}

it('reports a successful revoke and does not mistake it for a replay', async () => {
  const user = userEvent.setup();
  const view = await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    prepare: (_server, session) => seedAccountAndKey(session, 'Revoke me'),
  });
  expect(
    await screen.findByRole(
      'heading',
      { name: 'Keys of Gateway' },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  expect(
    await screen.findByText('Revoke me', {}, { timeout: 15_000 }),
  ).toBeVisible();
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
  expect(
    await screen.findByText(
      enUS.apiKeys.application.empty,
      {},
      { timeout: 30_000 },
    ),
  ).toBeVisible();
});

it('keeps the replay notice for a rotate whose secret was already shown', async () => {
  const user = userEvent.setup();
  let lostOnce = false;
  const view = await renderAuthenticatedClient(<ApplicationApiKeysPage />, {
    route: '/settings/api-keys',
    locale: 'en-US',
    prepare: (_server, session) => seedAccountAndKey(session, 'Rotate me'),
    afterResponse(request, response) {
      // 服务端已经轮换成功，但这一次响应丢了：客户端会保留幂等键重试，
      // 服务端重放时不会再带明文 —— 这正是那句重放提示适用的场景。
      if (
        !lostOnce &&
        request.method === 'POST' &&
        request.url.includes('/rotate') &&
        response.ok
      ) {
        lostOnce = true;
        throw new Error('simulated lost rotate response');
      }
    },
  });
  expect(
    await screen.findByRole(
      'heading',
      { name: 'Keys of Gateway' },
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  expect(
    await screen.findByText('Rotate me', {}, { timeout: 15_000 }),
  ).toBeVisible();
  await user.click(
    await screen.findByRole(
      'button',
      {
        name: enUS.apiKeys.common.actionsFor.replace('{{name}}', 'Rotate me'),
      },
      { timeout: 30_000 },
    ),
  );
  await user.click(
    await screen.findByRole(
      'menuitem',
      { name: enUS.apiKeys.common.rotate },
      { timeout: 30_000 },
    ),
  );
  const dialog = await screen.findByRole(
    'alertdialog',
    {
      name: enUS.apiKeys.common.rotateTitle.replace('{{name}}', 'Rotate me'),
    },
    { timeout: 30_000 },
  );
  await user.click(
    await within(dialog).findByRole(
      'button',
      { name: enUS.apiKeys.common.rotate },
      { timeout: 30_000 },
    ),
  );
  // 第一次丢了响应：确认框留在原地并报错。
  expect(
    await within(dialog).findByRole('alert', {}, { timeout: 15_000 }),
  ).toHaveTextContent(enUS.apiKeys.common.failed);

  // 用同一个幂等键重试：服务端重放，没有新明文，所以出现重放提示而不是明文框。
  await user.click(
    await within(dialog).findByRole(
      'button',
      { name: enUS.apiKeys.common.rotate },
      { timeout: 30_000 },
    ),
  );
  await waitFor(
    () =>
      expect(
        view.toasts().map((toast) => `${toast.type}:${toast.title}`),
      ).toContain(`info:${enUS.apiKeys.common.replayed}`),
    { timeout: 15_000 },
  );
  expect(
    screen.queryByRole('dialog', { name: enUS.apiKeys.common.rotatedTitle }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByText('Rotate me', {}, { timeout: 30_000 }),
  ).toBeVisible();
});
