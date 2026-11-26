import { randomUUID } from 'node:crypto';

import type { TestApp } from '@nocobase/app-testing/server';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { beforeEach, expect, it } from 'vitest';

import QualityPage from '../../client/pages/quality/index.js';
import enUS from '../../client/locales/en-US.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-013 验收第 6 条：质量页的按钮按权限显隐，质量员能确认「待人工复核」的初筛。
 * R-002 验收第 17 条：初筛明细每行带出处（规则/模型、回落原因、知识引用），
 * 确认之后草稿原样、下方追加确认记录；页面上多一张「代填效果」卡片。
 *
 * 用真实的应用与授权：测试用户是自助注册的普通成员，另按本文件给的授权建一份权限集，
 * `useCan` 走真实的 `GET authorization/permissions`，端点也真的按授权判定。所以这里
 * 断言的是「按钮显隐」与「请求真的发出去」，不是被 mock 掉的行为。
 */

const ALL_FQC_SCOPES = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
  // R-002：确认要读写确认记录表；没配范围就是拒绝。
  fqcScreeningReviews: 'allRecords',
} as const;

/** 投递只写三张业务表：它的动作没有确认记录表的范围。 */
const INTAKE_FQC_SCOPES = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
} as const;

/** 一个业务动作的授权；数据范围照 seed，全部填「全部」。 */
const fqcGrant = (...actions: string[]): PermissionGrant => ({
  resource: { type: 'composite', id: 'fqc' },
  actions: actions.map((action) => ({
    action,
    policy: {
      type: 'composite',
      scopes: action === 'intake' ? INTAKE_FQC_SCOPES : ALL_FQC_SCOPES,
    },
  })),
});

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly search: string;
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
        search: new URL(request.url).search,
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
  /** R-002 的出处列；不传就走迁移的默认值（规则版、没跑过模型、无引用）。 */
  provenance: {
    readonly engine?: string;
    readonly promptVersion?: string | null;
    readonly degraded?: boolean;
    readonly degradeReason?: string | null;
    readonly knowledgeRefs?: string[] | null;
    readonly redacted?: boolean;
    readonly confidence?: string;
    readonly modelName?: string;
  } = {},
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
      ...provenance,
    },
  });
  return id;
}

/** 插一行确认记录，用来给「代填效果」的对照数字造数据。 */
async function insertReview(
  server: TestApp,
  screeningId: string,
  category: string,
  severity: string,
): Promise<string> {
  const id = randomUUID();
  await server.connection.repository('fqcScreeningReviews').createOne({
    values: {
      id,
      screeningId,
      kind: 'confirm',
      category,
      severity,
      departmentId: null,
      actorId: 'stats-fixture-actor',
      createdAt: new Date(),
    },
  });
  return id;
}

