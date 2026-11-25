import { randomUUID } from 'node:crypto';

import type { TestApp } from '@nocobase/app-testing/server';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { beforeEach, expect, it } from 'vitest';

import QualityPage from '../../client/pages/quality/index.js';
import enUS from '../../client/locales/en-US.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-013 验收第 6 条：质量页的按钮按权限显隐，质量员能确认「待人工复核」的初筛。
 *
 * 用真实的应用与授权：测试用户是自助注册的普通成员，另按本文件给的授权建一份权限集，
 * `useCan` 走真实的 `GET authorization/permissions`，端点也真的按授权判定。所以这里
 * 断言的是「按钮显隐」与「请求真的发出去」，不是被 mock 掉的行为。
 */

const ALL_FQC_SCOPES = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
} as const;

/** 一个业务动作的授权；数据范围照 seed，全部填「全部」。 */
const fqcGrant = (...actions: string[]): PermissionGrant => ({
  resource: { type: 'composite', id: 'fqc' },
  actions: actions.map((action) => ({
    action,
    policy: { type: 'composite', scopes: ALL_FQC_SCOPES },
  })),
});

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

/** 记录页面向真实服务端发出的请求，断言头、请求体与取数次数。 */
function recordRequests() {
  const requests: Recorded[] = [];
  return {
    requests,
    beforeRequest: async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      });
    },
  };
}

const paths = (requests: readonly Recorded[], path: string, method: string) =>
  requests.filter(
    (request) => request.path.endsWith(path) && request.method === method,
  );

/** 等权限快照读完：等待期 `can` 是 false，不等就把「没有按钮」当成没有权限。 */
const waitForPermissions = (requests: readonly Recorded[]) =>
  waitFor(() => {
    if (!paths(requests, '/api/authorization/permissions', 'GET').length) {
      throw new Error('权限快照还没读回来');
    }
  });

/** 插一条初筛。列表端点按行的状态算 canReview，这里只造数据。 */
async function insertScreening(
  server: TestApp,
  outcome: string,
  summary: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await server.connection.repository('fqcScreenings').createOne({
    values: {
      id,
      messageId: randomUUID(),
      category: 'dimension',
      severity: 'minor',
      suggestedOwner: null,
      summary,
      confidence: '0.3500',
      modelName: 'r013-client-test',
      outcome,
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}

/** 插一条工单，用来钉列表里的时间格式。 */
async function insertTicket(
  server: TestApp,
  createdAt: string,
): Promise<string> {
  const id = randomUUID();
  await server.connection.repository('fqcTickets').createOne({
    values: {
      id,
      code: `FQC-${id.slice(0, 8)}`,
      title: 'dimension / minor',
      description: '时间格式测试工单',
      sourceMessageId: null,
      screeningId: null,
      category: 'dimension',
      severity: 'minor',
      ownerDepartment: null,
      assigneeId: null,
      state: 'open',
      dueAt: null,
      closedAt: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
  return id;
}

/** 插一条客户消息，用来钉频道的显示名。 */
async function insertMessage(
  server: TestApp,
  channel: string,
  receivedAt: string,
): Promise<string> {
  const id = randomUUID();
  await server.connection.repository('fqcMessages').createOne({
    values: {
      id,
      channel,
      externalId: null,
      senderName: 'Test customer',
      senderContact: null,
      content: '频道显示名测试消息',
      rawContentType: 'text',
      receivedAt,
      status: 'screened',
      createdAt: receivedAt,
      updatedAt: receivedAt,
    },
  });
  return id;
}

beforeEach(() => window.sessionStorage.clear());

it('hides the intake form from a user without fqc.intake', async () => {
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest,
  });
  await screen.findByText(enUS.quality.tickets.empty);
  await waitForPermissions(requests);
  expect(
    screen.queryByRole('button', { name: enUS.quality.intake.submit }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByPlaceholderText(enUS.quality.intake.contentPlaceholder),
  ).not.toBeInTheDocument();
});

it('shows the intake form with fqc.intake and sends a fresh idempotency key per submission', async () => {
  const user = userEvent.setup();
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'intake')],
    beforeRequest,
  });
  const content = await screen.findByPlaceholderText(
    enUS.quality.intake.contentPlaceholder,
  );
  expect(
    screen.getByRole('button', { name: enUS.quality.intake.submit }),
  ).toBeVisible();

  await user.type(content, 'First message: the parts do not fit');
  await user.click(
    screen.getByRole('button', { name: enUS.quality.intake.submit }),
  );
  await waitFor(() =>
    expect(paths(requests, '/api/quality/intake', 'POST')).toHaveLength(1),
  );
  await waitFor(() => expect(content).toHaveValue(''));

  await user.type(content, 'Second message: a different complaint');
  await user.click(
    screen.getByRole('button', { name: enUS.quality.intake.submit }),
  );
  await waitFor(() =>
    expect(paths(requests, '/api/quality/intake', 'POST')).toHaveLength(2),
  );

  const [first, second] = paths(requests, '/api/quality/intake', 'POST');
  expect(
    first?.headers.get('Idempotency-Key'),
    '投递必须带幂等键',
  ).toBeTruthy();
  expect(
    second?.headers.get('Idempotency-Key'),
    '两次不同的投递不能用同一个键',
  ).not.toBe(first?.headers.get('Idempotency-Key'));
});

it('confirms a needs-review row with an empty body and refetches the list', async () => {
  const user = userEvent.setup();
  const { beforeRequest, requests } = recordRequests();
  let screeningId = '';
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'handle')],
    beforeRequest,
    prepare: async (server) => {
      screeningId = await insertScreening(
        server,
        'needs-review',
        'A human has to look at this one',
      );
    },
  });

  const confirm = await screen.findByRole('button', {
    name: enUS.quality.screenings.review,
  });
  expect(
    await screen.findByText('A human has to look at this one'),
  ).toBeVisible();
  const readsBefore = paths(requests, '/api/quality/screenings', 'GET').length;

  await user.click(confirm);
  const reviewPath = `/api/quality/screenings/${screeningId}/review`;
  await waitFor(() =>
    expect(paths(requests, reviewPath, 'POST')).toHaveLength(1),
  );
  const review = paths(requests, reviewPath, 'POST')[0];
  expect(review?.body, '确认的请求体是 {}').toBe('{}');

  await waitFor(() =>
    expect(
      paths(requests, '/api/quality/screenings', 'GET').length,
    ).toBeGreaterThan(readsBefore),
  );
  // 复核后这一行不再是「待人工复核」，重新取到的列表里按钮消失。
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: enUS.quality.screenings.review }),
    ).not.toBeInTheDocument(),
  );
});

