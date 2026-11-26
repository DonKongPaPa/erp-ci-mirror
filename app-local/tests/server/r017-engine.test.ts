import {
  LifecycleError,
  SYSTEM_ACTOR,
  planTransition,
} from '@nocobase/lifecycle';
import { createLifecycleTestKit } from '@nocobase/lifecycle/testing';
import { describe, expect, it } from 'vitest';

import {
  approvalExpectation,
  createApprovalReviewerResolver,
  decideNode,
  isReminderDue,
  isTaskOverdue,
  pendingTaskClaim,
  planApprovalNodes,
  type ApprovalNode,
  type ApprovalRecordLike,
  type ReviewerServices,
} from '../../server/lifecycles/approvals-engine.js';
import {
  APPROVAL_STATUSES,
  approvalsLifecycle,
} from '../../server/lifecycles/approvals.js';

/**
 * R-017 S3：审批引擎核心的纯函数与状态机。全在内存里跑，不连库。
 * 真仓储上的版本条件更新见 tests/database/r017-engine-concurrency.test.ts。
 */

const kit = () => createLifecycleTestKit(approvalsLifecycle);
const system = { actor: SYSTEM_ACTOR };

async function refusal(code: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(LifecycleError);
    expect((error as LifecycleError).code).toBe(code);
    return error as LifecycleError;
  }
  throw new Error(`expected a ${code} refusal`);
}

const task = (
  status: string,
  dueAt: string | null,
  lastRemindedAt: string | null = null,
) => ({ id: 'task-1', status, dueAt, lastRemindedAt });

const record = (status: string, seq: number): ApprovalRecordLike => ({
  id: `r-${status}-${seq}`,
  nodeKey: 'manager',
  status: status as ApprovalRecordLike['status'],
  seq,
  origin: 'normal',
});

