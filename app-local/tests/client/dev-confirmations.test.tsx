import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ConfirmationsPage from '../../client/extensions/dev-confirmations/index.js';
import type { ConfirmationSnapshot } from '../../client/extensions/dev-confirmations/model.js';
import {
  cardRenderCount,
  resetCardRenderCounts,
} from '../../client/extensions/dev-confirmations/perf.js';
import {
  appendAnswer,
  appendClarification,
  buildSnapshot,
  type ConfirmationQuestion,
  type ConfirmationState,
} from '../../server/dev-tools/confirmations.js';
import { FIXTURE_QUESTIONS, FIXTURE_STATE } from '../fixtures/confirmations.js';
import { createAuthenticatedClientRenderer } from '../helpers/authenticated-client.js';

/**
 * R-083 重做后的待确认事项页。页面连的是被拦截的 fetch，不碰真应用。
 *
 * 结构：页头进度图与三块计数、分组芯片、分段按钮、选项磁贴、收成一行的已答复行、完成态；
 * 行为：磁贴点选、「自己写」展开输入框、数字键选选项、Ctrl/⌘+Enter 提交、提交后跳到下一道、
 * 已答复行上「改」。夹具四条：两条待确认（单选 / 填空）、一条已答复、一条已处理。
 *
 * 提交后的快照与真端点一样由 `buildSnapshot` 算出：答过的进「已答复待处理」；
 * 已处理的条目再答一次仍在「已处理」里（已处理优先于已答复，答复删不掉处理状态）。
 */

const NOW = '2026-11-28T00:00:00+08:00';

function json(data: ConfirmationSnapshot, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 一个文件只起一次测试应用：每条测试仍有自己的用户、会话与登录态，少占共享机器的负载。
const renderClient = createAuthenticatedClientRenderer();

interface Posted {
  readonly id: string;
  readonly body: { answer: string; note?: string };
}

async function renderConfirmations(
  initial: ConfirmationSnapshot = SNAPSHOT,
  questions: readonly ConfirmationQuestion[] = FIXTURE_QUESTIONS,
  baseState: ConfirmationState = FIXTURE_STATE,
) {
  let state = baseState;
  let current = initial;
  const posted: Posted[] = [];
  await renderClient(<ConfirmationsPage />, {
    afterResponse: async (request, response) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.endsWith('/dev/confirmations')) {
        return json(current);
      }
      const match = /\/dev\/confirmations\/([^/]+)\/answers$/u.exec(pathname);
      if (request.method === 'POST' && match) {
        const body = (await request.clone().json()) as {
          answer: string;
          note?: string;
        };
        const id = match[1] ?? '';
        posted.push({ id, body });
        state = appendAnswer(state, id, body.answer, body.note ?? '', NOW);
        current = snapshotOf(state, questions);
        return json(current, 201);
      }
      return response;
    },
  });
  return posted;
}

function snapshotOf(
  state: ConfirmationState = FIXTURE_STATE,
  questions: readonly ConfirmationQuestion[] = FIXTURE_QUESTIONS,
): ConfirmationSnapshot {
  return buildSnapshot(questions, state, NOW);
}

const SNAPSHOT = snapshotOf();

/** 40 道待确认的夹具（编号用 QA-xx，不冒充真实需求编号）：用来量首屏挂载数与分页行为。 */
const MANY_QUESTIONS: readonly ConfirmationQuestion[] = Array.from(
  { length: 40 },
  (_, index) => ({
    id: `QA-${String(index + 10).padStart(2, '0')}`,
    topic: index % 2 === 0 ? 'ALPHA' : 'BETA',
    question: `夹具：第 ${index + 1} 道题`,
    default: '按默认',
    options: ['甲', '乙', '其他'],
    source: 'HANDOFF/tasks/waiting-on-user.md',
  }),
);
const MANY_EMPTY_STATE: ConfirmationState = { answers: [], processed: {} };
const MANY_SNAPSHOT = snapshotOf(MANY_EMPTY_STATE, MANY_QUESTIONS);

const checked = (scope: HTMLElement): number =>
  scope.querySelectorAll('[role=radio][aria-checked=true]').length;

function keyDown(target: Element, key: string, ctrl = false): void {
  fireEvent.keyDown(target, { key, ctrlKey: ctrl });
}

