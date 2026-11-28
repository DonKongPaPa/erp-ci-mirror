// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  appendFeedback,
  appendNote,
  buildSnapshot,
  emptyFeedbackState,
  InvalidFeedback,
  InvalidRegistry,
  markProcessed,
  markSeen,
  nextFeedbackId,
  normalizeFeedbackState,
  parseRegistry,
  parseStateFile,
  pendingFeedbacks,
  validateKinds,
  validateTarget,
} from '../../server/dev-tools/feedback.js';
import {
  FIXTURE_ITEMS,
  FIXTURE_REGISTRY,
  FIXTURE_STATE,
} from '../fixtures/feedback.js';

/**
 * 验收第 1、2、3 条：登记表可解析且 id 唯一；三种 target 校验、文本至少四字、类型可选；
 * 追加说明不改旧内容、状态只改一条、编号只追加。把任何一条算法取反，对应断言都要红。
 */

describe('登记表解析', () => {
  it('解析登记表，页面行带 route，功能点行不带', () => {
    const rows = parseRegistry(JSON.stringify(FIXTURE_REGISTRY));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.route !== undefined)).toHaveLength(3);
    expect(rows[0]?.betaAt).toBe('');
  });

  it('id 重复、字段缺失或不是数组时整块不认', () => {
    expect(() =>
      parseRegistry(JSON.stringify([...FIXTURE_REGISTRY, FIXTURE_REGISTRY[0]])),
    ).toThrow(InvalidRegistry);
    const bad = [{ ...FIXTURE_REGISTRY[0], source: undefined }];
    expect(() => parseRegistry(JSON.stringify(bad))).toThrow(InvalidRegistry);
    expect(() => parseRegistry('{}')).toThrow(InvalidRegistry);
  });
});

describe('反馈状态容错', () => {
  it('坏文件按空起步，坏记录被丢掉', () => {
    expect(parseStateFile('{')).toEqual(emptyFeedbackState());
    expect(
      normalizeFeedbackState({
        items: [
          { id: 'FB-001', at: 't1', route: '/x', text: '问题', status: 'new', target: { kind: 'page', route: '/x' } },
          { id: 'bad' },
        ],
        seen: { items: 't2', bad: 3 },
      }),
    ).toEqual({
      items: [
        {
          id: 'FB-001',
          at: 't1',
          route: '/x',
          text: '问题',
          target: { kind: 'page', route: '/x' },
          kinds: [],
          severe: false,
          screenshot: null,
          status: 'new',
          ref: '',
          note: '',
          notes: [],
          updatedAt: 't1',
        },
      ],
      seen: { items: 't2' },
    });
  });
});

describe('定位方式与输入校验', () => {
  it('三种 target 都认，缺字段的不认', () => {
    expect(validateTarget({ kind: 'page', route: '/items' })).toEqual({
      kind: 'page',
      route: '/items',
    });
    expect(
      validateTarget({
        kind: 'element',
        text: '按钮',
        locator: '[data-testid="new"]',
        source: 'x.tsx:1',
      }),
    ).toMatchObject({ kind: 'element' });
    expect(validateTarget({ kind: 'registry', registryId: 'items' })).toEqual({
      kind: 'registry',
      registryId: 'items',
    });
    expect(() => validateTarget({ kind: 'element', text: '按钮' })).toThrow(
      InvalidFeedback,
    );
    expect(() => validateTarget({ kind: 'page' })).toThrow(InvalidFeedback);
  });

  it('文本少于四个字被拒，类型缺省是空、非法值被拒', () => {
    expect(() =>
      appendFeedback(
        FIXTURE_STATE,
        { route: '/items', target: { kind: 'page', route: '/items' }, text: '太短' },
        't',
      ),
    ).toThrow(InvalidFeedback);
    expect(validateKinds(undefined)).toEqual([]);
    expect(validateKinds(['flow', 'data'])).toEqual(['flow', 'data']);
    expect(() => validateKinds(['nope'])).toThrow(InvalidFeedback);
  });

  it('追加一条只追加，编号往后走', () => {
    const result = appendFeedback(
      FIXTURE_STATE,
      {
        route: '/items',
        target: { kind: 'registry', registryId: 'items' },
        text: '又发现一个问题',
        kinds: ['missing'],
        severe: true,
      },
      't',
    );
    expect(result.id).toBe('FB-006');
    expect(result.state.items).toHaveLength(FIXTURE_ITEMS.length + 1);
    expect(result.state.items.at(-1)?.status).toBe('new');
    expect(result.state.items.at(-1)?.kinds).toEqual(['missing']);
    expect(nextFeedbackId(FIXTURE_ITEMS)).toBe('FB-006');
  });
});

describe('追加说明与处理状态', () => {
  it('追加说明不改原文与状态', () => {
    const before = FIXTURE_ITEMS[0]!;
    const next = appendNote(FIXTURE_STATE, before.id, '又补充一句', 't');
    expect(next.items[0]?.text).toBe(before.text);
    expect(next.items[0]?.status).toBe(before.status);
    expect(next.items[0]?.notes).toHaveLength(1);
    expect(next.items[0]?.notes[0]?.text).toBe('又补充一句');
    expect(() => appendNote(FIXTURE_STATE, 'FB-999', 'x', 't')).toThrow(
      InvalidFeedback,
    );
  });

  it('处理只改一条，五种状态都认，非法值被拒', () => {
    for (const status of ['new', 'accepted', 'fixed', 'wontfix', 'duplicate'] as const) {
      const next = markProcessed(FIXTURE_STATE, 'FB-001', status, '#1', '一句话', 't');
      expect(next.items[0]?.status).toBe(status);
      expect(next.items[1]).toEqual(FIXTURE_ITEMS[1]);
    }
    expect(() =>
      markProcessed(FIXTURE_STATE, 'FB-001', 'nope' as 'new', '#1', '一句话', 't'),
    ).toThrow(InvalidFeedback);
    expect(() =>
      markProcessed(FIXTURE_STATE, 'FB-001', 'new', '', '一句话', 't'),
    ).toThrow(InvalidFeedback);
  });

  it('「看过，没意见」按登记表 id 记一个时刻', () => {
    const next = markSeen(FIXTURE_STATE, 'items', 't');
    expect(next.seen.items).toBe('t');
    expect(next.seen.shifts).toBe(FIXTURE_STATE.seen.shifts);
  });
});

describe('快照与待处理', () => {
  it('快照按编号排，五组计数与夹具一致', () => {
    const snapshot = buildSnapshot(FIXTURE_REGISTRY, FIXTURE_STATE, 't');
    expect(snapshot.generatedAt).toBe('t');
    expect(snapshot.registry).toHaveLength(3);
    expect(snapshot.items.map((item) => item.id)).toEqual([
      'FB-001',
      'FB-002',
      'FB-003',
      'FB-004',
      'FB-005',
    ]);
    expect(snapshot.counts).toEqual({
      new: 1,
      accepted: 1,
      fixed: 1,
      wontfix: 1,
      duplicate: 1,
    });
    expect(pendingFeedbacks(FIXTURE_STATE).map((item) => item.id)).toEqual([
      'FB-001',
    ]);
  });
});