describe('R-017 验收1：七态可达、非法转移全组合被拒', () => {
  it('九条转移按设计表走，三个终态没有出路', async () => {
    const k = kit();
    expect(approvalsLifecycle.name).toBe('approvals');
    expect(approvalsLifecycle.key).toBe('approvals');
    expect(approvalsLifecycle.version).toBe(1);
    expect(approvalsLifecycle.definitionField).toBe('lifecycleDefinition');
    expect(APPROVAL_STATUSES).toEqual([
      'draft',
      'submitted',
      'processing',
      'approved',
      'rejected',
      'returned',
      'aborted',
    ]);
    for (const final of ['approved', 'rejected', 'aborted'] as const) {
      expect(approvalsLifecycle.stateInfo.get(final)?.final).toBe(true);
    }

    let a = await k.start({
      workflowKey: 'leave',
      applicantId: 'u1',
      currentRound: 0,
    });
    expect(a.status).toBe('draft');
    a = await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    expect([a.status, a.currentRound]).toEqual(['submitted', 1]);
    a = await k.fire(a, 'process', {}, system);
    expect(a.status).toBe('processing');
    a = await k.fire(a, 'approve', {}, system);
    expect(a.status).toBe('approved');
    await refusal('INVALID_STATE', () => k.fire(a, 'reject', {}, system));

    let b = await k.start({ currentRound: 0 });
    b = await k.fire(b, 'submit', {}, { actor: { id: 'applicant' } });
    b = await k.fire(b, 'reject', {}, system);
    expect(b.status).toBe('rejected');

    let c = await k.start({ currentRound: 0 });
    c = await k.fire(c, 'abort', {}, { actor: { id: 'applicant' } });
    expect(c.status).toBe('aborted');

    let d = await k.start({ currentRound: 0 });
    d = await k.fire(d, 'submit', {}, { actor: { id: 'applicant' } });
    d = await k.fire(d, 'withdraw', {}, { actor: { id: 'applicant' } });
    expect(d.status).toBe('draft');
  });

  it('退回后重新提交开新轮次，指定目标走 route 回处理中', async () => {
    const k = kit();
    let a = await k.start({ currentRound: 0 });
    a = await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    a = await k.fire(a, 'process', {}, system);
    a = await k.fire(a, 'sendBack', {}, system);
    expect(a.status).toBe('returned');
    a = await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    expect([a.status, a.currentRound]).toEqual(['submitted', 2]);
    expect(await k.history(a)).toEqual([
      '$create',
      'submit',
      'process',
      'sendBack',
      'submit',
    ]);

    let b = await k.start({ currentRound: 0 });
    b = await k.fire(b, 'submit', {}, { actor: { id: 'applicant' } });
    b = await k.fire(b, 'sendBack', { returnToNodeKey: 'finance' }, system);
    expect(b.status).toBe('processing');
    b = await k.fire(b, 'approve', {}, system);
    expect(b.status).toBe('approved');
  });

  it('非法 from × action 组合一律被拒且状态不变', async () => {
    const states = [
      'draft',
      'submitted',
      'processing',
      'returned',
      'approved',
      'rejected',
      'aborted',
    ] as const;
    const allowed: Record<string, string[]> = {
      draft: ['submit', 'abort'],
      submitted: [
        'process',
        'delegate',
        'addSign',
        'approve',
        'reject',
        'sendBack',
        'withdraw',
        'abort',
      ],
      processing: [
        'delegate',
        'addSign',
        'approve',
        'reject',
        'sendBack',
        'abort',
      ],
      returned: ['submit'],
      approved: [],
      rejected: [],
      aborted: [],
    };
    const actions = [
      'submit',
      'process',
      'delegate',
      'addSign',
      'approve',
      'reject',
      'sendBack',
      'withdraw',
      'abort',
    ];
    for (const state of states) {
      for (const action of actions) {
        if (allowed[state].includes(action)) continue;
        const k = kit();
        const record = await k.start({ currentRound: 0 });
        // start 只能进初始态：用 update 直接摆到被测状态，绕开允许的流转。
        k.update(record, { status: state, lifecycleDefinition: 'approvals' });
        await refusal('INVALID_STATE', () =>
          k.fire(record, action, {}, system),
        );
        expect(k.get(record).status).toBe(state);
      }
    }
  });

  it('结论转移是系统转移：页面可用动作里没有它们', async () => {
    const k = kit();
    const a = await k.start({ currentRound: 0 });
    await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    const actions = (await k.available(a)).map((entry) => entry.name);
    for (const name of [
      'approve',
      'reject',
      'sendBack',
      'process',
      'delegate',
      'addSign',
    ]) {
      expect(actions).not.toContain(name);
    }
    expect(approvalsLifecycle.transitions.get('approve')?.manual).toBe(false);
    expect(approvalsLifecycle.transitions.get('delegate')?.manual).toBe(false);
  });

  it('delegate / addSign 从两个起点都能流转；abort 从三个起点都进终态', async () => {
    const k = kit();
    let a = await k.start({ currentRound: 0 });
    a = await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    const v1 = a.lifecycleVersion ?? 0;
    a = await k.fire(a, 'delegate', {}, system);
    expect(a.status).toBe('processing');
    expect(a.lifecycleVersion).toBe(v1 + 1);
    const v2 = a.lifecycleVersion ?? 0;
    a = await k.fire(a, 'addSign', {}, system);
    expect(a.status).toBe('processing');
    expect(a.lifecycleVersion).toBe(v2 + 1);
    expect((await k.history(a)).slice(-2)).toEqual(['delegate', 'addSign']);

    const submitted = kit();
    let b = await submitted.start({ currentRound: 0 });
    b = await submitted.fire(b, 'submit', {}, { actor: { id: 'applicant' } });
    b = await submitted.fire(b, 'abort', {}, { actor: { id: 'applicant' } });
    expect(b.status).toBe('aborted');

    const processing = kit();
    let c = await processing.start({ currentRound: 0 });
    c = await processing.fire(c, 'submit', {}, { actor: { id: 'applicant' } });
    c = await processing.fire(c, 'process', {}, system);
    c = await processing.fire(c, 'abort', {}, { actor: { id: 'applicant' } });
    expect(c.status).toBe('aborted');
  });
});