/** 填空题的「自己写」：先点磁贴，输入框才出现。 */
async function openOwn(form: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(form).getByText('Other (write your own)'));
  return await within(form).findByRole(
    'textbox',
    { name: 'Your answer' },
    { timeout: 15_000 },
  );
}

describe('待确认事项页：页头进度与计数', () => {
  it('进度条与「已答 / 共」、三块计数磁贴对得上夹具', async () => {
    await renderConfirmations();
    const bar = await screen.findByRole(
      'progressbar',
      { name: 'Answered 2 of 4' },
      { timeout: 15_000 },
    );
    // 夹具四条：已答复一条、已处理一条，都已答。
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Answered 2 of 4')).toBeInTheDocument();
    expect(screen.getByTestId('count-pending')).toHaveTextContent('2');
    expect(screen.getByTestId('count-answered')).toHaveTextContent('1');
    expect(screen.getByTestId('count-processed')).toHaveTextContent('1');
    expect(
      screen.getByText(
        'Unanswered items follow the default; an answer replaces it.',
      ),
    ).toBeInTheDocument();
  });

  it('页头写明两个快捷键', async () => {
    await renderConfirmations();
    await screen.findByRole(
      'progressbar',
      { name: 'Answered 2 of 4' },
      { timeout: 15_000 },
    );
    expect(screen.getByTestId('shortcut-pick')).toHaveTextContent('1–9');
    expect(screen.getByTestId('shortcut-submit')).toHaveTextContent('Enter');
  });
});

