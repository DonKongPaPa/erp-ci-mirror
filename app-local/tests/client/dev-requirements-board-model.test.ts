import { describe, expect, it } from 'vitest';

import {
  cardSummary,
  shortTime,
  type BoardItem,
} from '../../client/extensions/dev-requirements-board/model.js';

/**
 * 卡片上那句话的规则（用户 2026-11-28：「没点进去之前总结一段简短一点的」）：
 * 取最近一条跟进的第一句，超过 60 字在最近的逗号或顿号处截断；没有跟进取 note 的第一句；都没有给空串，由页面显示「暂无记录」。
 */

function item(overrides: Partial<BoardItem>): BoardItem {
  return {
    id: 'X-99', // 不写成 R-xxx：合规审计会把测试里的需求编号当成真实引用
    name: '测试',
    category: '业务',
    status: '待评估',
    weight: 'P1',
    hardDeps: [],
    softDeps: [],
    note: '',
    lastEntry: null,
    entries: [],
    blocking: '待设计',
    blockingDetail: '',
    ...overrides,
  };
}

describe('cardSummary', () => {
  it('有跟进取正文第一句，后面的句子不进摘要', () => {
    expect(
      cardSummary(
        item({
          lastEntry: {
            at: '2026-11-27T03:15:44+08:00',
            text: '第二轮调研完成。第二句不该出现。',
          },
          note: '备注不该赢过跟进。',
        }),
      ),
    ).toBe('第二轮调研完成。');
  });

  it('开头的 ISO 时间不进摘要；续行与多余空格压成一个空格', () => {
    expect(
      cardSummary(
        item({
          lastEntry: {
            at: '',
            text: '2026-11-27T03:15:44+08:00 用户看了说可以。后面。',
          },
        }),
      ),
    ).toBe('用户看了说可以。');
    expect(
      cardSummary(item({ lastEntry: { at: '', text: '第一行\n   第二行。' } })),
    ).toBe('第一行 第二行。');
  });

  it('超过 60 字在最近的逗号或顿号处截断并加省略号', () => {
    const unit = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉，';
    const long = `${unit}${unit}${unit}尾巴尾巴。`;
    expect(long.length).toBeGreaterThan(60);
    expect(cardSummary(item({ lastEntry: { at: '', text: long } }))).toBe(
      `${unit}${unit}…`,
    );
    const pause = `${'子丑寅卯辰巳午未申酉'.repeat(3)}、${'尾巴'.repeat(20)}。`;
    expect(cardSummary(item({ lastEntry: { at: '', text: pause } }))).toBe(
      `${'子丑寅卯辰巳午未申酉'.repeat(3)}、…`,
    );
  });

  it('60 字以内整句照给；整句超过 60 字且没有可断的标点就硬截', () => {
    const exact = '一句话不到六十个字。';
    expect(cardSummary(item({ lastEntry: { at: '', text: exact } }))).toBe(
      exact,
    );
    const noPause = `${'很长'.repeat(50)}。`;
    const summary = cardSummary(item({ lastEntry: { at: '', text: noPause } }));
    expect(summary).toBe(`${'很长'.repeat(30)}…`);
  });

  it('没有跟进取 note 的第一句；都没有给空串', () => {
    expect(cardSummary(item({ note: '定单台赋码。后面不进。' }))).toBe(
      '定单台赋码。',
    );
    expect(cardSummary(item({ note: '' }))).toBe('');
    expect(cardSummary(item({ note: '2026-11-27 13:30 用户原话。' }))).toBe(
      '用户原话。',
    );
  });
});

describe('shortTime', () => {
  it('ISO 时间写成 MM-DD HH:mm，时区后缀与秒不显示', () => {
    expect(shortTime('2026-11-27T03:15:44+08:00')).toBe('11-27 03:15');
    expect(shortTime('2026-11-28T07:19:57+08:00')).toBe('11-28 07:19');
  });

  it('不是 ISO 时间的原样给出，空串给空串', () => {
    expect(shortTime('')).toBe('');
    expect(shortTime('看板')).toBe('看板');
  });
});