describe('R-017 验收9：条件分支 route 与多一级节点计划', () => {
  it('route 按输入选择目标态，planTransition 不改状态也选中正确分支', async () => {
    const k = kit();
    let a = await k.start({ currentRound: 0 });
    a = await k.fire(a, 'submit', {}, { actor: { id: 'applicant' } });
    const plan = await planTransition(approvalsLifecycle, a, 'sendBack', {
      actor: SYSTEM_ACTOR,
      input: { returnToNodeKey: 'finance' },
      parameters: approvalsLifecycle.parameters,
      services: {},
      now: new Date(),
    });
    expect(plan.to).toBe('processing');
    expect(plan.nextVersion).toBe((a.lifecycleVersion ?? 0) + 1);

    const plain = await planTransition(approvalsLifecycle, a, 'sendBack', {
      actor: SYSTEM_ACTOR,
      input: {},
      parameters: approvalsLifecycle.parameters,
      services: {},
      now: new Date(),
    });
    expect(plain.to).toBe('returned');
  });

  it('金额超过阈值才多一级；两条链的中间态都能断言', () => {
    const base: ApprovalNode[] = [
      { key: 'manager', negotiation: 'any', reviewers: [] },
      { key: 'hr', negotiation: 'all', reviewers: [] },
    ];
    const extra: ApprovalNode = {
      key: 'finance',
      negotiation: 'vote',
      threshold: 0.5,
      reviewers: [],
    };
    const parameters = { extraApprovalThreshold: 100, extraNode: extra };
    expect(
      planApprovalNodes(base, { amount: 100, parameters }).map((n) => n.key),
    ).toEqual(['manager', 'hr']);
    const high = planApprovalNodes(base, { amount: 101, parameters });
    expect(high.map((n) => n.key)).toEqual(['manager', 'hr', 'finance']);
    expect(high[0]?.negotiation).toBe('any');
    expect(high[1]?.negotiation).toBe('all');
    expect(high[2]?.threshold).toBe(0.5);
  });
});

describe('R-017 验收3：四种审批模式的数票纯函数', () => {
  it('或签：一票通过即过，其余未投的票收场；全拒才拒', () => {
    const pending = [
      record('approved', 1),
      record('pending', 2),
      record('pending', 3),
    ];
    expect(decideNode(pending, { negotiation: 'any' })).toEqual({
      decision: 'approved',
      settleIds: ['r-pending-2', 'r-pending-3'],
      openIds: [],
    });
    expect(
      decideNode([record('rejected', 1), record('pending', 2)], {
        negotiation: 'any',
      }).decision,
    ).toBe('pending');
    expect(
      decideNode([record('rejected', 1), record('rejected', 2)], {
        negotiation: 'any',
      }).decision,
    ).toBe('rejected');
  });

  it('会签：全过才过、任拒即拒，转交退场的记录不挡路', () => {
    expect(
      decideNode([record('approved', 1), record('approved', 2)], {
        negotiation: 'all',
      }).decision,
    ).toBe('approved');
    expect(
      decideNode(
        [record('approved', 1), record('rejected', 2), record('pending', 3)],
        { negotiation: 'all' },
      ).decision,
    ).toBe('rejected');
    expect(
      decideNode([record('approved', 1), record('pending', 2)], {
        negotiation: 'all',
      }).decision,
    ).toBe('pending');
    // 会签判定按设计口径：没有待决、没有拒绝、至少一条通过。
    expect(
      decideNode(
        [record('approved', 1), record('delegated', 2), record('withdrawn', 3)],
        { negotiation: 'all' },
      ).decision,
    ).toBe('approved');
    // 没有待决也没有拒绝，但一条通过都没有：绝不能自动通过。
    expect(
      decideNode([record('delegated', 1), record('withdrawn', 2)], {
        negotiation: 'all',
      }).decision,
    ).toBe('pending');
  });

  it('投票：通过率严格大于阈值；转交退场的记录不进分母', () => {
    expect(
      decideNode(
        [record('approved', 1), record('approved', 2), record('rejected', 3)],
        { negotiation: 'vote', threshold: 0.5 },
      ).decision,
    ).toBe('approved');
    expect(
      decideNode([record('approved', 1), record('rejected', 2)], {
        negotiation: 'vote',
        threshold: 0.5,
      }).decision,
    ).toBe('rejected'); // 1/2 = 0.5，不严格大于
    expect(
      decideNode(
        [record('approved', 1), record('pending', 2), record('rejected', 3)],
        { negotiation: 'vote', threshold: 0.5 },
      ).decision,
    ).toBe('pending');
    // 2 通过 / 1 转交退场 / 1 拒绝：分母 3，2/3 > 0.5。
    expect(
      decideNode(
        [
          record('approved', 1),
          record('approved', 2),
          record('delegated', 3),
          record('rejected', 4),
        ],
        { negotiation: 'vote', threshold: 0.5 },
      ).decision,
    ).toBe('approved');
  });

  it('依次：只开放最靠前的未决任务，结果仍按协商规则', () => {
    const first = [record('pending', 1), record('pending', 2)];
    expect(decideNode(first, { negotiation: 'all', order: true })).toEqual({
      decision: 'pending',
      settleIds: [],
      openIds: ['r-pending-1'],
    });
    const second = [record('approved', 1), record('pending', 2)];
    expect(
      decideNode(second, { negotiation: 'all', order: true }).openIds,
    ).toEqual(['r-pending-2']);
    expect(
      decideNode(second, { negotiation: 'all', order: true }).decision,
    ).toBe('pending');
    expect(
      decideNode([record('approved', 1), record('approved', 2)], {
        negotiation: 'all',
        order: true,
      }).decision,
    ).toBe('approved');
    expect(
      decideNode([record('rejected', 1), record('pending', 2)], {
        negotiation: 'all',
        order: true,
      }).decision,
    ).toBe('rejected');
  });
});

