import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken } from '@nocobase/app-client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QualityPage from '../../client/pages/quality/index.js';
import { transitionNames } from '../../client/pages/quality/model.js';
import enUS from '../../client/locales/en-US.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-003 第九片：工单流转、派单规则、帮手的页面行为。
 *
 * 列表、详情、`canTransition`、帮手与派单规则的端点在 S6–S8（另一片），
 * 这一片只按 R-003 的接口契约写页面，所以这里的 HTTP 整个换成夹具
 * （`answerApi`）：`useCan` 仍走真实的授权快照，页面按授权决定看到什么、
 * 发什么请求。断言的是「按钮跟着服务端算好的 canTransition 走」「请求体
 * 真的发出去」「帮手不带描述」，不是被 mock 掉的组件内部状态。
 */

const DEPARTMENT_ID = 'dept-1';
const TICKET_ID = 't-1';
const SCREENING_ID = 's-1';
const SLOW = { timeout: 15_000 };

type Answer = unknown;

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => Answer;
const api = vi.fn((call: ApiCall) => answer(call));

function fqcGrant(...actions: string[]): AuthorizationSnapshot {
  return {
    unrestricted: false,
    permissions: [
      { resource: { type: 'composite', id: 'fqc' }, actions },
    ],
  };
}

function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TICKET_ID,
    code: 'FQC-00000001',
    title: 'dimension / minor',
    description: 'Mocked customer text',
    sourceMessageId: null,
    screeningId: null,
    category: 'dimension',
    severity: 'minor',
    departmentId: DEPARTMENT_ID,
    departmentTitle: 'Assembly',
    assigneeId: null,
    assigneeName: null,
    state: 'open',
    resolution: null,
    reopenCount: 0,
    closedAt: null,
    createdAt: '2026-11-24T11:20:00.000Z',
    updatedAt: '2026-11-24T11:20:00.000Z',
    canTransition: [],
    ...overrides,
  };
}

function screening(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SCREENING_ID,
    messageId: 'm-1',
    category: 'dimension',
    severity: 'minor',
    suggestedOwner: null,
    summary: 'A draft awaiting dispatch',
    confidence: '0.3500',
    evidence: null,
    modelName: 'rules',
    engine: 'rules',
    promptVersion: null,
    degraded: false,
    degradeReason: null,
    knowledgeRefs: null,
    redacted: false,
    reviewId: null,
    outcome: 'needs-review',
    canReview: true,
    review: null,
    createdAt: '2026-11-24T11:00:00.000Z',
    updatedAt: '2026-11-24T11:00:00.000Z',
    ...overrides,
  };
}

function detailOf(
  row: Record<string, unknown>,
  overrides: {
    readonly reviews?: readonly Record<string, unknown>[];
    readonly transitions?: readonly Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    ticket: row,
    reviews: overrides.reviews ?? [],
    transitions: overrides.transitions ?? [],
  };
}

function stats(): Record<string, unknown> {
  return {
    from: '2025-11-26T00:00:00.000Z',
    to: '2026-11-26T00:00:00.000Z',
    total: 0,
    engines: { rules: 0, model: 0 },
    degradeReasons: {
      'model-disabled': 0,
      'model-not-configured': 0,
      'model-error': 0,
      timeout: 0,
      'invalid-output': 0,
    },
    redacted: 0,
    confirmed: 0,
    agreement: {
      category: { matched: 0, mismatched: 0 },
      severity: { matched: 0, mismatched: 0 },
    },
  };
}

const routingRules: readonly Record<string, unknown>[] = [
  { category: 'appearance', departmentId: null, departmentTitle: null },
  { category: 'dimension', departmentId: DEPARTMENT_ID, departmentTitle: 'Assembly' },
  { category: 'function', departmentId: null, departmentTitle: null },
  { category: 'packaging', departmentId: null, departmentTitle: null },
  { category: 'material', departmentId: null, departmentTitle: null },
  { category: 'process', departmentId: null, departmentTitle: null },
  { category: 'other', departmentId: null, departmentTitle: null },
];

let ticketsData: readonly Record<string, unknown>[] = [];
let screeningsData: readonly Record<string, unknown>[] = [];

const getSession = vi.fn(async () => ({ data: null }));