/** 在统计卡里找一行「标签 + 数字」，断言数字与给定的值一致。 */
function expectStat(
  card: HTMLElement,
  label: string,
  value: number,
): void {
  const row = within(card).getByText(label).closest('div');
  expect(row, `统计卡里要有「${label}」这一行`).not.toBeNull();
  expect(
    within(row as HTMLElement).getByText(String(value)),
    `「${label}」应显示 ${value}`,
  ).toBeVisible();
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
      // R-026：反馈单的状态只有 open 与 discarded；样例数据跟设计走。
      status: 'open',
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
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 查的是组件本地 state，交互后同步重渲染，不依赖异步请求
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

it('leaves the intake slot empty while permissions load and slots the form first when granted', async () => {
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

  // 权限悬置期左栏不占位：占位块在权限落定后塌掉，会把「部门分流」「代填效果」
  // 顶得上下跳（界面点验 2026-11-26，首屏上移 302px）。等待期什么都没有。
  await screen.findByText('Permission placeholder row');
  expect(
    screen.queryByTestId('intake-placeholder'),
    '投递占位块已取消：不许再渲染',
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId('intake-form')).not.toBeInTheDocument();
  expect(
    document.querySelector('[data-slot="review-placeholder"]'),
    '权限等待期也要占住确认按钮的位置',
  ).not.toBeNull();

  await act(async () => releasePermissions());

  const form = await screen.findByTestId('intake-form');
  const column = form.parentElement as HTMLElement;
  // 表单插在左栏最上面；它下面的两张卡保持原有相对顺序。
  const columnTitles = [...column.children].map(
    (child) => child.querySelector('[data-slot="card-title"]')?.textContent,
  );
  expect(columnTitles[0]).toBe(enUS.quality.intake.title);
  expect(columnTitles).toContain(enUS.quality.department.title);
  expect(columnTitles).toContain(enUS.quality.drafting.title);
  expect(
    columnTitles.indexOf(enUS.quality.department.title),
  ).toBeLessThan(columnTitles.indexOf(enUS.quality.drafting.title));
  expect(document.querySelector('[data-slot="review-placeholder"]')).toBeNull();
  expect(
    await screen.findByRole('button', {
      name: enUS.quality.screenings.review,
    }),
  ).toBeVisible();
  await waitForPermissions(requests);
});

it('renders the drafting outcomes skeleton rows in the same line boxes as the number rows', async () => {
  let releaseStats: () => void = () => {};
  const statsGate = new Promise<void>((resolve) => {
    releaseStats = resolve;
  });
  const { beforeRequest } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest: async (request) => {
      if (
        new URL(request.url).pathname.endsWith('/api/quality/drafting/stats')
      ) {
        await statsGate;
      }
      await beforeRequest(request);
    },
    prepare: async (server) => {
      await insertScreening(server, 'auto', 'A rule draft behind the skeleton');
    },
  });

  // 骨架态：14 行，行类与数字行完全一致（含 `text-sm`），骨架块的高度令牌
  // `h-5` 就是 `text-sm` 的行高（`--spacing(5)`）—— 行数、行高都一致，
  // 数据到达时卡片一像素也不长（界面点验 2026-11-26：380.05 → 447.20）。
  const card = await screen.findByTestId('drafting-stats');
  const skeletonRows = card.querySelectorAll('div[aria-hidden="true"]');
  expect(skeletonRows, '骨架行要铺满 14 行').toHaveLength(14);
  const skeletonClassName = skeletonRows[0]!.className;
  expect(skeletonClassName).toBe('flex items-center justify-between text-sm');
  expect(skeletonRows[0]!.firstElementChild).toHaveClass('h-5');
  expect(skeletonRows[0]!.lastElementChild).toHaveClass('h-5');

  await act(async () => releaseStats());

  const firstLabel = await within(card).findByText(
    enUS.quality.drafting.total,
  );
  const dataRow = firstLabel.closest('div') as HTMLElement;
  expect(
    dataRow.className,
    '数字行的行类要和骨架行一字不差：行盒相同，高度差才是 0',
  ).toBe(skeletonClassName);
  expect(card.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
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

it('marks each screening row with its engine and the model reason (R-002 17)', async () => {
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    prepare: async (server) => {
      // 三种出处各一条：开关关着的规则版（默认场景）、模型版、回落过的规则版。
      await insertScreening(server, 'needs-review', 'Rules only, switch off', {
        degradeReason: 'model-disabled',
      });
      await insertScreening(server, 'auto', 'Model draft', {
        engine: 'model',
        modelName: 'mock/model-x',
        promptVersion: 'fqc-draft-1',
        confidence: '0.9000',
        redacted: true,
      });
      await insertScreening(server, 'auto', 'Fell back draft', {
        degraded: true,
        degradeReason: 'invalid-output',
        redacted: true,
      });
    },
  });
  expect(await screen.findByText('Rules only, switch off')).toBeVisible();
  // 开关关着的规则版：规则徽章 + 「没跑模型」的原因，不空白也不报错。
  const switchOffRow = screen
    .getByText('Rules only, switch off')
    .closest('li') as HTMLElement;
  expect(
    within(switchOffRow).getByText(enUS.quality.screenings.engines.rules),
  ).toBeVisible();
  expect(
    within(switchOffRow).getByText(
      enUS.quality.screenings.degrade['model-disabled'],
    ),
  ).toBeVisible();
  // 回落过的规则版：回落标记带着原因。
  const fellBackRow = screen
    .getByText('Fell back draft')
    .closest('li') as HTMLElement;
  expect(
    within(fellBackRow).getByText(enUS.quality.screenings.engines.rules),
  ).toBeVisible();
  expect(
    within(fellBackRow).getByText(
      enUS.quality.screenings.degraded.replace(
        '{{reason}}',
        enUS.quality.screenings.degrade['invalid-output'],
      ),
    ),
  ).toBeVisible();
  // 模型版：模型徽章，五个回落原因一个都没有。
  const modelRow = screen
    .getByText('Model draft')
    .closest('li') as HTMLElement;
  expect(
    within(modelRow).getByText(enUS.quality.screenings.engines.model),
  ).toBeVisible();
  for (const reason of Object.values(enUS.quality.screenings.degrade)) {
    expect(within(modelRow).queryByText(reason)).toBeNull();
  }
  expect(within(modelRow).queryByText(enUS.quality.screenings.degraded)).toBeNull();
});

