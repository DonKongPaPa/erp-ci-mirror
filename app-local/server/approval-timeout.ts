import type { DatabaseConnection } from '@nocobase/db';

import type { ApprovalNotifier } from './approval-notifications.js';
import { isReminderDue } from './lifecycles/approvals-engine.js';

/**
 * R-017 M4：任务级超时的定时扫描。
 *
 * lifecycle 的触发器只看得到流程状态，看不到每条任务的 dueAt，所以这里扫审批记录。
 * 测试直接传 `now`，不依赖定时器；真实定时器由 provider 按固定间隔调用同一个函数。
 *
 * 只提醒一次靠两道：条件更新要求 `lastRemindedAt` 为空（抢不到就跳过），
 * 通知再带任务级幂等键。这里先抢占标记再发，发送失败不重发 —— 与设计的
 * 「先发后标记」有一处顺序差异，原因是表上只有 `lastRemindedAt` 一列，
 * 没有单独的「已认领」列；幂等键保证不会重复投递。
 */
export const APPROVAL_REMINDER_JOB = 'app.approval-reminder';
export const APPROVAL_REMINDER_JOB_NAME = 'scan';
export const APPROVAL_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
/** 固定锚点，重启不会把扫描一直往后推。 */
export const APPROVAL_REMINDER_ANCHOR = new Date('2026-01-01T00:00:00.000Z');

export interface ScanApprovalTimeoutsOptions {
  readonly connection: DatabaseConnection;
  readonly notifier: ApprovalNotifier;
  /** 可控时钟；扫描函数不读真实时间。 */
  readonly now: Date;
  readonly log?: (message: string) => void;
}

export interface DueTask {
  readonly id: string;
  readonly roundId: string;
  readonly assigneeId: string;
  readonly dueAt: string | Date | null;
  readonly lastRemindedAt: string | Date | null;
}

export async function scanApprovalTimeouts({
  connection,
  notifier,
  now,
  log = () => {},
}: ScanApprovalTimeoutsOptions): Promise<number> {
  const query = connection.query;
  const rows = (await query
    .selectFrom('approvalRecords')
    .select(['id', 'roundId', 'assigneeId', 'status', 'dueAt', 'lastRemindedAt'])
    .where('status', '=', 'pending')
    .where('dueAt', '<=', now)
    .where('lastRemindedAt', 'is', null)
    .execute()) as unknown as ReadonlyArray<{
    id: unknown;
    roundId: unknown;
    assigneeId: unknown;
    status: string;
    dueAt: string | Date | null;
    lastRemindedAt: string | Date | null;
  }>;

  let sent = 0;
  for (const row of rows) {
    const task: DueTask = {
      id: String(row.id),
      roundId: String(row.roundId),
      assigneeId: String(row.assigneeId),
      dueAt: row.dueAt,
      lastRemindedAt: row.lastRemindedAt,
    };
    // 判定用同一个纯函数（引擎 M3 已钉住：到期、待处理、没提醒过）。
    if (!isReminderDue({ ...task, status: 'pending' }, now)) continue;
    const claimed = await query
      .updateTable('approvalRecords')
      .set({ lastRemindedAt: now })
      .where('id', '=', task.id)
      .where('status', '=', 'pending')
      .where('lastRemindedAt', 'is', null)
      .execute();
    if ((claimed.updatedCount ?? 0) === 0) continue;
    const round = await query
      .selectFrom('approvalRounds')
      .select(['approvalId'])
      .where('id', '=', task.roundId)
      .executeTakeFirst();
    if (!round) continue;
    const approval = await query
      .selectFrom('approvals')
      .select(['workflowKey', 'applicantId'])
      .where('id', '=', String(round.approvalId))
      .executeTakeFirst();
    if (!approval) continue;
    try {
      const delivered = await notifier.notify({
        kind: 'reminder',
        approvalId: String(round.approvalId),
        workflowKey: String(approval.workflowKey),
        applicantId: String(approval.applicantId),
        version: 0,
        taskId: task.id,
      });
      if (delivered) sent += 1;
    } catch (error) {
      log(
        `approval-reminder: ${task.id} 投递失败，幂等键会挡住重发: ${String(error)}`,
      );
    }
  }
  return sent;
}
