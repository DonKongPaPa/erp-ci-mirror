import type { DatabaseConnection } from '@nocobase/db';
import type { I18nRuntime, Translator } from '@nocobase/i18n';
import {
  describeNotificationTemplateChannel,
  type NotificationConfigInput,
  type NotificationService,
  type NotificationTemplateDefinition,
  type NotificationTemplateRegistry,
} from '@nocobase/app-plugin-notification/server';
import { createServiceToken, type ServiceToken } from '@nocobase/service-provider';

import type { PeopleQueryService } from './providers/departments.js';

/**
 * R-017 M4：四个固定时点加超时提醒的通知。
 *
 * 模板在代码里注册（设计不建模板表），文案走 app-local 词条。内容只有单据标识、
 * 流程名与申请人姓名，不带邮箱、手机号、单据正文或金额。
 * 发送只在 lifecycle 转移提交之后的效果里，或定时扫描里；业务事务回滚不会留下通知。
 * 幂等键跟着「业务事实 + 版本」走，同一事实重放不重发；进程内投递失败不影响主流程。
 */
export const APPROVAL_NOTIFICATION_CHANNEL = 'inbox';
export const APPROVAL_NOTIFICATION_SOURCE = 'approval';
export const APPROVAL_NOTIFICATION_NAMESPACE = 'app-local';

export type ApprovalNotificationKind =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'sendBack'
  | 'reminder';

export const APPROVAL_NOTIFICATION_KINDS: readonly ApprovalNotificationKind[] = [
  'submit',
  'approve',
  'reject',
  'sendBack',
  'reminder',
];

export interface ApprovalNotificationEvent {
  readonly kind: ApprovalNotificationKind;
  readonly approvalId: string;
  readonly workflowKey: string;
  readonly applicantId: string;
  /** 幂等键里的版本号：同一张单同一类事件同一版本只发一次。 */
  readonly version: number;
  /** 任务级提醒指定唯一任务；流程级与四个时点由服务端解析收件人。 */
  readonly taskId?: string;
}

/** 幂等键：任务级提醒按任务标识，其余按单据与版本。 */
export function idempotencyKeyOf(event: ApprovalNotificationEvent): string {
  const target = event.taskId ?? `${event.approvalId}:${event.version}`;
  return `${APPROVAL_NOTIFICATION_SOURCE}:${event.kind}:${target}`;
}

export function renderApprovalNotification(
  t: Translator,
  kind: ApprovalNotificationKind,
  approvalId: string,
  workflowKey: string,
  applicantName: string,
): { title: string; body: string } {
  return {
    title: t(`approvalNotifications.${kind}.title`, { workflowKey }),
    body: t(`approvalNotifications.${kind}.body`, {
      approvalId,
      workflowKey,
      applicantName,
    }),
  };
}

function adminText(key: string, defaultValue: string) {
  return {
    ns: APPROVAL_NOTIFICATION_NAMESPACE,
    key: `approvalNotifications.${key}`,
    defaultValue,
  };
}

const NAMES: Record<ApprovalNotificationKind, string> = {
  submit: '提交待审',
  approve: '审批通过',
  reject: '审批拒绝',
  sendBack: '审批退回',
  reminder: '超时提醒',
};

const RECIPIENTS: Record<ApprovalNotificationKind, string> = {
  submit: '当前轮次待处理的审批人',
  approve: '申请人',
  reject: '申请人',
  sendBack: '申请人',
  reminder: '过期任务的审批人',
};