it('shows knowledge references as identifiers and similar cases only as a count (R-002 17)', async () => {
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    prepare: async (server) => {
      await insertScreening(server, 'auto', 'Referenced draft', {
        knowledgeRefs: ['kb:standards-doc#4', 'case:scr-aabbcc', 'case:scr-ddeeff'],
      });
      await insertScreening(server, 'auto', 'Unreferenced draft');
    },
  });
  expect(await screen.findByText('Referenced draft')).toBeVisible();
  // 知识库引用显示标识（客户端解析不出标题）。
  expect(screen.getByText('Quality standards: standards-doc#4')).toBeVisible();
  // 相似案例只显示条数。
  expect(screen.getByText('Similar cases referenced: 2')).toBeVisible();
  // case: 的标识不出现在页面上，更不是能点开的链接。
  expect(screen.queryByText('scr-aabbcc')).not.toBeInTheDocument();
  expect(screen.queryByText('scr-ddeeff')).not.toBeInTheDocument();
  const referencedRow = screen
    .getByText('Referenced draft')
    .closest('li') as HTMLElement;
  expect(within(referencedRow).queryByRole('link')).not.toBeInTheDocument();
  // 没有引用的行不渲染出处行。
  const unreferencedRow = screen
    .getByText('Unreferenced draft')
    .closest('li') as HTMLElement;
  expect(
    within(unreferencedRow).queryByText(/Similar cases referenced/),
  ).toBeNull();
  expect(
    within(unreferencedRow).queryByText(/Quality standards/),
  ).toBeNull();
});

