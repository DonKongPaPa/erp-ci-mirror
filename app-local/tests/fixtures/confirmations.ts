import type { ConfirmationQuestion, ConfirmationState } from '../../server/dev-tools/confirmations.js';

/** R-083 夹具（编号用 QA-xx，不冒充真实的需求编号）：两条待确认（单选/填空各一）、一条已答复、一条已处理。 */
export const FIXTURE_QUESTIONS: readonly ConfirmationQuestion[] = [
  {
    id: 'QA-01',
    topic: 'ALPHA',
    question: '夹具：文件放本地盘还是对象存储？',
    default: '本地盘。',
    options: ['本地盘', '对象存储', '其他'],
    source: 'HANDOFF/tasks/waiting-on-user.md',
  },
  {
    id: 'QA-02',
    topic: 'BETA',
    question: '夹具：已过账的单据录错后怎么办？',
    default: '不能改原单。',
    source: 'HANDOFF/tasks/waiting-on-user.md',
  },
  {
    id: 'QA-03',
    topic: 'GAMMA',
    question: '夹具：成品按不按序列号进台账？',
    default: '不进。',
    options: ['不进', '进', '其他'],
    source: 'HANDOFF/tasks/waiting-on-user.md',
  },
  {
    id: 'QA-04',
    topic: 'DELTA',
    question: '夹具：审查由谁看？',
    default: '管理员。',
    source: 'HANDOFF/tasks/waiting-on-user.md',
  },
];

export const FIXTURE_STATE: ConfirmationState = {
  answers: [
    {
      id: 'QA-03',
      answer: '不进',
      note: '按默认',
      at: '2026-11-28T01:00:00+08:00',
    },
    {
      id: 'QA-04',
      answer: '管理员',
      note: '',
      at: '2026-11-28T02:00:00+08:00',
    },
  ],
  processed: {
    'QA-04': {
      id: 'QA-04',
      status: 'landed',
      ref: '#321',
      at: '2026-11-28T03:00:00+08:00',
      note: '已合并',
    },
  },
};

export const FIXTURE_QUESTION_TEXT = '文件放本地盘还是对象存储';
