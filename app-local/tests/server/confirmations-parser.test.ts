// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildSnapshot,
  InvalidConfirmationAnswer,
  InvalidConfirmationList,
  InvalidConfirmationProcess,
  appendAnswer,
  appendClarification,
  answerError,
  clarificationError,
  emptyConfirmationState,
  groupFor,
  isAwaitingClarification,
  latestAnswer,
  latestClarification,
  markClarificationsAnswered,
  markProcessed,
  normalizeConfirmationState,
  parseQuestionList,
  parseStateFile,
  pendingAnswers,
} from '../../server/dev-tools/confirmations.js';
import {
  FIXTURE_QUESTIONS,
  FIXTURE_STATE,
} from '../fixtures/confirmations.js';

/**
 * 验收第 1 条：清单可解析、id 不重复；第 2 条：单选/填空校验与只追加；第 3 条：处理结果分组。
 * 夹具是手写的一小段，测试不读真文件；把任何一条算法取反，对应断言都要红。
 */

describe('问题清单解析', () => {
  it('解析四道夹具题、字段齐全', () => {
    const questions = parseQuestionList(JSON.stringify(FIXTURE_QUESTIONS));
    expect(questions).toHaveLength(4);
    expect(questions.map((item) => item.id)).toEqual([
      'QA-01',
      'QA-02',
      'QA-03',
      'QA-04',
    ]);
    expect(questions[0]?.options).toEqual(['本地盘', '对象存储', '其他']);
  });

  it('id 重复或格式不对时整块不认', () => {
    const duplicated = [...FIXTURE_QUESTIONS, FIXTURE_QUESTIONS[0]];
    expect(() => parseQuestionList(JSON.stringify(duplicated))).toThrow(
      InvalidConfirmationList,
    );
    const badId = [{ ...FIXTURE_QUESTIONS[0], id: 'ALPHA' }];
    expect(() => parseQuestionList(JSON.stringify(badId))).toThrow(
      InvalidConfirmationList,
    );
    expect(() => parseQuestionList('not json')).toThrow(InvalidConfirmationList);
  });
});

describe('状态容错', () => {
  it('文件不存在按空起步，坏记录被丢掉', () => {
    expect(parseStateFile('{')).toEqual(emptyConfirmationState());
    expect(
      normalizeConfirmationState({
        answers: [
          { id: 'QA-01', answer: '本地盘', at: 't1' },
          { id: 'bad' },
        ],
        processed: { 'QA-01': { status: 'nope' } },
      }),
    ).toEqual({
      answers: [{ id: 'QA-01', answer: '本地盘', note: '', at: 't1' }],
      processed: {},
    });
  });
});

describe('答复校验与追加', () => {
  const single = FIXTURE_QUESTIONS[0]!;
  const free = FIXTURE_QUESTIONS[1]!;

  it('单选只认 options 里的值', () => {
    expect(answerError(single, '本地盘')).toBeNull();
    expect(answerError(single, '清单外的值')).toBe('NOT_IN_OPTIONS');
    expect(answerError(single, '')).toBe('EMPTY');
  });

  it('填空 1 到 2000 字', () => {
    expect(answerError(free, '不能改原单')).toBeNull();
    expect(answerError(free, '   ')).toBe('EMPTY');
    expect(answerError(free, '好'.repeat(2001))).toBe('TOO_LONG');
    expect(answerError(free, '好'.repeat(2000))).toBeNull();
  });

  it('同一条再答复，历史保留、最新一条在后', () => {
    const once = appendAnswer(FIXTURE_STATE, 'QA-01', '本地盘', '', 't1');
    const twice = appendAnswer(once, 'QA-01', '对象存储', '改主意', 't2');
    expect(twice.answers).toHaveLength(FIXTURE_STATE.answers.length + 2);
    expect(latestAnswer(twice, 'QA-01')?.answer).toBe('对象存储');
    expect(twice.answers.map((item) => item.at)).toContain('t1');
  });
});

describe('分组与处理状态', () => {
  it('待确认 / 已答复 / 已处理各按状态落组，closed 且没答复的不进组', () => {
    expect(groupFor(FIXTURE_QUESTIONS[0]!, FIXTURE_STATE)).toBe('pending');
    expect(groupFor(FIXTURE_QUESTIONS[2]!, FIXTURE_STATE)).toBe('answered');
    expect(groupFor(FIXTURE_QUESTIONS[3]!, FIXTURE_STATE)).toBe('processed');
    expect(
      groupFor({ ...FIXTURE_QUESTIONS[0]!, closed: true }, FIXTURE_STATE),
    ).toBeNull();
  });

  it('快照按主题、编号排，三组计数与夹具一致', () => {
    const snapshot = buildSnapshot(
      FIXTURE_QUESTIONS,
      FIXTURE_STATE,
      '2026-11-28T00:00:00+08:00',
    );
    expect(snapshot.generatedAt).toBe('2026-11-28T00:00:00+08:00');
    expect(snapshot.counts).toEqual({ pending: 2, answered: 1, processed: 1 });
    expect(snapshot.questions.map((item) => item.id)).toEqual([
      'QA-01',
      'QA-02',
      'QA-04',
      'QA-03',
    ]);
    expect(pendingAnswers(FIXTURE_QUESTIONS, FIXTURE_STATE).map((i) => i.id)).toEqual([
      'QA-03',
    ]);
  });

  it('landed / followup / withdrawn 都写进去，非法值被拒', () => {
    for (const status of ['landed', 'followup', 'withdrawn'] as const) {
      const next = markProcessed(FIXTURE_STATE, 'QA-03', status, '#1', '一句话', 't');
      expect(next.processed['QA-03']?.status).toBe(status);
      expect(groupFor(FIXTURE_QUESTIONS[2]!, next)).toBe('processed');
    }
    expect(() =>
      markProcessed(FIXTURE_STATE, 'QA-03', 'nope' as 'landed', '#1', '一句话', 't'),
    ).toThrow(InvalidConfirmationProcess);
    expect(() =>
      markProcessed(FIXTURE_STATE, 'QA-03', 'landed', '', '一句话', 't'),
    ).toThrow(InvalidConfirmationProcess);
  });

  it('校验错误带出原因码，端点据此回 400', () => {
    expect(new InvalidConfirmationAnswer('NOT_IN_OPTIONS').reason).toBe(
      'NOT_IN_OPTIONS',
    );
  });
});