it('keeps the draft untouched and records who confirmed what when (R-002 9, 17)', async () => {
  const user = userEvent.setup();
  const { beforeRequest, requests } = recordRequests();
  let userId = '';
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view', 'handle')],
    beforeRequest,
    prepare: async (server, session) => {
      userId = session.user.id;
      await insertScreening(server, 'needs-review', 'Draft that stays as it is', {
        degradeReason: 'model-disabled',
      });
    },
  });
  const summary = await screen.findByText('Draft that stays as it is');
  const confirm = await screen.findByRole('button', {
    name: enUS.quality.screenings.review,
  });
  const rowBefore = summary.closest('li') as HTMLElement;
  expect(
    within(rowBefore).getByText(enUS.quality.screenings.engines.rules),
  ).toBeVisible();
  // 确认之前这一行没有确认记录：「谁在何时确认成什么」只在确认之后多出来。
  expect(
    within(rowBefore).queryByTestId('review-record'),
    '确认之前不能已经显示确认记录',
  ).toBeNull();

  await user.click(confirm);
  await waitFor(() =>
    expect(
      paths(requests, '/api/quality/screenings', 'GET').length,
    ).toBeGreaterThan(0),
  );
  // 重取列表之后按钮消失（这一行不再是「待人工复核」）。
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: enUS.quality.screenings.review }),
    ).not.toBeInTheDocument(),
  );
  // 草稿原样不动：摘要、类别、严重度与引擎徽章都还是确认前的值。
  expect(screen.getByText('Draft that stays as it is')).toBeVisible();
  const rowAfter = screen
    .getByText('Draft that stays as it is')
    .closest('li') as HTMLElement;
  expect(
    within(rowAfter).getByText(enUS.quality.screenings.engines.rules),
  ).toBeVisible();
  expect(within(rowAfter).getByText('Dimension')).toBeVisible();
  expect(within(rowAfter).getByText('Minor')).toBeVisible();
  // 下方追加「谁在何时确认成什么」：确认人、时间、确认成的类别与严重度。
  const record = within(rowAfter).getByTestId('review-record');
  expect(record, '确认行要带着确认人').toHaveTextContent(userId);
  expect(record).toHaveTextContent('Dimension');
  expect(record).toHaveTextContent('Minor');
  expect(record).toHaveTextContent(
    /\d{2}:\d{2}/u,
    '确认行要带着时间',
  );
});

it('matches the drafting outcomes card to the stats response (R-002 14, 17)', async () => {
  let statsResponse:
    | {
        total: number;
        engines: { rules: number; model: number };
        degradeReasons: Record<string, number>;
        confirmed: number;
        agreement: {
          category: { matched: number; mismatched: number };
          severity: { matched: number; mismatched: number };
        };
      }
    | undefined;
  const { beforeRequest, requests } = recordRequests();
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest,
    afterResponse: async (request, response) => {
      if (
        new URL(request.url).pathname.endsWith('/api/quality/drafting/stats')
      ) {
        const body = (await response.clone().json()) as {
          data?: typeof statsResponse;
        };
        statsResponse = body.data;
      }
    },
    prepare: async (server) => {
      // 用户最先看到的情形：全是规则版、没有模型版数据。14 个数字里尽量多造出
      // 非零值（一致与不一致各一、脱敏多条、回落原因三种非零），逐格钉住。
      const mismatched = await insertScreening(
        server,
        'needs-review',
        'Rule draft awaiting review',
        { degradeReason: 'model-disabled' },
      );
      const confirmed = await insertScreening(
        server,
        'auto',
        'Rule draft confirmed by a human',
      );
      const alsoMatched = await insertScreening(
        server,
        'auto',
        'Another rule draft confirmed as screened',
      );
      await insertScreening(server, 'auto', 'Rule draft after a timeout', {
        degradeReason: 'timeout',
        redacted: true,
      });
      await insertScreening(server, 'auto', 'Rule draft from unusable output', {
        degradeReason: 'invalid-output',
        redacted: true,
      });
      // 两条确认与草稿一致、一条在类别与严重度上都不一致：一致与不一致的数字
      // 不相等，任何一格显示错行都会被逐格对照抓住。
      await insertReview(server, confirmed, 'dimension', 'minor');
      await insertReview(server, alsoMatched, 'dimension', 'minor');
      await insertReview(server, mismatched, 'function', 'critical');
    },
  });

  const card = await screen.findByTestId('drafting-stats');
  const statsCalls = paths(requests, '/api/quality/drafting/stats', 'GET');
  await waitFor(() => expect(statsCalls.length).toBeGreaterThan(0));
  // 请求带上了统计区间。
  const statsQuery = new URLSearchParams(statsCalls[0]!.search);
  expect(statsQuery.get('from')).toBeTruthy();
  expect(statsQuery.get('to')).toBeTruthy();
  await waitFor(() => expect(statsResponse).toBeDefined());
  const stats = statsResponse!;
  expectStat(card, enUS.quality.drafting.total, stats.total);
  expectStat(card, enUS.quality.drafting.rules, stats.engines.rules);
  expectStat(card, enUS.quality.drafting.model, stats.engines.model);
  expectStat(card, enUS.quality.drafting.confirmed, stats.confirmed);
  expectStat(
    card,
    enUS.quality.drafting.categoryMatched,
    stats.agreement.category.matched,
  );
  expectStat(
    card,
    enUS.quality.drafting.categoryMismatched,
    stats.agreement.category.mismatched,
  );
  expectStat(
    card,
    enUS.quality.drafting.severityMatched,
    stats.agreement.severity.matched,
  );
  expectStat(
    card,
    enUS.quality.drafting.severityMismatched,
    stats.agreement.severity.mismatched,
  );
  expectStat(card, enUS.quality.drafting.redacted, stats.redacted);
  expectStat(
    card,
    enUS.quality.screenings.degrade['model-disabled'],
    stats.degradeReasons['model-disabled'],
  );
  expectStat(
    card,
    enUS.quality.screenings.degrade['model-not-configured'],
    stats.degradeReasons['model-not-configured'],
  );
  expectStat(
    card,
    enUS.quality.screenings.degrade['model-error'],
    stats.degradeReasons['model-error'],
  );
  expectStat(
    card,
    enUS.quality.screenings.degrade.timeout,
    stats.degradeReasons.timeout,
  );
  expectStat(
    card,
    enUS.quality.screenings.degrade['invalid-output'],
    stats.degradeReasons['invalid-output'],
  );
  // 一致与不一致造出了不同的值：把任何一格换成另一格的值，上面的逐格对照都会红。
  expect(stats.agreement.category.matched).not.toBe(
    stats.agreement.category.mismatched,
  );
});