it('shows no confirm button for a row that is not awaiting review', async () => {
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'handle')],
    beforeRequest,
    prepare: async (server) => {
      await insertScreening(server, 'auto', 'Routed without a human');
    },
  });
  expect(await screen.findByText('Routed without a human')).toBeVisible();
  await waitForPermissions(requests);
  expect(
    screen.queryByRole('button', { name: enUS.quality.screenings.review }),
  ).not.toBeInTheDocument();
});

it('shows no confirm button to a user without fqc.handle', async () => {
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest,
    prepare: async (server) => {
      await insertScreening(
        server,
        'needs-review',
        'Awaiting a reviewer who cannot act',
      );
    },
  });
  expect(
    await screen.findByText('Awaiting a reviewer who cannot act'),
  ).toBeVisible();
  await waitForPermissions(requests);
  expect(
    screen.queryByRole('button', { name: enUS.quality.screenings.review }),
  ).not.toBeInTheDocument();
});

it('offers a checked-the-list way out after an intake whose outcome is unknown', async () => {
  const user = userEvent.setup();
  const { beforeRequest, requests } = recordRequests();
  let failIntake = true;
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'intake')],
    beforeRequest: async (request) => {
      await beforeRequest(request);
      if (
        failIntake &&
        new URL(request.url).pathname.endsWith('/api/quality/intake')
      ) {
        failIntake = false;
        throw new Error('network down');
      }
    },
  });
  const content = await screen.findByPlaceholderText(
    enUS.quality.intake.contentPlaceholder,
  );
  const submit = screen.getByRole('button', {
    name: enUS.quality.intake.submit,
  });

  await user.type(content, 'First message: the parts do not fit');
  await user.click(submit);
  expect(
    await screen.findByText(enUS.quality.intake.outcomeUnknown),
  ).toBeVisible();
  expect(
    paths(requests, '/api/quality/intake', 'POST'),
    '第一次投递确实发出去了',
  ).toHaveLength(1);
  expect(submit, '结果未知时不能再投').toBeDisabled();

  // 改过内容也发不出去：钩子会拿原操作核对，页面不应让它走到那一步。
  await user.clear(content);
  await user.type(content, 'Second message: a different complaint');
  expect(submit).toBeDisabled();

  await user.click(
    screen.getByRole('button', { name: enUS.quality.intake.acknowledge }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText(enUS.quality.intake.outcomeUnknown),
    ).not.toBeInTheDocument(),
  );
  expect(submit).toBeEnabled();

  await user.click(submit);
  await waitFor(() =>
    expect(paths(requests, '/api/quality/intake', 'POST')).toHaveLength(2),
  );
  const [first, second] = paths(requests, '/api/quality/intake', 'POST');
  expect(
    second?.headers.get('Idempotency-Key'),
    '核对之后重新投递应当用新的幂等键',
  ).not.toBe(first?.headers.get('Idempotency-Key'));
});