describe('补充说明请求与说明', () => {
  const EXPLANATION = {
    at: '2026-11-28T04:00:00+08:00',
    asked: '上限是多少？',
    text: '第一段。\n\n第二段。\n- 要点一\n- 要点二\n<b>不是标签</b>',
  };

  it('清单接受可选的 explanations 字段，坏字段整块不认', () => {
    const withExplanation = FIXTURE_QUESTIONS.map((item) =>
      item.id === 'QA-02' ? { ...item, explanations: [EXPLANATION] } : item,
    );
    const parsed = parseQuestionList(JSON.stringify(withExplanation));
    expect(parsed.find((item) => item.id === 'QA-02')?.explanations).toEqual([
      EXPLANATION,
    ]);
    expect(
      () =>
        parseQuestionList(
          JSON.stringify([
            { ...FIXTURE_QUESTIONS[0], explanations: [{ at: 't' }] },
          ]),
        ),
    ).toThrow(InvalidConfirmationList);
  });

  it('请求只追加、带 answeredAt；最近一次没答才算「等补充」', () => {
    const once = appendClarification(FIXTURE_STATE, 'QA-01', '上限？', 't1');
    expect(latestClarification(once, 'QA-01')).toMatchObject({
      note: '上限？',
      at: 't1',
    });
    expect(once.clarifications).toHaveLength(1);
    expect(isAwaitingClarification(once, 'QA-01')).toBe(true);
    expect(isAwaitingClarification(once, 'QA-02')).toBe(false);

    const answered = markClarificationsAnswered(once, 'QA-01', 't2');
    expect(answered.clarifications?.[0]?.answeredAt).toBe('t2');
    expect(isAwaitingClarification(answered, 'QA-01')).toBe(false);

    const twice = appendClarification(answered, 'QA-01', '再问一次', 't3');
    expect(twice.clarifications).toHaveLength(2);
    expect(twice.clarifications?.[0]?.at).toBe('t1');
    expect(twice.clarifications?.[1]?.note).toBe('再问一次');
    expect(isAwaitingClarification(twice, 'QA-01')).toBe(true);
  });

  it('校验：空允许，2000 字允许，2001 字拒绝', () => {
    expect(clarificationError('')).toBeNull();
    expect(clarificationError('好'.repeat(2000))).toBeNull();
    expect(clarificationError('好'.repeat(2001))).toBe('TOO_LONG');
  });

  it('等补充的题进 awaiting 组，说明不改变答复状态；快照透传两份历史', () => {
    const asked = appendClarification(FIXTURE_STATE, 'QA-02', '为什么？', 't1');
    expect(groupFor(FIXTURE_QUESTIONS[1]!, asked)).toBe('awaiting');
    const explainedQuestions = FIXTURE_QUESTIONS.map((item) =>
      item.id === 'QA-02' ? { ...item, explanations: [EXPLANATION] } : item,
    );
    const answered = markClarificationsAnswered(asked, 'QA-02', 't2');
    expect(groupFor(explainedQuestions[1]!, answered)).toBe('pending');
    const snapshot = buildSnapshot(explainedQuestions, answered, 't3');
    const item = snapshot.questions.find((entry) => entry.id === 'QA-02');
    expect(item?.group).toBe('pending');
    expect(item?.explanations).toEqual([EXPLANATION]);
    expect(item?.clarifications).toEqual([
      { note: '为什么？', at: 't1', answeredAt: 't2' },
    ]);
    expect(snapshot.counts).toEqual({ pending: 2, answered: 1, processed: 1 });
  });

  it('坏记录被丢掉，clarifications 只留合法条目', () => {
    const normalized = normalizeConfirmationState({
      clarifications: [
        { id: 'QA-01', note: '好', at: 't1' },
        { id: 'QA-01', note: '好', at: 't2', answeredAt: 't3' },
        { id: 'QA-02' },
      ],
    });
    expect(normalized.clarifications).toEqual([
      { id: 'QA-01', note: '好', at: 't1' },
      { id: 'QA-01', note: '好', at: 't2', answeredAt: 't3' },
    ]);
  });
});
