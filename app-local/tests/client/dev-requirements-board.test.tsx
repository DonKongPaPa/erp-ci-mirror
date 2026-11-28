import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  FOLLOW_UPS_FIXTURE,
  POOL_FIXTURE,
} from '../fixtures/requirements-board.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';
import RequirementsBoardPage from '../../client/extensions/dev-requirements-board/index.js';
import { buildRequirementsBoard } from '../../server/dev-tools/requirements-board.js';

/**
 * 验收第 5 条（渲染部分）：用夹具渲染，七个状态列、权重标签、建议次序的顺序各一条。
 * 数字与需求池一致那一条是界面检查，不在本测试里（副本不连开发环境）。
 * 2026-11-28 重新设计后的结构也在这里守：卡片短摘要、状态磁贴、三条轨道与迷你卡、抽屉时间线、依赖徽章跳转。
 */

const board = buildRequirementsBoard(
  POOL_FIXTURE,
  FOLLOW_UPS_FIXTURE,
  '2026-11-28T00:00:00+08:00',
);

const STATUSES = [
  '待评估',
  '可行性已确认',
  '需业务决策',
  '方案已定',
  '实现中',
  '待验收',
  '已实现',
] as const;

type Board = typeof board;

async function renderBoard(data: Board = board) {
  return await renderAuthenticatedClient(<RequirementsBoardPage />, {
    afterResponse: (request, response) => {
      if (new URL(request.url).pathname.endsWith('/dev/requirements-board')) {
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return response;
    },
  });
}

describe('需求池看板用夹具渲染', () => {
  it('七个状态列各出一列，卡片落在自己的状态列里', async () => {
    await renderBoard();
    for (const status of STATUSES) {
      expect(
        await screen.findByRole(
          'heading',
          { name: status },
          { timeout: 15_000 },
        ),
      ).toBeInTheDocument();
    }
    const implemented = screen.getByTestId('column-已实现');
    expect(within(implemented).getByTestId('card-R-013')).toBeInTheDocument();
    expect(
      within(implemented).queryByTestId('card-R-001'),
    ).not.toBeInTheDocument();
  });

  it('整板横向可滚、每列固定 384px 不许被长文字撑开，编号不换行、名称最多两行', async () => {
    await renderBoard();
    const scroll = await screen.findByTestId(
      'board-scroll',
      {},
      { timeout: 15_000 },
    );
    expect(scroll, '看板是横向滚动容器').toHaveClass('overflow-x-auto');
    const columns = within(scroll).getAllByTestId(/^column-/u);
    expect(columns, '七个状态列仍然各出一列').toHaveLength(7);
    for (const column of columns) {
      // 界面检查 10：写成「最小宽度 384」时，一条两百多字的跟进把列撑到了 2300 多像素（外层按内容撑到最大）。
      expect(column, `${column.dataset.testid} 固定 384px`).toHaveClass('w-96');
      expect(column, `${column.dataset.testid} 不许伸缩`).toHaveClass(
        'shrink-0',
      );
      expect(column, `${column.dataset.testid} 不再是最小宽度`).not.toHaveClass(
        'min-w-96',
      );
    }
    const card = await screen.findByTestId(
      'card-R-023',
      {},
      { timeout: 15_000 },
    );
    expect(within(card).getByText('R-023'), '编号不拆行').toHaveClass(
      'whitespace-nowrap',
    );
    const name = within(card).getByText('MES 制造执行基础');
    expect(name, '名称最多两行').toHaveClass('line-clamp-2');
    expect(name, '截断时悬停看全文').toHaveAttribute(
      'title',
      'MES 制造执行基础',
    );
  });

  it('泳道总宽超过容器时提示可横向滚动；放得下时不提示', async () => {
    Object.defineProperty(Element.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 16_558,
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1_100,
    });
    try {
      await renderBoard();
      expect(
        await screen.findByTestId('board-scroll-hint', {}, { timeout: 15_000 }),
      ).toHaveTextContent(
        /横向滚动|scroll sideways/u, // 测试环境默认渲染英文，两种语言都认（#341）
      );
    } finally {
      // jsdom 把 scrollWidth 定义在 Element.prototype 上：这一份是我们加的替身，删掉即还原（#341 的修法）。
      delete (Element.prototype as { scrollWidth?: unknown }).scrollWidth;
      delete (Element.prototype as { clientWidth?: unknown }).clientWidth;
    }
    cleanup();
    await renderBoard();
    await screen.findByTestId('board-scroll', {}, { timeout: 15_000 });
    expect(
      screen.queryByTestId('board-scroll-hint'),
      'jsdom 里宽度都是 0，不算溢出',
    ).not.toBeInTheDocument();
  });

  it('卡片上只有一句话摘要（最多两行），「卡在哪」是带点的短标签，时间是短格式', async () => {
    await renderBoard();
    const card = await screen.findByTestId(
      'card-R-002',
      {},
      { timeout: 15_000 },
    );
    const summary = within(card).getByTestId('card-summary');
    expect(summary, '摘要最多两行').toHaveClass('line-clamp-2');
    expect(summary, '只取最近一条跟进的第一句').toHaveTextContent(
      /^第二轮调研完成，三个技术缺口都有了一手依据。$/u,
    );
    expect(summary, '后面的句子不进摘要').not.toHaveTextContent(/取库密钥/u);
    expect(summary, '不再带 ISO 时间').not.toHaveTextContent(/2026-11-27T/u);
    expect(summary, '截断时悬停看全文').toHaveAttribute('title');
    const blocking = card.querySelector('.truncate');
    expect(blocking, '「卡在哪」单行省略').not.toBeNull();
    expect(blocking?.textContent).toBe('In progress');
    expect(
      blocking?.previousElementSibling?.hasAttribute('data-dot'),
      '「卡在哪」带色点，文字仍在，不靠颜色单独表意',
    ).toBe(true);
    expect(within(card).getByTestId('card-time')).toHaveTextContent(
      '11-27 03:15',
    );
  });

  it('没有跟进的卡片取备注的第一句，不显示时间', async () => {
    await renderBoard();
    const card = await screen.findByTestId(
      'card-R-004',
      {},
      { timeout: 15_000 },
    );
    expect(within(card).getByTestId('card-summary')).toHaveTextContent(
      '第一版只读、只做聚合',
    );
    expect(within(card).queryByTestId('card-time')).not.toBeInTheDocument();
  });

  it('没有跟进也没有备注的卡片显示「暂无记录」', async () => {
    const bare = board.requirements.map((row) =>
      row.id === 'R-022' ? { ...row, note: '' } : row,
    );
    await renderBoard({ ...board, requirements: bare });
    expect(
      within(
        await screen.findByTestId('card-R-022', {}, { timeout: 15_000 }),
      ).getByTestId('card-summary'),
    ).toHaveTextContent('No record yet');
  });

  it('点开卡片的抽屉正文左右与底部有留白', async () => {
    const user = userEvent.setup();
    await renderBoard();
    const card = await screen.findByTestId(
      'card-R-023',
      {},
      { timeout: 15_000 },
    );
    await user.click(
      within(card).getByRole('button', { name: 'Open details for R-023' }),
    );
    const body = await screen.findByTestId(
      'board-detail-body',
      {},
      { timeout: 15_000 },
    );
    expect(
      body,
      '正文左右留白与其它抽屉的 px-6 一致（界面检查 10：px-4 比用户编辑抽屉少 7.2 像素）',
    ).toHaveClass('px-6');
    expect(body, '正文底部留白').toHaveClass('pb-6');
    expect(body, '正文自己滚动').toHaveClass('overflow-y-auto');
    const header = body
      .closest('[data-slot="sheet-content"]')
      ?.querySelector('[data-slot="sheet-header"]');
    expect(header, '标题区上下留白').toHaveClass('p-4');
    await user.keyboard('{Escape}');
    await waitFor(
      () =>
        expect(
          screen.queryByTestId('board-detail-body'),
        ).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );
  });

  it('权重标签按 P0/P1 显示，无权重不显示标签', async () => {
    await renderBoard();
    expect(
      within(
        await screen.findByTestId('card-R-023', {}, { timeout: 15_000 }),
      ).getByText('P0'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('card-R-002')).getByText('P1'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('card-R-022')).queryByText('无'),
    ).not.toBeInTheDocument();
  });

  it('建议次序是三条轨道：先在途（按权重、编号），再可开工，等依赖另成一条', async () => {
    await renderBoard();
    const order = await screen.findByTestId(
      'suggested-order',
      {},
      { timeout: 15_000 },
    );
    const ids = (track: string) =>
      within(screen.getByTestId(`track-${track}`))
        .getAllByTestId('suggested-item')
        .map((item) => item.textContent?.match(/R-\d+/u)?.[0]);
    expect(
      within(order)
        .getAllByTestId('suggested-item')
        .map((item) => item.textContent?.match(/R-\d+/u)?.[0]),
    ).toEqual(['R-023', 'R-002', 'R-021', 'R-020', 'R-004']);
    expect(ids('inProgress')).toEqual(['R-023', 'R-002', 'R-021']);
    expect(ids('ready')).toEqual(['R-020']);
    expect(ids('blocked')).toEqual(['R-004']);
    // 等依赖的原因：编号做成徽章。R-003 不在板上，所以只是徽章、不可点。
    const badge = within(screen.getByTestId('track-blocked')).getByText(
      'R-003',
    );
    expect(badge.tagName).toBe('SPAN');
  });

  it('点迷你卡打开同一个抽屉', async () => {
    const user = userEvent.setup();
    await renderBoard();
    const order = await screen.findByTestId(
      'suggested-order',
      {},
      { timeout: 15_000 },
    );
    const [first] = within(order).getAllByTestId('suggested-item');
    await user.click(
      within(first).getByRole('button', { name: 'Open details for R-023' }),
    );
    const body = await screen.findByTestId(
      'board-detail-body',
      {},
      { timeout: 15_000 },
    );
    expect(body).toBeInTheDocument();
    // 标题在抽屉头部；正文是「卡在哪」那几块。
    expect(body.closest('[data-slot="sheet-content"]')).toHaveTextContent(
      'MES 制造执行基础',
    );
    expect(
      within(body).getByRole('heading', { name: 'Where it stands' }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('card-R-023'),
      '泳道里的那张卡仍在页面上',
    ).toBeInTheDocument();
  });

  it('点状态磁贴横向滚到对应泳道并高亮', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: spy,
    });
    try {
      await renderBoard();
      const tile = await screen.findByTestId(
        'tile-待验收',
        {},
        { timeout: 15_000 },
      );
      expect(
        within(tile).getByText('1'),
        '磁贴上是这个状态的数量',
      ).toBeInTheDocument();
      await user.click(tile);
      await waitFor(
        () => {
          expect(spy).toHaveBeenCalledTimes(1);
          expect(spy.mock.instances[0]).toBe(
            screen.getByTestId('column-待验收'),
          );
          expect(
            screen.getByTestId('column-待验收'),
            '滚到后高亮一下',
          ).toHaveAttribute('data-highlighted');
          expect(screen.getByTestId('column-已实现')).not.toHaveAttribute(
            'data-highlighted',
          );
        },
        { timeout: 15_000 },
      );
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('抽屉里的跟进记录是竖向时间线，新的在上，文字给全文', async () => {
    const user = userEvent.setup();
    await renderBoard();
    const card = await screen.findByTestId(
      'card-R-002',
      {},
      { timeout: 15_000 },
    );
    await user.click(
      within(card).getByRole('button', { name: 'Open details for R-002' }),
    );
    const timeline = await screen.findByTestId(
      'board-timeline',
      {},
      { timeout: 15_000 },
    );
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(
      items.map((item) => item.querySelector('time')?.textContent),
    ).toEqual(['2026-11-27 03:15', '2026-11-24 03:21']);
    expect(items[0]).toHaveTextContent(/取库密钥/u);
    expect(items[0], '最新一条的文字不再截到 160 字').toHaveTextContent(
      /0 个候选。$/u,
    );
    expect(items[1]).toHaveTextContent('第一轮调研完成。');
    // 最后一条下面没有连接线。
    expect(
      items[0].querySelector('[data-slot="timeline-connector"]'),
    ).not.toBeNull();
    expect(
      items[1].querySelector('[data-slot="timeline-connector"]'),
    ).toBeNull();
  });

  it('没有跟进的需求，抽屉时间线处显示空状态', async () => {
    const user = userEvent.setup();
    await renderBoard();
    const card = await screen.findByTestId(
      'card-R-004',
      {},
      { timeout: 15_000 },
    );
    await user.click(
      within(card).getByRole('button', { name: 'Open details for R-004' }),
    );
    const body = await screen.findByTestId(
      'board-detail-body',
      {},
      { timeout: 15_000 },
    );
    expect(
      within(body).queryByTestId('board-timeline'),
    ).not.toBeInTheDocument();
    expect(within(body).getByText('No follow-up yet')).toBeInTheDocument();
  });

  it('点抽屉里的依赖徽章：关抽屉、滚到那张卡并高亮', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: spy,
    });
    try {
      await renderBoard();
      const card = await screen.findByTestId(
        'card-R-020',
        {},
        { timeout: 15_000 },
      );
      await user.click(
        within(card).getByRole('button', { name: 'Open details for R-020' }),
      );
      const body = await screen.findByTestId(
        'board-detail-body',
        {},
        { timeout: 15_000 },
      );
      expect(
        within(body).queryByRole('button', { name: 'Go to R-020' }),
        '自己的编号不算依赖',
      ).not.toBeInTheDocument();
      await user.click(
        within(body).getByRole('button', { name: 'Go to R-013' }),
      );
      await waitFor(
        () =>
          expect(
            screen.queryByTestId('board-detail-body'),
          ).not.toBeInTheDocument(),
        { timeout: 15_000 },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.instances[0]).toBe(screen.getByTestId('card-R-013'));
      expect(screen.getByTestId('card-R-013')).toHaveAttribute(
        'data-highlighted',
      );
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('卡片底部的硬依赖徽章最多 3 个，多的显示 +N；板外的编号不可点', async () => {
    const user = userEvent.setup();
    const five = board.requirements.map((row) =>
      row.id === 'R-020'
        ? { ...row, hardDeps: ['R-013', 'R-001', 'R-002', 'R-004', 'R-006'] }
        : row,
    );
    await renderBoard({ ...board, requirements: five });
    const card = await screen.findByTestId(
      'card-R-020',
      {},
      { timeout: 15_000 },
    );
    expect(
      within(card)
        .getAllByTestId(/^dep-/u)
        .map((badge) => badge.textContent),
    ).toEqual(['R-013', 'R-001', 'R-002', '+2']);
    const external = within(screen.getByTestId('card-R-002')).getAllByTestId(
      /^dep-/u,
    );
    expect(external.map((badge) => badge.textContent)).toEqual(['X-05']);
    expect(external[0]?.tagName, '板外编号只是标签').toBe('SPAN');
    await user.click(within(card).getByRole('button', { name: 'Go to R-013' }));
    await waitFor(
      () =>
        expect(screen.getByTestId('card-R-013')).toHaveAttribute(
          'data-highlighted',
        ),
      { timeout: 15_000 },
    );
    expect(
      screen.queryByTestId('board-detail-body'),
      '从卡片直接跳，不开抽屉',
    ).not.toBeInTheDocument();
  });

  it('筛选：类别是分段按钮、只看未完成是开关、搜索按编号或名称', async () => {
    const user = userEvent.setup();
    await renderBoard();
    await screen.findByTestId('board-scroll', {}, { timeout: 15_000 });
    await waitFor(() => {
      expect(
        screen.queryByRole('combobox'),
        '类别的下拉已经换成分段按钮',
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Engineering' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: 'Only unfinished' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Engineering' }));
    await waitFor(
      () => {
        expect(
          within(screen.getByTestId('column-待评估')).queryByTestId(
            'card-R-001',
          ),
        ).not.toBeInTheDocument();
        expect(
          within(screen.getByTestId('column-可行性已确认')).getByText(
            'Nothing in this lane',
          ),
        ).toBeInTheDocument();
        expect(
          within(screen.getByTestId('track-inProgress')).getByText(
            'Nothing here',
          ),
          '轨道跟着筛选变空',
        ).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(
      await screen.findByTestId('card-R-001', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Only unfinished' }));
    await waitFor(
      () => {
        expect(
          screen.queryByTestId('card-R-013'),
          '已实现的被收起',
        ).not.toBeInTheDocument();
        expect(
          screen.getByTestId('card-R-020'),
          '没做完的还在',
        ).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    await user.click(screen.getByRole('switch', { name: 'Only unfinished' }));
    expect(
      await screen.findByTestId('card-R-013', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Search by id or name' }),
      '编码',
    );
    await waitFor(
      () => {
        expect(screen.queryByTestId('card-R-013')).not.toBeInTheDocument();
        expect(screen.getByTestId('card-R-020')).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
  });

  it('跳转的目标被筛选藏起来时先清掉筛选再滚过去', async () => {
    const user = userEvent.setup();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
    try {
      await renderBoard();
      await screen.findByTestId('card-R-020', {}, { timeout: 15_000 });
      await user.click(screen.getByRole('button', { name: 'Business' }));
      await waitFor(
        () =>
          expect(
            screen.queryByTestId('card-R-020'),
            '工程需求被类别筛选藏起来',
          ).not.toBeInTheDocument(),
        { timeout: 15_000 },
      );
      const from = screen.getByTestId('card-R-021');
      await user.click(
        within(from).getByRole('button', { name: 'Go to R-020' }),
      );
      expect(
        await screen.findByTestId('card-R-020', {}, { timeout: 15_000 }),
      ).toHaveAttribute('data-highlighted');
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  /** 在途轨道里塞五条编造的需求：编号不用 R-xxx（合规审计会把它当成真实引用）。 */
  function busyBoard(): Board {
    const base = board.requirements.find((row) => row.id === 'R-023');
    if (!base) throw new Error('夹具里没有 R-023');
    return {
      ...board,
      requirements: [
        ...board.requirements,
        ...[1, 2, 3, 4, 5].map((n) => ({
          ...base,
          id: `Q-0${n}`,
          name: `排队的需求 ${n}`,
        })),
      ],
    };
  }

  it('轨道默认只显示一行，放不下的收进「还有 N 个」；点开换行展开，再点收起', async () => {
    const user = userEvent.setup();
    await renderBoard(busyBoard());
    const track = await screen.findByTestId(
      'track-inProgress',
      {},
      { timeout: 15_000 },
    );
    const row = within(track).getByTestId('track-row-inProgress');
    expect(row, '收起时一行、不出滚动条').toHaveClass('flex-nowrap');
    expect(row).toHaveClass('overflow-hidden');
    expect(track).not.toHaveAttribute('data-expanded');
    const more = await within(track).findByTestId(
      'track-more-inProgress',
      {},
      { timeout: 15_000 },
    );
    expect(more).toHaveTextContent('6 more');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(track)
        .getAllByTestId('suggested-item')
        .map((item) => item.textContent?.match(/[RQ]-\d+/u)?.[0]),
      '还没量到宽度时先显示三张里的两张，留一格给按钮',
    ).toEqual(['Q-01', 'Q-02']);

    await user.click(more);
    await waitFor(
      () =>
        expect(screen.getByTestId('track-inProgress')).toHaveAttribute(
          'data-expanded',
        ),
      { timeout: 15_000 },
    );
    const expandedRow = screen.getByTestId('track-row-inProgress');
    expect(expandedRow, '展开后换行').toHaveClass('flex-wrap');
    expect(
      within(screen.getByTestId('track-inProgress')).getAllByTestId(
        'suggested-item',
      ),
    ).toHaveLength(8);
    const less = screen.getByTestId('track-more-inProgress');
    expect(less).toHaveTextContent('Show less');
    expect(less).toHaveAttribute('aria-expanded', 'true');

    await user.click(less);
    await waitFor(
      () =>
        expect(screen.getByTestId('track-inProgress')).not.toHaveAttribute(
          'data-expanded',
        ),
      { timeout: 15_000 },
    );
    expect(
      within(screen.getByTestId('track-inProgress')).getAllByTestId(
        'suggested-item',
      ),
    ).toHaveLength(2);
    expect(
      screen.queryByTestId('track-more-ready'),
      '放得下的轨道没有按钮',
    ).not.toBeInTheDocument();
  });

  it('一行放几张跟着轨道的宽度算：600 像素放两张，留一格给按钮后只显示一张', async () => {
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get: () => 600,
    });
    try {
      await renderBoard(busyBoard());
      const track = await screen.findByTestId(
        'track-inProgress',
        {},
        { timeout: 15_000 },
      );
      await waitFor(
        () =>
          expect(
            within(track).getByTestId('track-more-inProgress'),
          ).toHaveTextContent('7 more'),
        { timeout: 15_000 },
      );
      expect(within(track).getAllByTestId('suggested-item')).toHaveLength(1);
    } finally {
      delete (Element.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });

  it('状态磁贴的标签完整显示、不省略；九块按宽度自适应换行', async () => {
    await renderBoard();
    const tile = await screen.findByTestId(
      'tile-可行性已确认',
      {},
      { timeout: 15_000 },
    );
    const label = within(tile).getByText('可行性已确认');
    expect(label, '标签不带省略').not.toHaveClass('truncate');
    expect(label).toHaveClass('whitespace-normal');
    const grid = tile.parentElement;
    expect(grid).toHaveClass('grid-cols-3');
    expect(grid).toHaveClass('sm:grid-cols-5');
    expect(grid).toHaveClass('xl:grid-cols-9');
  });

  it('两块计数磁贴的标签允许换行、不省略（放大 150% 时窄列里不能只剩图标）', async () => {
    await renderBoard();
    const ready = await screen.findByTestId(
      'counter-ready',
      {},
      { timeout: 15_000 },
    );
    const label = within(ready).getByTestId('counter-label-ready');
    expect(label).toHaveTextContent('Ready to start');
    expect(label, '不带截断').not.toHaveClass('truncate');
    expect(label).toHaveClass('whitespace-normal');
    expect(ready.querySelector('.truncate'), '整块里没有省略').toBeNull();
    const blocked = screen.getByTestId('counter-blocked');
    expect(
      within(blocked).getByTestId('counter-label-blocked'),
    ).toHaveTextContent('Waiting on dependencies');
    expect(within(blocked).getByText('1'), '数字仍在').toBeInTheDocument();
  });

  it('迷你卡：权重竖条、第一行编号与权重徽章、标题两行，不用省略号', async () => {
    await renderBoard();
    const order = await screen.findByTestId(
      'suggested-order',
      {},
      { timeout: 15_000 },
    );
    const first = within(order).getAllByTestId('suggested-item')[0];
    if (!first) throw new Error('没有迷你卡');
    const bar = first.querySelector('[data-slot="weight-bar"]');
    expect(bar, '左边一道竖条，P0 用权重的红色').toHaveClass('bg-destructive');
    expect(bar).toHaveClass('w-1');
    const title = within(first).getByText('MES 制造执行基础');
    expect(title, '标题两行').toHaveClass('line-clamp-2');
    expect(first.querySelector('.truncate'), '迷你卡里没有省略号').toBeNull();
    expect(
      first.querySelector('[data-dot]'),
      '原来的小圆点换成竖条',
    ).toBeNull();
    expect(
      within(first).getByText('P0'),
      '权重徽章在第一行',
    ).toBeInTheDocument();
    expect(first).toHaveClass('w-64');
    const second = within(order).getAllByTestId('suggested-item')[1];
    expect(
      second?.querySelector('[data-slot="weight-bar"]'),
      'P1 用权重的主题色',
    ).toHaveClass('bg-primary');
  });

  it('顶部数字与夹具一致', async () => {
    await renderBoard();
    expect(
      await screen.findByText(/10 requirements/u, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 skipped/u)).toBeInTheDocument();
  });
});
