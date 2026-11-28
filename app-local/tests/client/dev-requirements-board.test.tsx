import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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

async function renderBoard() {
  return await renderAuthenticatedClient(<RequirementsBoardPage />, {
    afterResponse: (request, response) => {
      if (new URL(request.url).pathname.endsWith('/dev/requirements-board')) {
        return new Response(JSON.stringify({ data: board }), {
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
        await screen.findByRole('heading', { name: status }, { timeout: 15_000 }),
      ).toBeInTheDocument();
    }
    const implemented = screen.getByTestId('column-已实现');
    expect(within(implemented).getByTestId('card-R-013')).toBeInTheDocument();
    expect(within(implemented).queryByTestId('card-R-001')).not.toBeInTheDocument();
  });

  it('权重标签按 P0/P1 显示，无权重不显示标签', async () => {
    await renderBoard();
    expect(
      within(await screen.findByTestId('card-R-023', {}, { timeout: 15_000 })).getByText('P0'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('card-R-002')).getByText('P1'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('card-R-022')).queryByText('无'),
    ).not.toBeInTheDocument();
  });

  it('建议次序先在途（按权重、编号），再可开工，等依赖另成一组', async () => {
    await renderBoard();
    const order = await screen.findByTestId('suggested-order', {}, { timeout: 15_000 });
    const ids = within(order)
      .getAllByTestId('suggested-item')
      .map((item) => item.textContent ?? '');
    expect(ids.map((text) => text.match(/R-\d+/)?.[0])).toEqual([
      'R-023',
      'R-002',
      'R-021',
      'R-020',
      'R-004',
    ]);
    expect(within(order).getByText(/R-003/u)).toBeInTheDocument();
  });

  it('顶部数字与夹具一致', async () => {
    await renderBoard();
    expect(
      await screen.findByText(/10 requirements/u, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 skipped/u)).toBeInTheDocument();
  });
});