it('restores an unknown intake outcome after leaving and returning to the page', async () => {
  const user = userEvent.setup();
  function PageWithToggle(): ReactElement {
    const [shown, setShown] = useState(true);
    return (
      <>
        <button onClick={() => setShown((value) => !value)}>
          {shown ? 'Leave page' : 'Return to page'}
        </button>
        {shown ? <QualityPage /> : null}
      </>
    );
  }
  const { beforeRequest, requests } = recordRequests();
  let failIntake = true;
  await renderAuthenticatedClient(<PageWithToggle />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'intake')],
    beforeRequest: async (request) => {
      await beforeRequest(request);
      if (
        failIntake &&
        new URL(request.url).pathname.endsWith('/api/quality/intake')
      ) {
        failIntake = false;
        throw new Error('network down');
      }
    },
  });
  await user.type(
    await screen.findByPlaceholderText(enUS.quality.intake.contentPlaceholder),
    'The result will be lost',
  );
  await user.click(
    screen.getByRole('button', { name: enUS.quality.intake.submit }),
  );
  expect(
    await screen.findByText(enUS.quality.intake.outcomeUnknown),
  ).toBeVisible();
  expect(paths(requests, '/api/quality/intake', 'POST')).toHaveLength(1);

  await user.click(screen.getByRole('button', { name: 'Leave page' }));
  expect(
    screen.queryByText(enUS.quality.intake.outcomeUnknown),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Return to page' }));

  expect(
    await screen.findByText(enUS.quality.intake.outcomeUnknown),
    '回到页面后仍要告诉用户上一次的结果未知',
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: enUS.quality.intake.submit }),
  ).toBeDisabled();
});

it('keeps the intake slot and review button in place while permissions load', async () => {
  let releasePermissions: () => void = () => {};
  const permissionsGate = new Promise<void>((resolve) => {
    releasePermissions = resolve;
  });
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'handle', 'intake')],
    beforeRequest: async (request) => {
      if (
        new URL(request.url).pathname.endsWith('/api/authorization/permissions')
      ) {
        await permissionsGate;
      }
      await beforeRequest(request);
    },
    prepare: async (server) => {
      await insertScreening(
        server,
        'needs-review',
        'Permission placeholder row',
      );
    },
  });

  const placeholder = await screen.findByTestId('intake-placeholder');
  // jsdom 不排版，这里量的是 DOM 位置与两边共用的高度下限：真实表单与占位在同一个
  // 位置、用同一个 `min-h-80`，权限回来换内容时下面的卡片不会移动。
  expect(placeholder).toHaveClass('min-h-80');
  const parent = placeholder.parentElement;
  const position = parent ? [...parent.children].indexOf(placeholder) : -1;
  expect(parent, '投递卡片应当有父容器').not.toBeNull();
  await screen.findByText('Permission placeholder row');
  expect(
    document.querySelector('[data-slot="review-placeholder"]'),
    '权限等待期也要占住确认按钮的位置',
  ).not.toBeNull();

  await act(async () => releasePermissions());

  const form = await screen.findByTestId('intake-form');
  expect(form).toHaveClass('min-h-80');
  expect(form.parentElement).toBe(parent);
  expect(
    form.parentElement ? [...form.parentElement.children].indexOf(form) : -1,
  ).toBe(position);
  expect(document.querySelector('[data-slot="review-placeholder"]')).toBeNull();
  expect(
    await screen.findByRole('button', {
      name: enUS.quality.screenings.review,
    }),
  ).toBeVisible();
  await waitForPermissions(requests);
});