export function approvalNotificationTemplates(
  i18n: I18nRuntime,
  config: NotificationConfigInput | undefined,
): readonly NotificationTemplateDefinition[] {
  return APPROVAL_NOTIFICATION_KINDS.map((kind) => ({
    id: `approval.${kind}`,
    contributor: 'app-local',
    contributorLabel: adminText('contributor', '审批'),
    category: adminText('category', '审批'),
    name: adminText(`${kind}.name`, NAMES[kind]),
    trigger: adminText(`${kind}.trigger`, `${NAMES[kind]}之后。`),
    recipients: adminText(`${kind}.recipients`, RECIPIENTS[kind]),
    businessRule: adminText(
      'businessRule',
      '只在转移提交之后或定时扫描里发一次；同一幂等键重放不重发。',
    ),
    locales: ['zh-CN', 'en-US'],
    languagePolicy: adminText('languagePolicy', '按应用默认语言发送一条。'),
    variables: [
      { name: 'approvalId', description: adminText('variables.approvalId', '审批单标识') },
      { name: 'workflowKey', description: adminText('variables.workflowKey', '流程名') },
      { name: 'applicantName', description: adminText('variables.applicantName', '申请人姓名') },
    ],
    channels: () => [
      describeNotificationTemplateChannel(config, APPROVAL_NOTIFICATION_CHANNEL, {
        label: adminText('channel', '站内收件箱'),
      }),
    ],
    render: async (locale, example) => {
      await i18n.ensureLocaleLoaded(locale);
      const t = i18n.getFixedT(APPROVAL_NOTIFICATION_NAMESPACE, locale);
      return renderApprovalNotification(
        t,
        kind,
        example === 'definition' ? '{{approvalId}}' : 'APPROVAL-0001',
        example === 'definition' ? '{{workflowKey}}' : 'leave',
        example === 'definition' ? '{{applicantName}}' : '申请人',
      );
    },
  }));
}

export function registerApprovalNotificationTemplates(
  registry: NotificationTemplateRegistry,
  i18n: I18nRuntime,
  config: NotificationConfigInput | undefined,
): () => void {
  const undos = approvalNotificationTemplates(i18n, config).map((definition) =>
    registry.register(definition),
  );
  return () => {
    for (const undo of undos) undo();
  };
}

export interface ApprovalNotifier {
  notify(event: ApprovalNotificationEvent): Promise<boolean>;
}

export interface ApprovalNotifierOptions {
  readonly notifications: NotificationService;
  readonly i18n: I18nRuntime;
  readonly connection: DatabaseConnection;
  readonly people: PeopleQueryService;
}

/** 待处理任务的审批人；任务级提醒只看指定任务，且必须是待处理。 */
async function recipientsOf(
  connection: DatabaseConnection,
  event: ApprovalNotificationEvent,
): Promise<readonly string[]> {
  if (event.kind !== 'submit' && event.kind !== 'reminder') {
    return [event.applicantId];
  }
  if (event.taskId !== undefined) {
    const task = await connection
      .query.selectFrom('approvalRecords')
      .select(['assigneeId', 'status'])
      .where('id', '=', event.taskId)
      .executeTakeFirst();
    return task?.status === 'pending' && typeof task.assigneeId === 'string'
      ? [task.assigneeId]
      : [];
  }
  const rounds = await connection
    .query.selectFrom('approvalRounds')
    .select(['id'])
    .where('approvalId', '=', event.approvalId)
    .execute();
  if (rounds.length === 0) return [];
  const records = await connection
    .query.selectFrom('approvalRecords')
    .select(['assigneeId'])
    .where('roundId', 'in', rounds.map((round) => String(round.id)))
    .where('status', '=', 'pending')
    .execute();
  return [
    ...new Set(
      records
        .map((row) => row.assigneeId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

export function createApprovalNotifier({
  notifications,
  i18n,
  connection,
  people,
}: ApprovalNotifierOptions): ApprovalNotifier {
  return {
    async notify(event) {
      const locale = i18n.getDefaultLocale();
      await i18n.ensureLocaleLoaded(locale);
      const t = i18n.getFixedT(APPROVAL_NOTIFICATION_NAMESPACE, locale);
      const named = await people.byIds([event.applicantId]);
      const applicantName = named[0]?.name ?? '';
      const content = renderApprovalNotification(
        t,
        event.kind,
        event.approvalId,
        event.workflowKey,
        applicantName,
      );
      const to = await recipientsOf(connection, event);
      if (to.length === 0) return false;
      const result = await notifications.send({
        idempotencyKey: idempotencyKeyOf(event),
        source: { type: APPROVAL_NOTIFICATION_SOURCE, referenceId: event.approvalId },
        messages: {
          [APPROVAL_NOTIFICATION_CHANNEL]: {
            to: to as [string, ...string[]],
            title: content.title,
            body: content.body,
            target: { type: 'route', path: '/approvals' },
          },
        },
      });
      return result.deduplicated === false;
    },
  };
}

export const approvalNotifierToken: ServiceToken<ApprovalNotifier> =
  createServiceToken<ApprovalNotifier>('app/approval-notifier');
