import { randomUUID } from 'node:crypto';

import type { DatabaseConnection, QueryAdapter } from '@nocobase/db';

/**
 * R-026 七天提醒的扫描函数（验收 32、33）。
 *
 * 不做授权（定时任务没有请求主体），只读消息表、初筛表、提醒记录表三处的几列。
 * 通知发送器由调用方注入，函数本身不碰任何传输；测试里放的是假发送器。
 *
 * 顺序照设计：先记后发 —— 先把这一回的钥匙写进提醒记录表，再发通知；发失败
 * 不删记录，下一回用一把新钥匙再试。一把钥匙至多被投递一次。回数最多五回，
 * 满了只记一行日志。两轮扫描重叠时靠「带谓词的更新」抢占：只有把那一行的
 * 回数从读到的值改成下一值的那一轮才发，改到零行的那一轮直接跳过。
 *
 * 抢占时把 `updatedAt` 写成认领时间，这一行在发送落地前是「已认领、未确认」；
 * 另一轮在认领窗口里遇到它就跳过，避免在通知服务落幂等键前的窗口里换钥匙补发。
 * 记成功时间的写库失败只记日志、继续下一张单，由下一轮按旧钥匙补记。
 */
export const REMINDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const REMINDER_UNKNOWN_GRACE_MS = 24 * 60 * 60 * 1000;
/** 认领窗口：用提醒记录行现有的 `updatedAt` 表达「已认领、未确认」，不加列。 */
export const REMINDER_CLAIM_GRACE_MS = 60 * 1000;
export const MAX_REMINDER_ATTEMPTS = 5;
export const FEEDBACK_REMINDER_JOB = 'app.feedback-reminder';
export const FEEDBACK_REMINDER_JOB_NAME = 'scan';
export const FEEDBACK_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ReminderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'unknown';

export interface ReminderNotificationResult {
  readonly status: ReminderStatus;
  /** 通知那一侧的更新时间；结果不明时用它判断是否已经放了一天。 */
  readonly updatedAt: string;
}

/** 提醒里只有提交时间、入口与收件用的用户标识，没有原文、邮箱或手机号。 */
export interface ReminderNotification {
  readonly idempotencyKey: string;
  /** 服务端解析出来的提交人用户标识，不是收件地址。 */
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly target: { readonly type: 'route'; readonly path: string };
}

export interface ReminderNotifier {
  send(message: ReminderNotification): Promise<ReminderNotificationResult>;
  getByIdempotencyKey(key: string): Promise<ReminderNotificationResult | undefined>;
}