it('keeps the last drafting numbers with a visible stale notice and a retry when a refresh fails', async () => {
  const user = userEvent.setup();
  const { beforeRequest, requests } = recordRequests();
  let failStats = false;
  await renderAuthenticatedClient(<QualityPage />, {
    route: '/quality',
    locale: 'en-US',
    member: true,
    grants: [fqcGrant('view')],
    beforeRequest: async (request) => {
      await beforeRequest(request);
      if (
        failStats &&
        new URL(request.url).pathname.endsWith('/api/quality/drafting/stats')
      ) {
        throw new Error('stats endpoint down');
      }
    },
    prepare: async (server) => {
      await insertScreening(server, 'auto', 'A rule draft behind the numbers');
    },
  });

  // 第一次读取成功：数字出现。
  const card = await screen.findByTestId('drafting-stats');
  await waitFor(() => expectStat(card, enUS.quality.drafting.total, 1));
  const readsAfterFirstLoad = paths(
    requests,
    '/api/quality/drafting/stats',
    'GET',
  ).length;

  // 之后的刷新失败：旧数字还在，但要出现提示与重试入口，不能把旧数字悄悄当成当前值。
  failStats = true;
  await user.click(
    screen.getByRole('button', { name: enUS.quality.page.refresh }),
  );
  await waitFor(() =>
    expect(
      paths(requests, '/api/quality/drafting/stats', 'GET').length,
    ).toBeGreaterThan(readsAfterFirstLoad),
  );
  expect(
    await screen.findByText(enUS.quality.drafting.stale),
    '刷新失败要有提示，不能让旧数字装成当前值',
  ).toBeVisible();
  expectStat(card, enUS.quality.drafting.total, 1);
  const retry = screen.getByRole('button', { name: enUS.quality.drafting.retry });

  // 重试成功：提示消失，数字还是这一行的值。
  failStats = false;
  await user.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByText(enUS.quality.drafting.stale),
    ).not.toBeInTheDocument(),
  );
  expectStat(card, enUS.quality.drafting.total, 1);
  expect(
    paths(requests, '/api/quality/drafting/stats', 'GET').length,
    '重试要真的把统计请求再发一次',
  ).toBeGreaterThan(readsAfterFirstLoad + 1);
});