it('shows a prompt where the intake form and review button would be when permissions fail to load', async () => {
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'handle', 'intake')],
    beforeRequest: async (request) => {
      if (
        new URL(request.url).pathname.endsWith('/api/authorization/permissions')
      ) {
        throw new Error('permissions unavailable');
      }
    },
    prepare: async (server) => {
      await insertScreening(
        server,
        'needs-review',
        'Permission read failed row',
      );
    },
  });

  expect(
    await screen.findByTestId('intake-permission-error'),
    '读取失败时投递表单的位置要有提示',
  ).toHaveTextContent(enUS.quality.permissionFailed);
  expect(screen.queryByTestId('intake-form')).not.toBeInTheDocument();
  expect(screen.queryByTestId('intake-placeholder')).not.toBeInTheDocument();

  expect(await screen.findByText('Permission read failed row')).toBeVisible();
  expect(
    await screen.findByTestId('review-permission-error'),
    '读取失败时确认按钮的位置也要有提示',
  ).toHaveTextContent(enUS.quality.permissionFailed);
  expect(
    screen.queryByRole('button', { name: enUS.quality.screenings.review }),
  ).not.toBeInTheDocument();
});

it('shows neither the intake form nor a permission error when the user simply may not intake', async () => {
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest,
    prepare: async (server) => {
      await insertScreening(server, 'needs-review', 'No permission row');
    },
  });
  await waitForPermissions(requests);
  expect(await screen.findByText('No permission row')).toBeVisible();

  // 投递区与确认按钮要等权限快照回来才换内容，比列表行晚一步；远端机器慢时行已经出来、
  // 占位还在。这里要的是「稳定之后这些都不出现」，所以连着等，不在某一瞬间断言。
  await waitFor(() => {
    expect(screen.queryByTestId('intake-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-placeholder')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('intake-permission-error'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enUS.quality.screenings.review }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('review-permission-error'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(enUS.quality.permissionFailed),
    ).not.toBeInTheDocument();
  });
});

it('fills the ticket area with skeleton rows while the first load runs', async () => {
  let releaseTickets: () => void = () => {};
  const ticketGate = new Promise<void>((resolve) => {
    releaseTickets = resolve;
  });
  const { beforeRequest } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest: async (request) => {
      if (new URL(request.url).pathname.endsWith('/api/quality/tickets')) {
        await ticketGate;
      }
      await beforeRequest(request);
    },
  });

  const loading = await screen.findByTestId('ticket-loading');
  expect(loading).toHaveClass('min-h-96');
  expect(
    loading.querySelectorAll('[data-testid="ticket-loading-row"]'),
    '加载占位要铺出与真实列表同量级的骨架行',
  ).toHaveLength(8);

  await act(async () => releaseTickets());
  expect(await screen.findByText(enUS.quality.tickets.empty)).toBeVisible();
  expect(screen.queryByTestId('ticket-loading')).not.toBeInTheDocument();
});

it.each([
  ['en-US', 'en-US'],
  ['zh-CN', 'zh-CN'],
])('formats ticket times in the interface locale (%s)', async (locale) => {
  const createdAt = '2026-11-24T11:20:00.000Z';
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale,
    member: true,
    grants: [fqcGrant('view')],
    prepare: async (server) => {
      await insertTicket(server, createdAt);
    },
  });
  const expected = new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(createdAt));
  expect(await screen.findByText(expected)).toBeVisible();
});

it('shows a known message channel by its localized name', async () => {
  const receivedAt = '2026-11-24T11:20:00.000Z';
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    prepare: async (server) => {
      await insertMessage(server, 'wechat', receivedAt);
    },
  });
  expect(await screen.findByText('WeChat')).toBeVisible();
  expect(screen.queryByText('wechat')).not.toBeInTheDocument();
});

it('does not point users at an intake form they may not see', async () => {
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
  });
  expect(await screen.findByText(enUS.quality.tickets.empty)).toBeVisible();
  expect(enUS.quality.tickets.empty).not.toMatch(/form|submit/iu);
});
