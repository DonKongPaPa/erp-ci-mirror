// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  FOLLOW_UPS_FIXTURE,
  FIXTURE_POOL_ROWS,
  POOL_FIXTURE,
} from '../fixtures/requirements-board.js';
import {
  blockingFor,
  buildRequirementsBoard,
  parseAllFollowUps,
  parseFollowUps,
  parseRequirementsPool,
  stripCell,
} from '../../server/dev-tools/requirements-board.js';

/**
 * 验收第 1、2 条：解析容错与 blocking 算法。
 * 夹具抄自需求池当时的一小段，测试不读真文件；把任何一条算法分支取反，对应的断言都要红。
 */

describe('解析需求池主表', () => {
  it('解析条数等于主表行数，缺列的行进 skipped 并计数', () => {
    const result = parseRequirementsPool(POOL_FIXTURE);
    expect(result.pool).toBe(FIXTURE_POOL_ROWS);
    expect(result.skipped).toBe(1);
    expect(result.rows).toHaveLength(FIXTURE_POOL_ROWS - 1);
    expect(result.rows.filter((row) => row.name === '缺列的行')).toEqual([]);
  });

  it('反引号、粗体与首尾空格剥掉后再比：粗体状态与反引号单元格都能解析', () => {
    expect(stripCell('  **`P1`**  ')).toBe('P1');
    const byId = new Map(
      parseRequirementsPool(POOL_FIXTURE).rows.map((row) => [row.id, row]),
    );
    expect(byId.get('R-006')?.status).toBe('需业务决策');
    expect(byId.get('R-006')?.category).toBe('业务');
    expect(byId.get('R-001')?.weight).toBe('P1');
    expect(byId.get('R-001')?.hardDeps).toEqual(['R-026']);
    expect(byId.get('R-001')?.softDeps).toEqual(['R-027']);
  });

  it('整块看板带出解析计数与跟进记录的最新一条', () => {
    const board = buildRequirementsBoard(
      POOL_FIXTURE,
      FOLLOW_UPS_FIXTURE,
      '2026-11-28T00:00:00+08:00',
    );
    expect(board.totals).toEqual({
      pool: FIXTURE_POOL_ROWS,
      parsed: FIXTURE_POOL_ROWS - 1,
      skipped: 1,
    });
    expect(board.generatedAt).toBe('2026-11-28T00:00:00+08:00');
    const second = board.requirements.find((item) => item.id === 'R-002');
    expect(second?.lastEntry?.at).toBe('2026-11-27T03:15:44+08:00');
    expect(second?.lastEntry?.text.length).toBeLessThanOrEqual(160);
    expect(second?.lastEntry?.text).toContain('第二轮调研完成');
    expect(
      board.requirements.find((item) => item.id === 'R-004')?.lastEntry,
    ).toBeNull();
  });

  it('跟进记录按 R-xxx 小节取最新一条，取不到就是空', () => {
    const entries = parseFollowUps(FOLLOW_UPS_FIXTURE);
    expect(entries.get('R-021')?.at).toBe('2026-11-28T07:19:57+08:00');
    expect(entries.has('R-013')).toBe(false);
  });
});