export interface ReminderRow {
  readonly id: string;
  readonly feedbackId: string;
  readonly attempts: number;
  readonly lastKey: string | null;
  readonly notifiedAt: string | Date | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface ScanFeedbackRemindersOptions {
  readonly connection: DatabaseConnection;
  readonly notifier: ReminderNotifier;
  /** 可控时钟；扫描函数不读真实时间。 */
  readonly now: Date;
  readonly log?: (message: string) => void;
}

interface Candidate {
  readonly feedbackId: string;
  readonly ownerId: string;
  readonly createdAt: string | Date;
}

const keyFor = (feedbackId: string, attempt: number) =>
  `feedback-reminder:${feedbackId}:${attempt}`;

const isSuccess = (status: ReminderStatus) =>
  status === 'completed' || status === 'partial';

const isInFlight = (status: ReminderStatus) =>
  status === 'pending' || status === 'processing';

const asTime = (value: unknown): number => {
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** 初筛行不存在时 outcome 为空，按设计「不是 reviewed」算未处理。 */
async function candidateIds(
  query: QueryAdapter,
  now: Date,
): Promise<readonly Candidate[]> {
  const messages = (await query
    .selectFrom('fqcMessages')
    .select(['id', 'ownerId', 'status', 'createdAt'])
    .where('status', '=', 'open')
    .where('ownerId', 'is not', null)
    .execute()) as unknown as ReadonlyArray<{
    id: string;
    ownerId: string | null;
    status: string;
    createdAt: string | Date;
  }>;

  const screenings = (await query
    .selectFrom('fqcScreenings')
    .select(['messageId', 'outcome'])
    .execute()) as unknown as ReadonlyArray<{
    messageId: string;
    outcome: string | null;
  }>;
  const outcomeByMessage = new Map(
    screenings.map((row) => [String(row.messageId), row.outcome]),
  );

  const reminders = (await query
    .selectFrom('fqcFeedbackReminders')
    .select(['feedbackId', 'notifiedAt'])
    .execute()) as unknown as ReadonlyArray<{
    feedbackId: string;
    notifiedAt: string | Date | null;
  }>;
  const notified = new Set(
    reminders
      .filter((row) => row.notifiedAt !== null && row.notifiedAt !== undefined)
      .map((row) => String(row.feedbackId)),
  );

  const cutoff = now.getTime() - REMINDER_AGE_MS;
  const candidates: Candidate[] = [];
  for (const message of messages) {
    const ownerId = message.ownerId;
    if (ownerId === null || ownerId === undefined || String(ownerId) === '') continue;
    if (outcomeByMessage.get(String(message.id)) === 'reviewed') continue;
    if (notified.has(String(message.id))) continue;
    const createdAt = asTime(message.createdAt);
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
    candidates.push({
      feedbackId: String(message.id),
      ownerId: String(ownerId),
      createdAt: message.createdAt,
    });
  }
  return candidates;
}

async function readRow(
  query: QueryAdapter,
  feedbackId: string,
): Promise<ReminderRow | undefined> {
  return (await query
    .selectFrom('fqcFeedbackReminders')
    .selectAll()
    .where('feedbackId', '=', feedbackId)
    .executeTakeFirst()) as unknown as ReminderRow | undefined;
}

/**
 * 占位：没有提醒记录时先插一行空记录。唯一冲突来自重叠的扫描，重读即可；
 * 若重读仍没有行，说明不是冲突而是真的写失败，把原错误抛出去。
 */
async function ensureRow(
  query: QueryAdapter,
  feedbackId: string,
  now: Date,
): Promise<ReminderRow> {
  const existing = await readRow(query, feedbackId);
  if (existing) return existing;

  let insertError: unknown;
  try {
    await query
      .insertInto('fqcFeedbackReminders')
      .values({
        id: randomUUID(),
        feedbackId,
        attempts: 0,
        lastKey: null,
        notifiedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  } catch (error) {
    insertError = error;
  }
  const row = await readRow(query, feedbackId);
  if (!row)
    throw insertError instanceof Error
      ? insertError
      : new Error('无法写入提醒记录占位行', { cause: insertError });
  return row;
}

async function markNotified(
  query: QueryAdapter,
  feedbackId: string,
  key: string,
  now: Date,
): Promise<void> {
  await query
    .updateTable('fqcFeedbackReminders')
    .set({ notifiedAt: now, updatedAt: now })
    .where('feedbackId', '=', feedbackId)
    .where('lastKey', '=', key)
    .where('notifiedAt', 'is', null)
    .execute();
}

/** 接收 now，不依赖定时器，直接测（R-017 超时提醒的做法）。 */
export async function scanFeedbackReminders({
  connection,
  notifier,
  now,
  log = () => {},
}: ScanFeedbackRemindersOptions): Promise<void> {
  const query = connection.query;
  const candidates = await candidateIds(query, now);

  for (const candidate of candidates) {
    // 重读而不是复用初筛时的快照：上一轮可能刚好在这期间插了占位行。
    const row = await ensureRow(query, candidate.feedbackId, now);
    if (row.notifiedAt !== null && row.notifiedAt !== undefined) continue;

    if (row.lastKey) {
      // 认领窗口：`updatedAt` 在抢占时写成认领时间。通知服务从发送到落幂等键
      // 之间有一段异步窗口，另一个重叠的轮次在这段窗口里查不到旧钥匙；若照
      // 「查不到就换钥匙」处理，就会多发一条。窗口内只跳过，下一轮再按旧钥匙问。
      const claimedAt = asTime(row.updatedAt);
      if (
        Number.isFinite(claimedAt) &&
        now.getTime() - claimedAt < REMINDER_CLAIM_GRACE_MS
      )
        continue;

      const previous = await notifier.getByIdempotencyKey(row.lastKey);
      if (previous) {
        if (isSuccess(previous.status)) {
          // 「发成功了却没记上时间」：只补记时间，不再发。写库失败只记日志，
          // 下一轮按旧钥匙再补，不能让它中断整批候选。
          try {
            await markNotified(query, candidate.feedbackId, row.lastKey, now);
          } catch (error) {
            log(
              `feedback-reminder: ${candidate.feedbackId} 补记发出时间失败，下一轮再补: ${String(error)}`,
            );
          }
          continue;
        }
        if (isInFlight(previous.status)) continue;
        if (previous.status === 'unknown') {
          const updatedAt = asTime(previous.updatedAt);
          if (
            Number.isFinite(updatedAt) &&
            now.getTime() - updatedAt < REMINDER_UNKNOWN_GRACE_MS
          )
            continue;
        }
        // failed、结果不明已满一天、或查不到：换一把新钥匙再试。
      }
    }

    const attempts = Number(row.attempts ?? 0);
    if (attempts >= MAX_REMINDER_ATTEMPTS) {
      log(
        `feedback-reminder: ${candidate.feedbackId} 已试满 ${MAX_REMINDER_ATTEMPTS} 回，不再提醒`,
      );
      continue;
    }

    const nextAttempts = attempts + 1;
    const key = keyFor(candidate.feedbackId, nextAttempts);
    // 带谓词的更新就是并发抢占：同一行、同一个回数，只有一轮能改成下一回。
    const claimed = await query
      .updateTable('fqcFeedbackReminders')
      .set({ attempts: nextAttempts, lastKey: key, updatedAt: now })
      .where('feedbackId', '=', candidate.feedbackId)
      .where('attempts', '=', attempts)
      .where('notifiedAt', 'is', null)
      .execute();
    if ((claimed.updatedCount ?? 0) === 0) continue;

    const submittedAt = new Date(
      asTime(candidate.createdAt),
    ).toISOString();
    let result: ReminderNotificationResult;
    try {
      result = await notifier.send({
        idempotencyKey: key,
        to: candidate.ownerId,
        title: '反馈单待处理提醒',
        body: `你于 ${submittedAt} 提交的反馈单超过七天仍未处理，请到反馈单列表查看。`,
        target: { type: 'route', path: '/feedbacks' },
      });
    } catch {
      // 发送失败：占位行与回数都在，下一回换钥匙再试。
      continue;
    }
    if (isSuccess(result.status)) {
      try {
        await markNotified(query, candidate.feedbackId, key, now);
      } catch (error) {
        log(
          `feedback-reminder: ${candidate.feedbackId} 记发出时间失败，下一轮按旧钥匙补记: ${String(error)}`,
        );
      }
    }
    // 结果不明或还在投递中：什么都不做，下一回按这把钥匙再问。
  }
}