describe('待确认事项页：问题卡与选项磁贴', () => {
  it('单选渲染成磁贴：三个选项、一个「默认」小标、没有原生下拉', async () => {
    await renderConfirmations();
    const single = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    expect(within(single).getAllByRole('radio')).toHaveLength(3);
    expect(within(single).getByText('本地盘')).toBeInTheDocument();
    expect(within(single).getAllByText('Default')).toHaveLength(1);
    expect(
      within(single).getByText('Current default: 本地盘。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(single).getByText('Source')).toBeInTheDocument();
    // 来源不再把整条路径铺在页面上。
    expect(
      within(single).queryByText('HANDOFF/tasks/waiting-on-user.md'),
    ).not.toBeInTheDocument();
  });

  it('磁贴里不画圆形单选点：单选原语只留读屏，选中看边框、底色和对勾', async () => {
    await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    const radios = within(card).getAllByRole('radio');
    for (const radio of radios) expect(radio).toHaveClass('sr-only');
    const tileOf = (index: number): HTMLElement | null =>
      radios[index]?.closest('label') ?? null;
    expect(tileOf(0)?.querySelector('.lucide-check')).toBeInTheDocument();
    fireEvent.click(within(card).getByText('对象存储'));
    await waitFor(() => {
      expect(tileOf(1)).toHaveClass('has-data-checked:border-primary');
    });
    expect(
      tileOf(1)?.querySelector('.lucide-check')?.getAttribute('class') ?? '',
    ).toContain('peer-aria-checked:opacity-100');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(
      within(tileOf(0) as HTMLElement).getByText('本地盘'),
    ).toBeInTheDocument();
  });

  it('「默认」小标认的是清单里的「（默认）」标记：标在第二块就落在第二块，文字里不再重复', async () => {
    // 真清单 51 道单选题都带这个标记；夹具没有，所以这里另造一份。
    const marked: ConfirmationSnapshot = {
      ...SNAPSHOT,
      questions: SNAPSHOT.questions.map((item) =>
        item.id === 'QA-01'
          ? {
              ...item,
              options: ['本地盘', '对象存储（默认）', '其他', '归档（默认）'],
            }
          : item,
      ),
    };
    await renderConfirmations(marked);
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    const tiles = within(card).getAllByRole('radio');
    expect(tiles).toHaveLength(4);
    expect(within(card).getByText('对象存储')).toBeInTheDocument();
    expect(
      within(card).queryByText('对象存储（默认）'),
    ).not.toBeInTheDocument();
    // 小标只有一枚，贴在带标记的第二块磁贴里。
    const badges = within(card).getAllByText('Default');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest('label')).toBe(tiles[1]?.closest('label'));
    expect(tiles[0]?.closest('label')).not.toContainElement(badges[0] ?? null);
  });

  it('填空题也是两块磁贴：「按默认提交」（副标题是当前默认的第一句）与「自己写」，不出输入框', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    const free = screen.getByTestId('pending-QA-02');
    expect(within(free).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(free).getByText('Submit the default')).toBeInTheDocument();
    expect(within(free).getByText('不能改原单。')).toBeInTheDocument();
    expect(
      within(free).getByText('Other (write your own)'),
    ).toBeInTheDocument();
    expect(
      within(free)
        .getAllByTestId('tile-key')
        .map((node) => node.textContent),
    ).toEqual(['1', '2']);
    fireEvent.click(within(free).getByText('Other (write your own)'));
    expect(
      await within(free).findByRole(
        'textbox',
        { name: 'Your answer' },
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
  });

  it('填空题「按默认提交」不打字：提交的是当前默认全文，备注记「按默认」', async () => {
    const posted = await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    const free = screen.getByTestId('pending-QA-02');
    fireEvent.click(within(free).getByText('Submit the default'));
    fireEvent.click(
      within(free).getByRole('button', { name: /submit and go to next/i }),
    );
    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-02', body: { answer: '不能改原单。', note: '按默认' } },
      ]);
    });
    expect(
      await screen.findByTestId('answered-QA-02', {}, { timeout: 15_000 }),
    ).toHaveTextContent('不能改原单。');
  });

  it('填空题按数字键 1、2 对应两块磁贴', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    const free = screen.getByTestId('pending-QA-02');
    keyDown(free, '1');
    await waitFor(() => {
      expect(
        within(free).getByRole('button', { name: /submit and go to next/i }),
      ).toBeEnabled();
    });
    expect(within(free).queryByRole('textbox')).not.toBeInTheDocument();
    keyDown(free, '2');
    expect(
      await within(free).findByRole(
        'textbox',
        { name: 'Your answer' },
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
  });

  it('点磁贴即选中；「自己写」是最后一块，选中才展开输入框，自写内容进备注', async () => {
    const posted = await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    const tiles = within(card).getAllByRole('radio');
    fireEvent.click(within(card).getByText('对象存储'));
    expect(checked(card)).toBe(1);
    expect(tiles[1]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(card).getByText('Other (write your own)'));
    await waitFor(() => {
      expect(checked(card)).toBe(1);
      expect(tiles[2]).toHaveAttribute('aria-checked', 'true');
    });
    const own = within(card).getByRole('textbox', { name: 'Your answer' });
    fireEvent.change(own, { target: { value: '放分布式文件系统' } });
    fireEvent.click(
      within(card).getByRole('button', { name: /submit and go to next/i }),
    );
    // 存储格式不变：「其他」按固定的选项值提交，自写内容进备注。
    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-01', body: { answer: '其他', note: '放分布式文件系统' } },
      ]);
    });
    expect(
      await screen.findByTestId('answered-QA-01', {}, { timeout: 15_000 }),
    ).toHaveTextContent('放分布式文件系统');
  });

  it('「其他」不再同时显示成两个选中：数据里的「其他」与页面追加的合成一块', async () => {
    await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    // 夹具的选项自带「其他」：页面不再追加第二块同值的磁贴，所以只有三块。
    expect(within(card).getAllByText('Other (write your own)')).toHaveLength(1);
    expect(checked(card)).toBe(0);
    fireEvent.click(within(card).getByText('Other (write your own)'));
    expect(checked(card)).toBe(1);
  });

  it('提交后这张卡收成一行（编号、问题、已答内容、「改」），并跳到下一道未答的', async () => {
    const posted = await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(card).getByText('本地盘'));
    fireEvent.click(
      within(card).getByRole('button', { name: /submit and go to next/i }),
    );

    const row = await screen.findByTestId(
      'answered-QA-01',
      {},
      { timeout: 15_000 },
    );
    expect(row).toHaveTextContent('QA-01');
    expect(row).toHaveTextContent('文件放本地盘还是对象存储');
    expect(row).toHaveTextContent('本地盘');
    expect(
      within(row).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-01', body: { answer: '本地盘', note: '' } },
      ]);
    });

    // 焦点落到下一道未答的卡上，数字键从它开始生效。
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('pending-QA-02'));
    });
  });

  it('答完后没有下一道时按钮只写「提交」', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    // 只看 ALPHA 这一组：它是这一组里最后一道。
    fireEvent.click(screen.getByRole('button', { name: 'ALPHA 1' }));
    const alone = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    expect(
      within(alone).getByRole('button', { name: /^submit$/i }),
    ).toBeInTheDocument();
  });

  it('当前范围里都答完显示居中的完成态，并写明还剩多少按默认处理', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: 'ALPHA 1' }));
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(card).getByText('对象存储'));
    fireEvent.click(within(card).getByRole('button', { name: /^submit$/i }));
    const done = await screen.findByTestId('all-done', {}, { timeout: 15_000 });
    expect(done).toHaveTextContent('All answered');
    // QA-02 没答，仍按默认处理。
    expect(done).toHaveTextContent('Left to default: 1');
    expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
  });
});