describe('R-017 复核回归：assigned 计票、顺序与协商解耦', () => {
  it('assigned 是未决票：会签 [approved, assigned] 仍在途', () => {
    expect(
      decideNode([record('approved', 1), record('assigned', 2)], {
        negotiation: 'all',
      }).decision,
    ).toBe('pending');
  });

  it('assigned 进投票分母：[approved, approved, assigned] 阈值 0.7 不过', () => {
    const result = decideNode(
      [record('approved', 1), record('approved', 2), record('assigned', 3)],
      { negotiation: 'vote', threshold: 0.7 },
    );
    expect(result).toEqual({ decision: 'pending', settleIds: [], openIds: [] });
  });

  it('或签只有 assigned 时不结论；结论落定时 assigned 一起收场', () => {
    expect(
      decideNode([record('assigned', 1)], { negotiation: 'any' }).decision,
    ).toBe('pending');
    expect(
      decideNode([record('approved', 1), record('assigned', 2)], {
        negotiation: 'any',
      }),
    ).toEqual({
      decision: 'approved',
      settleIds: ['r-assigned-2'],
      openIds: [],
    });
  });

  it('会签与依次拒绝时，pending 与 assigned 全部收场', () => {
    expect(
      decideNode(
        [
          record('approved', 1),
          record('rejected', 2),
          record('pending', 3),
          record('assigned', 4),
        ],
        { negotiation: 'all' },
      ),
    ).toEqual({
      decision: 'rejected',
      settleIds: ['r-pending-3', 'r-assigned-4'],
      openIds: [],
    });
    expect(
      decideNode(
        [record('rejected', 1), record('pending', 2), record('assigned', 3)],
        { negotiation: 'all', order: true },
      ),
    ).toEqual({
      decision: 'rejected',
      settleIds: ['r-pending-2', 'r-assigned-3'],
      openIds: [],
    });
  });

  it('投票零票不自动结论', () => {
    expect(
      decideNode([record('delegated', 1), record('withdrawn', 2)], {
        negotiation: 'vote',
        threshold: 0.5,
      }).decision,
    ).toBe('pending');
  });

  it('省略 threshold 时默认 0.5', () => {
    expect(
      decideNode([record('approved', 1), record('rejected', 2)], {
        negotiation: 'vote',
      }).decision,
    ).toBe('rejected');
    expect(
      decideNode(
        [record('approved', 1), record('approved', 2), record('assigned', 3)],
        { negotiation: 'vote' },
      ).decision,
    ).toBe('approved');
    expect(
      decideNode(
        [
          record('approved', 1),
          record('approved', 2),
          record('approved', 3),
          record('rejected', 4),
        ],
        { negotiation: 'vote' },
      ).decision,
    ).toBe('approved');
  });

  it('order 只管开放，结论按 negotiation：依次 + 或签 / 投票 / 默认会签', () => {
    expect(
      decideNode([record('approved', 1), record('assigned', 2)], {
        negotiation: 'any',
        order: true,
      }),
    ).toEqual({
      decision: 'approved',
      settleIds: ['r-assigned-2'],
      openIds: [],
    });
    expect(
      decideNode(
        [record('approved', 1), record('assigned', 2), record('pending', 3)],
        { negotiation: 'vote', threshold: 0.4, order: true },
      ),
    ).toEqual({
      decision: 'pending',
      settleIds: [],
      openIds: ['r-assigned-2'],
    });
    expect(
      decideNode([record('approved', 1), record('assigned', 2)], {
        order: true,
      }),
    ).toEqual({
      decision: 'pending',
      settleIds: [],
      openIds: ['r-assigned-2'],
    });
  });

  it('重复的 extraNode key 不重复插入节点链', () => {
    const base: ApprovalNode[] = [
      { key: 'finance', negotiation: 'all', reviewers: [] },
    ];
    const extra: ApprovalNode = {
      key: 'finance',
      negotiation: 'vote',
      threshold: 0.5,
      reviewers: [],
    };
    expect(
      planApprovalNodes(base, {
        amount: 101,
        parameters: { extraApprovalThreshold: 100, extraNode: extra },
      }),
    ).toEqual(base);
  });

  it('非法日期不算到期；未到期且没有提醒记录也不该提醒', () => {
    const now = new Date('2026-11-26T10:00:00.000Z');
    expect(isTaskOverdue({ status: 'pending', dueAt: 'not-a-date' }, now)).toBe(
      false,
    );
    expect(
      isReminderDue(task('pending', '2026-11-26T11:00:00.000Z'), now),
    ).toBe(false);
  });
});