function LocationProbe(): ReactElement {
  return <span data-testid='location' />;
}

async function renderQuality(): Promise<ReturnType<typeof renderWithApp>> {
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/quality' element={<QualityPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: '/quality',
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
        app.container.singleton(
          authorizationClientToken,
          (resolver) =>
            new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

const callsTo = (path: string, method?: string) =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.path === path && (method === undefined || call.method === method));

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  permissions = fqcGrant('view');
  ticketsData = [];
  screeningsData = [];
  answer = (call) => {
    if (call.path === 'authorization/permissions') return { data: permissions };
    if (call.path === 'quality/tickets')
      return { data: ticketsData, meta: { total: ticketsData.length } };
    if (call.path === 'quality/messages') return { data: [], meta: { total: 0 } };
    if (call.path === 'quality/screenings')
      return { data: screeningsData, meta: { total: screeningsData.length } };
    if (call.path === 'quality/drafting/stats') return { data: stats() };
    if (call.path === 'quality/routing-rules') return { data: routingRules };
    return new Response(null, { status: 404 });
  };
});

describe('R-003 工单流转按钮', () => {
  it('canTransition 为空的行没有流转按钮，服务端给了的行有', async () => {
    ticketsData = [
      ticket({ id: 't-no', code: 'FQC-00000001', canTransition: [] }),
      ticket({
        id: 't-yes',
        code: 'FQC-00000002',
        canTransition: ['accept', 'resolve', 'close', 'reopen'],
      }),
    ];
    await renderQuality();

    const rows = await screen.findAllByTestId('ticket-row', {}, SLOW);
    expect(rows).toHaveLength(2);
    const noRow = rows.find((row) =>
      within(row).queryByText('FQC-00000001'),
    ) as HTMLElement;
    const yesRow = rows.find((row) =>
      within(row).queryByText('FQC-00000002'),
    ) as HTMLElement;
    // 服务端不给的转移一个按钮都没有：客户端不自己判断能不能流转。
    expect(
      within(noRow).queryByTestId('row-transition-accept'),
    ).not.toBeInTheDocument();
    expect(
      within(noRow).queryByTestId('row-transition-resolve'),
    ).not.toBeInTheDocument();
    for (const name of ['accept', 'resolve', 'close', 'reopen'] as const) {
      expect(
        within(yesRow).getByTestId(`row-transition-${name}`),
        `服务端给了的 ${name} 要有按钮`,
      ).toBeVisible();
    }
    expect(
      within(yesRow).queryByTestId('row-transition-reassign'),
    ).not.toBeInTheDocument();
  });

  it('canTransition 里的陌生取值被收窄掉，五个转移名之外的渲染不出按钮', () => {
    expect(transitionNames(['accept', 'teleport', 'reassign', 42])).toEqual([
      'accept',
      'reassign',
    ]);
    expect(transitionNames(undefined)).toEqual([]);
    expect(transitionNames('accept')).toEqual([]);
  });

  it('只持「处理」的人做不了流转：行上与详情都没有流转按钮，但能改判', async () => {
    permissions = fqcGrant('view', 'handle');
    ticketsData = [
      ticket({
        id: TICKET_ID,
        screeningId: SCREENING_ID,
        canTransition: [],
      }),
    ];
    answer = (call) => {
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    expect(await screen.findByTestId('ticket-row', {}, SLOW)).toBeVisible();
    // 行上没有流转按钮。
    expect(
      screen.queryByTestId('row-transition-accept'),
    ).not.toBeInTheDocument();
    // 详情里能改判（持「处理」），但没有流转按钮、没有帮手（那要「处理工单」）。
    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(
      await within(dialog).findByTestId('rejudge', {}, SLOW),
    ).toBeVisible();
    expect(within(dialog).queryByTestId('transition-accept')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('transition-resolve')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('change-assignee')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('assist-section')).not.toBeInTheDocument();
  });

  it('受理按 canTransition 出现在行上，提交发 POST transitions {name: accept}', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: ['accept'] })];
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('row-transition-accept', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.quality.tickets.actions.accept }),
    );
    await waitFor(() =>
      expect(
        callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST'),
      ).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')[0]!.json,
    ).toEqual({ name: 'accept' });
  });

  it('重开必须填原因：没填不能发，填了发 {name: reopen, input: {reason}}', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: ['reopen'] })];
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('row-transition-reopen', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const submit = within(dialog).getByRole('button', {
      name: enUS.quality.tickets.actions.reopen,
    });
    expect(submit, '没有原因时不能提交').toBeDisabled();
    expect(callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')).toHaveLength(0);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: enUS.quality.reopen.reason }),
      '回归了',
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(
        callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST'),
      ).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')[0]!.json,
    ).toEqual({ name: 'reopen', input: { reason: '回归了' } });
  });

  it('解决必须填处理说明：填了发 {name: resolve, input: {resolution}}', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: ['resolve'] })];
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('row-transition-resolve', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const submit = within(dialog).getByRole('button', {
      name: enUS.quality.tickets.actions.resolve,
    });
    expect(submit, '没有处理说明时不能提交').toBeDisabled();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: enUS.quality.resolve.resolution }),
      '换了密封圈',
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(
        callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST'),
      ).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')[0]!.json,
    ).toEqual({ name: 'resolve', input: { resolution: '换了密封圈' } });
  });

  it('关闭带备注：发 {name: close, input: {note}}', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: ['close'] })];
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('row-transition-close', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: enUS.quality.close.note }),
      '质量核实通过',
    );
    // 提交键在对话框底部；对话框右上角还有一个同名的 sr-only 关闭键，要避开。
    const footer = dialog.querySelector(
      '[data-slot="dialog-footer"]',
    ) as HTMLElement;
    await userEvent.click(
      within(footer).getByRole('button', { name: enUS.quality.tickets.actions.close }),
    );
    await waitFor(() =>
      expect(
        callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST'),
      ).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')[0]!.json,
    ).toEqual({ name: 'close', input: { note: '质量核实通过' } });
  });

  it('受理时选了同事：请求带 assigneeId', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: ['accept'] })];
    answer = (call) => {
      if (call.path === 'quality/ticket-candidates') {
        return {
          data: [{ id: 'u-9', name: '王五', username: 'wangwu' }],
          meta: { total: 1 },
        };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('row-transition-accept', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.type(
      within(dialog).getByRole('searchbox', { name: enUS.quality.accept.assignee }),
      '王',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.quality.candidates.search }),
    );
    await userEvent.click(
      await within(dialog).findByRole('button', { name: '王五' }, SLOW),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.quality.tickets.actions.accept }),
    );
    await waitFor(() =>
      expect(
        callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST'),
      ).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/transitions`, 'POST')[0]!.json,
    ).toEqual({ name: 'accept', input: { assigneeId: 'u-9' } });
  });
});

describe('R-003 工单详情', () => {
  it('详情带确认记录与流转历史，页面上不出现账号 id', async () => {
    permissions = fqcGrant('view');
    ticketsData = [ticket()];
    answer = (call) => {
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return {
          data: detailOf(call2Ticket(call.path), {
            reviews: [
              {
                id: 'r-1',
                screeningId: SCREENING_ID,
                kind: 'dispatch',
                category: 'dimension',
                severity: 'minor',
                departmentId: DEPARTMENT_ID,
                actorId: 'actor-uuid-0001',
                actorName: '王质检',
                createdAt: '2026-11-24T12:00:00.000Z',
              },
            ],
            transitions: [
              {
                id: 'tr-1',
                name: 'accept',
                fromState: 'open',
                toState: 'in_progress',
                actorName: '王质检',
                createdAt: '2026-11-24T13:00:00.000Z',
              },
            ],
          }),
        };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const review = await within(dialog).findByTestId(
      'ticket-review-record',
      {},
      SLOW,
    );
    expect(review).toHaveTextContent('王质检');
    expect(review, '确认行不出现账号 id').not.toHaveTextContent('actor-uuid-0001');
    const transition = await within(dialog).findByTestId(
      'ticket-transition-record',
      {},
      SLOW,
    );
    expect(transition).toHaveTextContent(enUS.quality.tickets.actions.accept);
    expect(transition).toHaveTextContent(enUS.quality.states.in_progress);
    expect(transition).toHaveTextContent('王质检');
  });

  it('改判走确认端点的改判分支，把类别与严重度发给 review', async () => {
    permissions = fqcGrant('view', 'handle');
    ticketsData = [ticket({ screeningId: SCREENING_ID, canTransition: [] })];
    let rejudged = false;
    answer = (call) => {
      if (
        call.path === `quality/screenings/${SCREENING_ID}/review` &&
        call.method === 'POST'
      ) {
        rejudged = true;
        return { data: screening({ outcome: 'reviewed' }) };
      }
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.click(within(dialog).getByTestId('rejudge'));
    const rejudgeDialog = (await screen.findAllByRole('dialog', {}, SLOW)).at(-1)!;
    await userEvent.click(
      within(rejudgeDialog).getByRole('button', { name: enUS.quality.rejudge.submit }),
    );
    await waitFor(() => expect(rejudged).toBe(true));
    expect(
      callsTo(`quality/screenings/${SCREENING_ID}/review`, 'POST')[0]!.json,
    ).toEqual({ category: 'dimension', severity: 'minor' });
  });

  it('改经办人：搜同事按部门查，选中后 POST assignee；页面只显示姓名不显示用户名', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: [] })];
    answer = (call) => {
      if (call.path === 'quality/ticket-candidates') {
        expect(call.query?.departmentId).toBe(DEPARTMENT_ID);
        // 两行：一行有姓名，一行只有用户名 —— 页面只许显示姓名与占位。
        return {
          data: [
            { id: 'u-9', name: '王五', username: 'wangwu' },
            { id: 'u-10', name: null, username: 'li-si' },
          ],
          meta: { total: 2 },
        };
      }
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.click(within(dialog).getByTestId('change-assignee'));
    const assigneeDialog = (await screen.findAllByRole('dialog', {}, SLOW)).at(-1)!;
    await userEvent.type(
      within(assigneeDialog).getByRole('searchbox', {
        name: enUS.quality.tickets.assigneeLabel,
      }),
      '王',
    );
    await userEvent.click(
      within(assigneeDialog).getByRole('button', { name: enUS.quality.candidates.search }),
    );
    const candidateWang = await within(assigneeDialog).findByRole(
      'button',
      { name: '王五' },
      SLOW,
    );
    expect(within(candidateWang).queryByText('wangwu')).not.toBeInTheDocument();
    expect(
      await within(assigneeDialog).findByText(
        enUS.quality.candidates.noName,
        {},
        SLOW,
      ),
    ).toBeVisible();
    expect(within(assigneeDialog).queryByText('li-si')).not.toBeInTheDocument();
    // 选中「只有用户名」的那位：选中区只能显示占位，用户名不许露出来
    //（这条抓得住把选中显示改回 `name ?? username` 的变异）。
    await userEvent.click(
      within(assigneeDialog).getByRole('button', {
        name: enUS.quality.candidates.noName,
      }),
    );
    expect(
      await within(assigneeDialog).findByText(enUS.quality.candidates.noName),
    ).toBeVisible();
    expect(
      within(assigneeDialog).queryByText('li-si'),
      '选中之后显示路径里不能出现用户名',
    ).not.toBeInTheDocument();
    // 换回有姓名的那位，保存仍是他的 id。
    await userEvent.click(
      within(assigneeDialog).getByRole('button', { name: enUS.quality.candidates.clear }),
    );
    await userEvent.click(
      await within(assigneeDialog).findByRole('button', { name: '王五' }, SLOW),
    );
    await userEvent.click(
      within(assigneeDialog).getByRole('button', { name: enUS.quality.changeAssignee.submit }),
    );
    await waitFor(() =>
      expect(callsTo(`quality/tickets/${TICKET_ID}/assignee`, 'POST')).toHaveLength(1),
    );
    expect(
      callsTo(`quality/tickets/${TICKET_ID}/assignee`, 'POST')[0]!.json,
    ).toEqual({ assigneeId: 'u-9' });
  });

  it('已关闭的工单没有改判入口：先重开才能改判', async () => {
    permissions = fqcGrant('view', 'handle');
    ticketsData = [
      ticket({
        state: 'closed',
        closedAt: '2026-11-24T14:00:00.000Z',
        screeningId: SCREENING_ID,
        canTransition: ['reopen'],
      }),
    ];
    answer = (call) => {
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(
      await within(dialog).findByTestId('transition-reopen', {}, SLOW),
    ).toBeVisible();
    expect(
      within(dialog).queryByTestId('rejudge'),
      '已关闭的工单不该让人点了才知道不能改判',
    ).not.toBeInTheDocument();
  });

  it('只持「处理工单」的人没有改判入口（改判要持「处理」）', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [
      ticket({ screeningId: SCREENING_ID, canTransition: [] }),
    ];
    answer = (call) => {
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(
      await within(dialog).findByTestId('change-assignee', {}, SLOW),
    ).toBeVisible();
    expect(within(dialog).queryByTestId('rejudge')).not.toBeInTheDocument();
  });
});

describe('R-003 帮手', () => {
  it('相似工单不带描述；处理建议为空时如实显示等模型接入', async () => {
    permissions = fqcGrant('view', 'ticket');
    ticketsData = [ticket({ canTransition: [] })];
    answer = (call) => {
      if (call.path === `quality/tickets/${TICKET_ID}/assist`) {
        return {
          data: {
            similar: [
              {
                code: 'FQC-00000009',
                title: 'dimension / major',
                category: 'dimension',
                severity: 'major',
                resolution: '换了模具',
                closedAt: '2026-11-20T08:00:00.000Z',
                // 服务端不该回；页面也不许把它显示出来。
                description: 'SECRET-CUSTOMER-TEXT',
              },
            ],
            suggestion: null,
            engine: 'none',
          },
        };
      }
      if (call.path === `quality/tickets/${TICKET_ID}`) {
        return { data: detailOf(call2Ticket(call.path)) };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    await userEvent.click(
      await screen.findByRole('button', { name: enUS.quality.tickets.detail }, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const assist = await within(dialog).findByTestId('assist-section', {}, SLOW);
    expect(
      await within(assist).findByText('FQC-00000009', {}, SLOW),
    ).toBeVisible();
    expect(within(assist).getByText('换了模具')).toBeVisible();
    expect(
      within(assist).queryByText('SECRET-CUSTOMER-TEXT'),
      '相似工单不许显示描述',
    ).not.toBeInTheDocument();
    expect(
      within(assist).getByText(enUS.quality.assist.suggestionPending),
    ).toBeVisible();
    expect(within(assist).queryByText('none')).not.toBeInTheDocument();
  });
});

describe('R-003 派单规则', () => {
  it('只持「查看」的人看得到规则，看不到编辑入口', async () => {
    await renderQuality();

    const card = await screen.findByTestId('routing-rules-card', {}, SLOW);
    // 七行数据行：每个类别一行，没配规则的如实显示「不指派」。
    await within(card).findByText(enUS.quality.categories.dimension, {}, SLOW);
    expect(within(card).getAllByText('Assembly')).toHaveLength(1);
    expect(within(card).getAllByText(enUS.quality.routingRules.unset)).toHaveLength(6);
    expect(
      screen.queryByTestId('routing-rules-edit'),
      '没有「维护派单规则」就没有编辑入口',
    ).not.toBeInTheDocument();
  });

  it('持「维护派单规则」的人有编辑入口；骨架行与数据行同结构；保存一次 PUT 七行', async () => {
    permissions = fqcGrant('view', 'configure');
    let releaseRules: () => void = () => {};
    const rulesGate = new Promise<Record<string, unknown>>((resolve) => {
      releaseRules = () =>
        resolve({ data: routingRules });
    });
    let releaseDepartments: () => void = () => {};
    const departmentsGate = new Promise<void>((resolve) => {
      releaseDepartments = resolve;
    });
    answer = (call) => {
      if (call.path === 'quality/routing-rules' && call.method === 'GET') {
        return rulesGate;
      }
      if (call.path === 'quality/routing-rules' && call.method === 'PUT') {
        return { data: routingRules };
      }
      if (call.path === 'quality/ticket-departments') {
        // 扣住部门请求：编辑框挂载时 enabled=false，点「编辑」才发请求。
        return departmentsGate.then(
          () => new Response(null, { status: 404 }),
        );
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    // 骨架态：七行占位，行结构与落定后的数据行一字不差（高度差为 0）。
    const card = await screen.findByTestId('routing-rules-card', {}, SLOW);
    const skeletonRows = card.querySelectorAll('div[aria-hidden="true"]');
    expect(skeletonRows, '骨架行铺满七个类别').toHaveLength(7);
    const skeletonClassName = skeletonRows[0]!.className;

    await act(async () => releaseRules());
    await waitFor(() =>
      expect(card.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0),
    );
    const dataRow = within(card).getByText(
      enUS.quality.categories.appearance,
    ).closest('div') as HTMLElement;
    expect(
      dataRow.className,
      '数据行的行类要和骨架行一字不差',
    ).toBe(skeletonClassName);

    // 编辑：把外观指到同一个部门，保存一次 PUT 写全七行。编辑态就在卡片里。
    await userEvent.click(
      await screen.findByTestId('routing-rules-edit', {}, SLOW),
    );
    // 部门请求在途：请求没落定，那句「读不到部门清单」不许先冒出来。
    // 下面两条故意同步查：这条测试守的就是「点开编辑的下一帧不能误报空态」，
    // await 一次落定就把要抓的窗口放过去了。
    expect(
      // 豁免理由见上两行注释：守的就是「点开编辑的下一帧不能误报空态」。
      // eslint-disable-next-line app-local/no-sync-query-after-action -- 查的是组件本地 state，交互后同步重渲染，不依赖异步请求
      within(card).getByRole('button', { name: enUS.quality.routingRules.save }),
    ).toBeVisible();
    expect(
      // 同上：空态说明在请求落定前不许出现，所以这里也故意同步查。
      // eslint-disable-next-line app-local/no-sync-query-after-action -- 查的是组件本地 state，交互后同步重渲染，不依赖异步请求
      within(card).queryByText(enUS.quality.departmentsUnavailable),
    ).not.toBeInTheDocument();
    // 落定后（这条 mock 的是 404）：下拉读不到就给一句说明，不弹错也不假装有选项。
    await act(async () => releaseDepartments());
    expect(
      await within(card).findByText(
        enUS.quality.departmentsUnavailable,
        {},
        SLOW,
      ),
    ).toBeVisible();
    await userEvent.click(
      within(card).getByRole('button', { name: enUS.quality.routingRules.save }),
    );
    await waitFor(() =>
      expect(callsTo('quality/routing-rules', 'PUT')).toHaveLength(1),
    );
    const put = callsTo('quality/routing-rules', 'PUT')[0]!;
    const rules = (put.json as { rules: readonly Record<string, unknown>[] }).rules;
    expect(rules).toHaveLength(7);
    expect(rules.map((rule) => rule.category)).toEqual([
      'appearance',
      'dimension',
      'function',
      'packaging',
      'material',
      'process',
      'other',
    ]);
    for (const rule of rules) {
      expect(rule).toHaveProperty('departmentId');
    }
  });
});

describe('R-003 确认并派单', () => {
  it('未派单的草稿有派单按钮；部门来自窄端点，选了随请求发出去，成功后刷新', async () => {
    permissions = fqcGrant('view', 'handle');
    screeningsData = [screening()];
    let dispatched = false;
    answer = (call) => {
      if (
        call.path === `quality/screenings/${SCREENING_ID}/dispatch` &&
        call.method === 'POST'
      ) {
        dispatched = true;
        return {
          data: ticket({
            id: 't-new',
            screeningId: SCREENING_ID,
            state: 'open',
          }),
        };
      }
      if (call.path === 'quality/ticket-departments') {
        return { data: [{ id: DEPARTMENT_ID, title: 'Assembly' }] };
      }
      return defaultAnswer(call);
    };
    await renderQuality();

    const dispatchButton = await screen.findByTestId('dispatch-button', {}, SLOW);
    expect(dispatchButton).toBeVisible();
    const readsBefore = callsTo('quality/tickets', 'GET').length;

    await userEvent.click(dispatchButton);
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    // 责任部门下拉来自 `GET /quality/ticket-departments`：选一个再提交。
    await userEvent.click(
      await within(dialog).findByRole(
        'combobox',
        { name: enUS.quality.dispatch.department },
        SLOW,
      ),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'Assembly' }, SLOW),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.quality.dispatch.submit }),
    );
    await waitFor(() => expect(dispatched).toBe(true));
    expect(
      callsTo(`quality/screenings/${SCREENING_ID}/dispatch`, 'POST')[0]!.json,
    ).toEqual({
      category: 'dimension',
      severity: 'minor',
      departmentId: DEPARTMENT_ID,
    });
    // 成功之后刷新工单列表：统计与「已派单」的判断都吃这份新数据。
    await waitFor(() =>
      expect(callsTo('quality/tickets', 'GET').length).toBeGreaterThan(readsBefore),
    );
  });

  it('草稿没给类别与严重度时提交被禁用；部门读不到时给一句说明', async () => {
    permissions = fqcGrant('view', 'handle');
    screeningsData = [
      screening({ category: null, severity: null, summary: 'A bare draft' }),
    ];
    await renderQuality();

    await userEvent.click(
      await screen.findByTestId('dispatch-button', {}, SLOW),
    );
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    const submit = within(dialog).getByRole('button', {
      name: enUS.quality.dispatch.submit,
    });
    expect(submit, '类别与严重度没选好之前不能提交').toBeDisabled();
    expect(
      await within(dialog).findByText(
        enUS.quality.departmentsUnavailable,
        {},
        SLOW,
      ),
      '部门端点没给数据时在下拉旁给一句说明',
    ).toBeVisible();
    expect(
      callsTo(`quality/screenings/${SCREENING_ID}/dispatch`, 'POST'),
    ).toHaveLength(0);
  });

  it('已派单的草稿不再有派单按钮，未派单的仍有', async () => {
    permissions = fqcGrant('view', 'handle');
    screeningsData = [
      screening({ id: 's-dispatched', summary: 'Already a ticket' }),
      screening({ id: 's-fresh', summary: 'Still a draft' }),
    ];
    ticketsData = [ticket({ id: 't-old', screeningId: 's-dispatched' })];
    await renderQuality();

    expect(
      await screen.findByText('Still a draft', {}, SLOW),
    ).toBeVisible();
    expect(
      screen.getAllByTestId('dispatch-button'),
      '只有未派单的草稿有派单按钮',
    ).toHaveLength(1);
    const withButton = screen
      .getAllByTestId('dispatch-button')[0]!
      .closest('li') as HTMLElement;
    expect(within(withButton).getByText('Still a draft')).toBeVisible();
  });
});

describe('R-003 工单筛选', () => {
  it('状态筛选与搜索把参数带给列表端点', async () => {
    permissions = fqcGrant('view');
    ticketsData = [];
    await renderQuality();
    expect(await screen.findByText(enUS.quality.tickets.empty, {}, SLOW)).toBeVisible();

    await userEvent.click(
      await screen.findByRole('combobox', { name: enUS.quality.tickets.filters.state }, SLOW),
    );
    await userEvent.click(
      await screen.findByRole(
        'option',
        { name: enUS.quality.states.in_progress },
        SLOW,
      ),
    );
    await waitFor(() => {
      const calls = callsTo('quality/tickets', 'GET').filter(
        (call) => call.query?.state === 'in_progress',
      );
      expect(calls.length, '状态筛选要带上 state 参数').toBeGreaterThan(0);
    });

    await userEvent.type(
      screen.getByRole('searchbox', { name: enUS.quality.tickets.filters.q }),
      'FQC-7',
    );
    await waitFor(() => {
      const calls = callsTo('quality/tickets', 'GET').filter(
        (call) => call.query?.q === 'FQC-7',
      );
      expect(calls.length, '搜索要带上 q 参数').toBeGreaterThan(0);
    });
  });
});

/** 详情端点按路径取夹具里的那一行工单；这里只把 id 拆出来。 */
function call2Ticket(path: string): Record<string, unknown> {
  const row = ticketsData.find((item) => path === `quality/tickets/${item.id}`);
  if (!row) throw new Error(`No ticket fixture for ${path}`);
  return row;
}

function defaultAnswer(call: ApiCall): Answer {
  if (call.path === 'authorization/permissions') return { data: permissions };
  if (call.path === 'quality/tickets')
    return { data: ticketsData, meta: { total: ticketsData.length } };
  if (call.path === 'quality/messages') return { data: [], meta: { total: 0 } };
  if (call.path === 'quality/screenings')
    return { data: screeningsData, meta: { total: screeningsData.length } };
  if (call.path === 'quality/drafting/stats') return { data: stats() };
  if (call.path === 'quality/routing-rules') return { data: routingRules };
  return new Response(null, { status: 404 });
}