describe('待确认事项页：键盘', () => {
  it('数字键 1–9 选中对应磁贴，磁贴上显示它的数字', async () => {
    await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    const radios = () => within(card).getAllByRole('radio');
    expect(
      within(card)
        .getAllByTestId('tile-key')
        .map((node) => node.textContent),
    ).toEqual(['1', '2', '3']);
    keyDown(card, '2');
    await waitFor(() => {
      expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    });
    keyDown(card, '1');
    await waitFor(() => {
      expect(checked(card)).toBe(1);
      expect(radios()[0]).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('输入框里按数字不算选选项', async () => {
    await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(card).getByText('Other (write your own)'));
    const own = await within(card).findByRole(
      'textbox',
      { name: 'Your answer' },
      { timeout: 15_000 },
    );
    // 在输入框里敲 1：选中的仍是「自己写」，第 1 块磁贴不被选上。
    fireEvent.keyDown(own, { key: '1' });
    await waitFor(() => {
      const radios = within(card).getAllByRole('radio');
      expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    });
    expect(within(card).getAllByRole('radio')[0]).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(checked(card)).toBe(1);
  });

  it('Ctrl+Enter 提交当前这道没答的卡', async () => {
    const posted = await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    keyDown(card, '2');
    keyDown(card, 'Enter', true);
    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-01', body: { answer: '对象存储', note: '' } },
      ]);
    });
  });

  it('在「改」的卡里、光标停在输入框时，Ctrl+Enter 提交这张卡', async () => {
    const posted = await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const row = await screen.findByTestId(
      'processed-QA-04',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId(
      'answer-form-QA-04',
      {},
      { timeout: 15_000 },
    );
    const own = await openOwn(form);
    fireEvent.change(own, { target: { value: '改成内审也能看' } });
    // 贴近真实事件：按键落在输入框上，再冒泡到页面。
    fireEvent.keyDown(own, { key: 'Enter', code: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-04', body: { answer: '改成内审也能看', note: '' } },
      ]);
    });
  });

  it('⌘+Enter（metaKey）同样提交「改」的卡', async () => {
    const posted = await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const row = await screen.findByTestId(
      'answered-QA-03',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId(
      'answer-form-QA-03',
      {},
      { timeout: 15_000 },
    );
    const radios = within(form).getAllByRole('radio');
    keyDown(radios[0] as Element, '1');
    await waitFor(() => {
      expect(within(form).getAllByRole('radio')[0]).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    fireEvent.keyDown(radios[0] as Element, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(posted).toHaveLength(1);
      expect(posted[0]?.id).toBe('QA-03');
    });
  });

  it('「跳过」不清草稿，焦点移到下一道', async () => {
    await renderConfirmations();
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    keyDown(card, '1');
    fireEvent.click(within(card).getByRole('button', { name: 'Skip' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('pending-QA-02'));
    });
    expect(within(card).getAllByRole('radio')[0]).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('待确认事项页：分组芯片、分段按钮与已答复行', () => {
  it('提交最后一道后焦点落在完成态上，不掉回 body', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: 'ALPHA 1' }));
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(card).getByText('对象存储'));
    fireEvent.click(within(card).getByRole('button', { name: /^submit$/i }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('all-done'));
    });
  });

  it('在「改」的卡里提交后，焦点落到当前范围第一道没答的卡', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));
    const row = await screen.findByTestId(
      'processed-QA-04',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId(
      'answer-form-QA-04',
      {},
      { timeout: 15_000 },
    );
    fireEvent.change(await openOwn(form), {
      target: { value: '改成内审也能看' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /^submit$/i }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('pending-QA-01'));
    });
  });

  it('当前范围里没有下一道也没有完成态（「已答复」里改一条）时，焦点落在刚答完的那一行上', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const row = await screen.findByTestId(
      'processed-QA-04',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId(
      'answer-form-QA-04',
      {},
      { timeout: 15_000 },
    );
    const own = await openOwn(form);
    fireEvent.change(own, { target: { value: '再答一次' } });
    fireEvent.click(within(form).getByRole('button', { name: /^submit$/i }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId('processed-QA-04'),
      );
    });
    expect(screen.queryByTestId('all-done')).not.toBeInTheDocument();
  });

  it('分组芯片带计数、点哪个只看哪个；计数口径与页头「共 N」一致（含已处理）', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    // 夹具四条、已处理那条也算：全部 4，各分组 1。
    expect(screen.getByRole('button', { name: 'All 4' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const chip of ['ALPHA 1', 'BETA 1', 'GAMMA 1', 'DELTA 1']) {
      expect(screen.getByRole('button', { name: chip })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: 'BETA 1' }));
    expect(
      await screen.findByTestId('pending-QA-02', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BETA 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'All 4' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('分组小节可折叠，标题带计数与「已答 / 总数」细进度条', async () => {
    await renderConfirmations();
    const section = await screen.findByTestId(
      'topic-section-ALPHA',
      {},
      { timeout: 15_000 },
    );
    expect(section).toHaveTextContent('ALPHA');
    // ALPHA 在夹具里只有一条待确认：已答 0 / 共 1。
    expect(within(section).getByTestId('topic-progress-ALPHA')).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    fireEvent.click(within(section).getByTestId('topic-toggle-ALPHA'));
    await waitFor(() => {
      expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('topic-toggle-ALPHA'));
    expect(
      await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
  });

  it('分段按钮切到「已答复」：已答复与已处理各成一行，没有待确认的卡', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    expect(
      await screen.findByTestId('answered-QA-03', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('processed-QA-04')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Answered/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('已处理条目点「改」重新答复：答复追加进去，条目仍在已处理里', async () => {
    const posted = await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const row = await screen.findByTestId(
      'processed-QA-04',
      {},
      { timeout: 15_000 },
    );
    expect(within(row).getByText('Landed')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId(
      'answer-form-QA-04',
      {},
      { timeout: 15_000 },
    );
    fireEvent.change(await openOwn(form), {
      target: { value: '改成内审也能看' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      expect(posted).toEqual([
        { id: 'QA-04', body: { answer: '改成内审也能看', note: '' } },
      ]);
    });
    expect(
      await screen.findByTestId('processed-QA-04', {}, { timeout: 15_000 }),
    ).toHaveTextContent('改成内审也能看');
  });
});

describe('待确认事项页：答过的一行', () => {
  it('收成真正的一行：问题与答复各占一个可省略的格子，宽屏同一行，细节收进悬停全文', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByRole('button', { name: /^Answered/ }));
    const row = await screen.findByTestId(
      'processed-QA-04',
      {},
      { timeout: 15_000 },
    );
    expect(within(row).getByTestId('row-question')).toHaveClass('truncate');
    expect(within(row).getByTestId('row-question')).toHaveTextContent(
      '夹具：审查由谁看？',
    );
    expect(within(row).getByTestId('row-answer')).toHaveClass('truncate');
    expect(within(row).getByTestId('row-answer')).toHaveTextContent('管理员');
    expect(row).toHaveClass('sm:flex-row', 'sm:items-center');
    expect(
      within(row).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    // 答复时刻与去处不在行里撑高度，收进悬停全文。
    expect(within(row).queryByText(/Answered at/u)).not.toBeInTheDocument();
  });
});

describe('待确认事项页：性能（打字只重渲染当前卡、首屏只挂一页）', () => {
  it('在一张卡的输入框里打字，其它卡的渲染次数不增加', async () => {
    await renderConfirmations();
    await screen.findByTestId('pending-QA-01', {}, { timeout: 15_000 });
    const card = screen.getByTestId('pending-QA-01');
    const own = await openOwn(within(card).getByTestId('answer-form-QA-01'));
    resetCardRenderCounts();
    fireEvent.change(own, { target: { value: '甲' } });
    fireEvent.change(own, { target: { value: '甲乙' } });
    await waitFor(() => {
      expect(cardRenderCount('QA-01')).toBeGreaterThan(0);
    });
    // 页面级草稿会让每敲一个字整页重渲染；现在别的卡一次都不渲染。
    expect(cardRenderCount('QA-02')).toBe(0);
  });

  it('40 道待确认：首屏只挂一页（≤15 张卡），页头与芯片仍是全量数字', async () => {
    await renderConfirmations(MANY_SNAPSHOT, MANY_QUESTIONS, MANY_EMPTY_STATE);
    await screen.findByTestId('pending-QA-10', {}, { timeout: 15_000 });
    const mounted = document.querySelectorAll('[data-question-card]');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(15);
    expect(screen.getByTestId('count-pending')).toHaveTextContent('40');
    expect(
      screen.getByRole('button', { name: 'ALPHA 20' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BETA 20' })).toBeInTheDocument();
    // 没加载的页不挂载。
    expect(screen.queryByTestId('pending-QA-34')).not.toBeInTheDocument();
  });

  it('页尾「加载更多」是常规按钮：每点一次多挂一页，加载完按钮消失', async () => {
    await renderConfirmations(MANY_SNAPSHOT, MANY_QUESTIONS, MANY_EMPTY_STATE);
    await screen.findByTestId('pending-QA-10', {}, { timeout: 15_000 });
    const cards = () => document.querySelectorAll('[data-question-card]');
    expect(cards()).toHaveLength(12);
    const more = await screen.findByRole(
      'button',
      { name: /load more/i },
      { timeout: 15_000 },
    );
    expect(more).toHaveAttribute('type', 'button');
    fireEvent.click(more);
    await waitFor(() => expect(cards()).toHaveLength(24));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(cards()).toHaveLength(36));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(cards()).toHaveLength(40));
    expect(
      screen.queryByRole('button', { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it('切分组芯片与状态分段按钮都回到第一页', async () => {
    await renderConfirmations(MANY_SNAPSHOT, MANY_QUESTIONS, MANY_EMPTY_STATE);
    await screen.findByTestId('pending-QA-10', {}, { timeout: 15_000 });
    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: /load more/i },
        { timeout: 15_000 },
      ),
    );
    await waitFor(() =>
      expect(document.querySelectorAll('[data-question-card]')).toHaveLength(
        24,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ALPHA 20' }));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-question-card]')).toHaveLength(
        12,
      ),
    );
    expect(screen.getByTestId('pending-QA-10')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-QA-11')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-question-card]')).toHaveLength(
        12,
      ),
    );
  });

  it('提交后「下一道」在还没加载的页里：自动加载到那一页再聚焦', async () => {
    const posted = await renderConfirmations(
      MANY_SNAPSHOT,
      MANY_QUESTIONS,
      MANY_EMPTY_STATE,
    );
    await screen.findByTestId('pending-QA-10', {}, { timeout: 15_000 });
    expect(document.querySelectorAll('[data-question-card]')).toHaveLength(12);
    // 第一页最后一道是 QA-32；下一道 QA-34 在第二页，提交时要先加载。
    const card = screen.getByTestId('pending-QA-32');
    fireEvent.click(within(card).getByText('甲'));
    fireEvent.click(
      within(card).getByRole('button', { name: /submit and go to next/i }),
    );
    const next = await screen.findByTestId(
      'pending-QA-34',
      {},
      { timeout: 15_000 },
    );
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(posted).toEqual([{ id: 'QA-32', body: { answer: '甲', note: '' } }]);
  });
});

/**
 * R-083 补充说明：请求写进 state.json 的 clarifications，说明由主会话写进清单的 explanations。
 * 这一组用例把 POST /clarifications 也拦下来，用与真端点同样的 buildSnapshot 算出新快照。
 * 夹具用 QA-xx，不冒充真实需求编号。
 */
interface ClarifyPosted {
  readonly id: string;
  readonly body: { note?: string };
}

const EXPLANATION = {
  at: '2026-11-28T04:00:00+08:00',
  asked: '为什么？',
  text: '第一段。\n\n第二段。\n- 要点一\n- 要点二\n<b>不是标签</b>',
};
const EXPLAINED_QUESTIONS: readonly ConfirmationQuestion[] =
  FIXTURE_QUESTIONS.map((item) =>
    item.id === 'QA-02' ? { ...item, explanations: [EXPLANATION] } : item,
  );
const AWAITING_STATE: ConfirmationState = {
  ...FIXTURE_STATE,
  clarifications: [
    { id: 'QA-02', note: '为什么？', at: '2026-11-28T03:30:00+08:00' },
  ],
};
const ANSWERED_CLARIFICATION_STATE: ConfirmationState = {
  ...FIXTURE_STATE,
  clarifications: [
    {
      id: 'QA-02',
      note: '为什么？',
      at: '2026-11-28T03:30:00+08:00',
      answeredAt: EXPLANATION.at,
    },
  ],
};
const AWAITING_SNAPSHOT = snapshotOf(AWAITING_STATE, FIXTURE_QUESTIONS);
const EXPLAINED_SNAPSHOT = snapshotOf(
  ANSWERED_CLARIFICATION_STATE,
  EXPLAINED_QUESTIONS,
);

async function renderClarifyScenario(
  initial: ConfirmationSnapshot,
  questions: readonly ConfirmationQuestion[],
  baseState: ConfirmationState,
) {
  let state = baseState;
  let current = initial;
  const answers: Posted[] = [];
  const clarifications: ClarifyPosted[] = [];
  await renderClient(<ConfirmationsPage />, {
    afterResponse: async (request, response) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.endsWith('/dev/confirmations'))
        return json(current);
      const clarify = /\/dev\/confirmations\/([^/]+)\/clarifications$/u.exec(
        pathname,
      );
      if (request.method === 'POST' && clarify) {
        const body = (await request.clone().json()) as { note?: string };
        const id = clarify[1] ?? '';
        clarifications.push({ id, body });
        state = appendClarification(state, id, body.note ?? '', NOW);
        current = snapshotOf(state, questions);
        return json(current, 201);
      }
      const answer = /\/dev\/confirmations\/([^/]+)\/answers$/u.exec(pathname);
      if (request.method === 'POST' && answer) {
        const body = (await request.clone().json()) as {
          answer: string;
          note?: string;
        };
        const id = answer[1] ?? '';
        answers.push({ id, body });
        state = appendAnswer(
          state,
          id,
          body.answer,
          body.note ?? '',
          NOW,
        );
        current = snapshotOf(state, questions);
        return json(current, 201);
      }
      return response;
    },
  });
  return { answers, clarifications };
}

async function openClarify(card: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(
    within(card).getByRole('button', { name: /ask for clarification/i }),
  );
  return await within(card).findByRole(
    'textbox',
    { name: /what do you want to know/i },
    { timeout: 15_000 },
  );
}

describe('待确认事项页：请求补充说明', () => {
  it('点「请补充说明」发送后，卡片进「等补充」且不显示提交通道', async () => {
    const { answers, clarifications } = await renderClarifyScenario(
      SNAPSHOT,
      FIXTURE_QUESTIONS,
      FIXTURE_STATE,
    );
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    const input = await openClarify(card);
    fireEvent.change(input, { target: { value: '上限是多少？' } });
    fireEvent.click(within(card).getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      expect(clarifications).toEqual([
        { id: 'QA-01', body: { note: '上限是多少？' } },
      ]);
    });
    const awaiting = await screen.findByTestId(
      'awaiting-QA-01',
      {},
      { timeout: 15_000 },
    );
    expect(awaiting).toHaveTextContent('Asked for clarification');
    expect(awaiting).toHaveTextContent('上限是多少？');
    expect(awaiting).toHaveTextContent(
      'The main session will write the explanation here',
    );
    expect(within(awaiting).queryByRole('radio')).not.toBeInTheDocument();
    expect(
      within(awaiting).queryByRole('button', { name: /submit/i }),
    ).not.toBeInTheDocument();
    expect(answers).toEqual([]);
  });

  it('补充说明输入框里数字键不触发选项，Ctrl+Enter 发送请求但不提交答复', async () => {
    const { answers, clarifications } = await renderClarifyScenario(
      SNAPSHOT,
      FIXTURE_QUESTIONS,
      FIXTURE_STATE,
    );
    const card = await screen.findByTestId(
      'pending-QA-01',
      {},
      { timeout: 15_000 },
    );
    const input = await openClarify(card);
    fireEvent.change(input, { target: { value: '请说清上限' } });
    fireEvent.keyDown(input, { key: '2' });
    await waitFor(() => expect(checked(card)).toBe(0));
    expect(within(card).getAllByRole('radio')[1]).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
    });
    await waitFor(() => expect(clarifications).toHaveLength(1));
    expect(clarifications[0]?.body.note).toBe('请说清上限');
    expect(answers).toEqual([]);
    expect(
      await screen.findByTestId('awaiting-QA-01', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
  });

  it('有了说明后回到待确认、排最前、带标记并显示分段与列表正文（不渲染 HTML）', async () => {
    await renderClarifyScenario(
      EXPLAINED_SNAPSHOT,
      EXPLAINED_QUESTIONS,
      ANSWERED_CLARIFICATION_STATE,
    );
    const shown = await screen.findByTestId(
      'pending-QA-02',
      {},
      { timeout: 15_000 },
    );
    expect(shown).toHaveTextContent('Explained');
    expect(shown).toHaveTextContent(EXPLANATION.at);
    expect(within(shown).getByText('第一段。')).toBeInTheDocument();
    expect(within(shown).getByText('第二段。')).toBeInTheDocument();
    const items = within(shown).getAllByRole('listitem');
    expect(items.map((node) => node.textContent)).toEqual(['要点一', '要点二']);
    expect(shown.textContent).toContain('<b>不是标签</b>');
    expect(within(shown).queryByText('不是标签')).not.toBeInTheDocument();
    const firstCard = document.querySelector('[data-question-card]');
    expect(firstCard).toHaveAttribute('data-question-card', 'QA-02');
  });

  it('再要一次说明时历史按时间全留，新的在上', async () => {
    const { clarifications } = await renderClarifyScenario(
      EXPLAINED_SNAPSHOT,
      EXPLAINED_QUESTIONS,
      ANSWERED_CLARIFICATION_STATE,
    );
    const card = await screen.findByTestId(
      'pending-QA-02',
      {},
      { timeout: 15_000 },
    );
    const input = await openClarify(card);
    fireEvent.change(input, { target: { value: '再问一次' } });
    fireEvent.click(within(card).getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(clarifications).toHaveLength(1));
    const awaiting = await screen.findByTestId(
      'awaiting-QA-02',
      {},
      { timeout: 15_000 },
    );
    expect(awaiting).toHaveTextContent('再问一次');
    expect(awaiting).toHaveTextContent('为什么？');
    const text = awaiting.textContent ?? '';
    expect(text.indexOf('再问一次')).toBeLessThan(text.indexOf('为什么？'));
  });

  it('页头加「等补充」计数、分段按钮加一项；芯片把等补充算进未关闭问题', async () => {
    await renderClarifyScenario(AWAITING_SNAPSHOT, FIXTURE_QUESTIONS, AWAITING_STATE);
    await screen.findByTestId('awaiting-QA-02', {}, { timeout: 15_000 });
    expect(screen.getByTestId('count-awaiting')).toHaveTextContent('1');
    expect(screen.getByTestId('count-pending')).toHaveTextContent('1');
    expect(screen.getByTestId('count-answered')).toHaveTextContent('1');
    expect(screen.getByTestId('count-processed')).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'BETA 1' })).toBeInTheDocument();
    const segmented = screen.getByRole('button', {
      name: /awaiting clarification/i,
    });
    expect(segmented).toBeInTheDocument();
    fireEvent.click(segmented);
    expect(
      await screen.findByTestId('awaiting-QA-02', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pending-QA-01')).not.toBeInTheDocument();
  });
});