describe('R-017 任务级超时判定（只判定，不扫描）', () => {
  it('到期且仍待处理才算超时；临界一毫秒前不算', () => {
    const now = new Date('2026-11-26T10:00:00.000Z');
    expect(
      isTaskOverdue(task('pending', '2026-11-26T10:00:00.000Z'), now),
    ).toBe(true);
    expect(
      isTaskOverdue(
        task('pending', '2026-11-26T10:00:00.000Z'),
        new Date('2026-11-26T09:59:59.999Z'),
      ),
    ).toBe(false);
    expect(isTaskOverdue(task('pending', null), now)).toBe(false);
    for (const status of [
      'assigned',
      'approved',
      'rejected',
      'unprocessed',
      'delegated',
      'withdrawn',
    ]) {
      expect(isTaskOverdue(task(status, '2026-11-25T10:00:00.000Z'), now)).toBe(
        false,
      );
    }
  });

  it('只提醒一次靠 lastRemindedAt 为空这一道判定', () => {
    const now = new Date('2026-11-26T10:00:00.000Z');
    expect(
      isReminderDue(task('pending', '2026-11-26T09:00:00.000Z'), now),
    ).toBe(true);
    expect(
      isReminderDue(
        task('pending', '2026-11-26T09:00:00.000Z', '2026-11-26T09:30:00.000Z'),
        now,
      ),
    ).toBe(false);
  });
});

describe('R-017 三种审批人选择器（组内交集、组间并集、资格过滤）', () => {
  it('静态用户、部门编码、上下文变量三种来源按框架语义合并', async () => {
    const services: ReviewerServices = {
      usersOf: async (referenceId) =>
        referenceId === 'group-a' ? ['u1', 'u2'] : ['u2', 'u3'],
      departmentByCode: async (code) =>
        code === 'DEPT-1' ? { id: 'dept-1', managerId: 'u9' } : null,
      contextValue: (key) => (key === 'applicant-manager' ? 'u7' : undefined),
      eligible: async (userId) => userId !== 'u2',
    };
    const resolve = createApprovalReviewerResolver(services);
    const found = await resolve(
      [
        { group: 1, type: 'users', referenceId: 'group-a' },
        { group: 1, type: 'users', referenceId: 'group-b' },
        { group: 2, type: 'department', referenceId: 'DEPT-1' },
        { group: 3, type: 'context', referenceId: 'applicant-manager' },
      ],
      { scope: 'app', applicantId: 'u1' },
    );
    expect(found).toEqual(['u7', 'u9']);
    // 部门引用必须是编码，不是内部 id：拿到内部 id 时解析不到人。
    expect(
      await resolve([{ group: 1, type: 'department', referenceId: 'dept-1' }], {
        scope: 'app',
        applicantId: 'u1',
      }),
    ).toEqual([]);
  });
});

describe('R-017 并发两道防线的判定产物', () => {
  it('版本条件来自审批单当前版本号', () => {
    expect(approvalExpectation({ lifecycleVersion: 7 })).toEqual({
      version: 7,
    });
    expect(approvalExpectation({ lifecycleVersion: null })).toEqual({
      version: null,
    });
  });

  it('任务抢占谓词只认待处理状态', () => {
    expect(pendingTaskClaim({ id: 'task-1', status: 'pending' })).toEqual({
      id: 'task-1',
      where: { status: 'pending' },
    });
    expect(
      pendingTaskClaim({ id: 'task-1', status: 'approved' }).where.status,
    ).toBe('pending');
  });
});