describe('跟进记录全集 entries（抽屉时间线用）', () => {
  it('一条跟进都没有的需求 entries 是空数组，lastEntry 仍是 null', () => {
    const board = buildRequirementsBoard(POOL_FIXTURE, FOLLOW_UPS_FIXTURE);
    const item = board.requirements.find((row) => row.id === 'R-004');
    expect(item?.entries).toEqual([]);
    expect(item?.lastEntry).toBeNull();
  });

  it('多条按时间升序，不按文件里的倒序；文字给全文不截断', () => {
    const followUps = `# 需求跟进记录

## R-002 知识库累积与 AI 代填

- **2026-11-27T03:15:44+08:00** ${'最长的一句。'.repeat(40)}
- **2026-11-25T10:00:00+08:00** 中间一条。
- **2026-11-24T03:21:13+08:00** 最早一条。
`;
    const board = buildRequirementsBoard(POOL_FIXTURE, followUps);
    const item = board.requirements.find((row) => row.id === 'R-002');
    expect(item?.entries.map((entry) => entry.text)).toEqual([
      '最早一条。',
      '中间一条。',
      `${'最长的一句。'.repeat(40)}`,
    ]);
    expect(item?.entries[2]?.text.length).toBe(240);
    // lastEntry 原样保留：仍是文件里第一条、仍截到 160 字。
    expect(item?.lastEntry?.at).toBe('2026-11-27T03:15:44+08:00');
    expect(item?.lastEntry?.text.length).toBe(160);
  });

  it('小节里的续行并进那一条；其他小节的跟进不串过来', () => {
    const all = parseAllFollowUps(FOLLOW_UPS_FIXTURE);
    expect(all.get('R-002')).toEqual([
      {
        at: '2026-11-24T03:21:13+08:00',
        text: '第一轮调研完成。',
      },
      {
        at: '2026-11-27T03:15:44+08:00',
        text: '第二轮调研完成，三个技术缺口都有了一手依据。 取库密钥首选工具把服务拉起为子进程；现用扫描器遇到混淆密钥会找到 0 个候选。',
      },
    ]);
    expect(all.get('R-021')).toHaveLength(1);
    expect(all.has('R-013')).toBe(false);
  });
});

describe('blocking 算法六种正反例', () => {
  const statuses = new Map<string, string>([
    ['R-003', '待设计'],
    ['R-013', '已实现'],
    ['R-020', '待验收'],
  ]);

  it('已实现 → 已完成，detail 为空', () => {
    expect(
      blockingFor('已实现', ['R-020'], statuses, {
        at: '2026-11-28T00:00:00+08:00',
        text: '收尾',
      }),
    ).toEqual({ blocking: '已完成', blockingDetail: '' });
  });

  it('实现中与待验收 → 在途，detail 是最新跟进的时刻', () => {
    const entry = { at: '2026-11-27T03:15:44+08:00', text: '在途' };
    expect(blockingFor('实现中', [], statuses, entry)).toEqual({
      blocking: '在途',
      blockingDetail: entry.at,
    });
    expect(blockingFor('待验收', [], statuses, entry).blocking).toBe('在途');
    expect(blockingFor('待验收', [], statuses, null).blockingDetail).toBe('');
  });

  it('待评估、可行性已确认、需业务决策 → 待设计', () => {
    for (const status of ['待评估', '可行性已确认', '需业务决策']) {
      expect(blockingFor(status, ['R-020'], statuses, null)).toEqual({
        blocking: '待设计',
        blockingDetail: '',
      });
    }
  });

  it('方案已定且硬依赖没到已实现 → 等依赖并带编号', () => {
    expect(blockingFor('方案已定', ['R-003'], statuses, null)).toEqual({
      blocking: '等依赖',
      blockingDetail: 'R-003',
    });
    expect(blockingFor('方案已定', ['R-013', 'R-020'], statuses, null)).toEqual(
      {
        blocking: '等依赖',
        blockingDetail: 'R-020',
      },
    );
  });

  it('方案已定且硬依赖都完成 → 可开工', () => {
    expect(blockingFor('方案已定', ['R-013'], statuses, null)).toEqual({
      blocking: '可开工',
      blockingDetail: '',
    });
    expect(blockingFor('方案已定', [], statuses, null)).toEqual({
      blocking: '可开工',
      blockingDetail: '',
    });
  });

  it('整块看板里每种 blocking 都能从夹具算出来', () => {
    const board = buildRequirementsBoard(POOL_FIXTURE, FOLLOW_UPS_FIXTURE);
    const byBlocking = new Map(
      board.requirements.map((item) => [item.id, item.blocking]),
    );
    expect(byBlocking.get('R-013')).toBe('已完成');
    expect(byBlocking.get('R-002')).toBe('在途');
    expect(byBlocking.get('R-021')).toBe('在途');
    expect(byBlocking.get('R-001')).toBe('待设计');
    expect(byBlocking.get('R-006')).toBe('待设计');
    expect(byBlocking.get('R-004')).toBe('等依赖');
    expect(byBlocking.get('R-020')).toBe('可开工');
  });
});
