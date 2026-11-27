import type { I18nRuntime, Translator } from '@nocobase/i18n';
import {
  describeNotificationTemplateChannel,
  type NotificationConfigInput,
  type NotificationService,
  type NotificationTemplateDefinition,
  type NotificationTemplateRegistry,
} from '@nocobase/app-plugin-notification/server';
import { createServiceToken, type ServiceToken } from '@nocobase/service-provider';

/**
 * R-003 S8：工单通知。
 *
 * 五张模板在代码里注册，文案走 `app-local` 词条（中英文各一份），不写字面量。
 * 通知是流转/派单提交之后的效果，带稳定的幂等键：同一个业务事实重放只发一次。
 * 只走站内 `inbox` 通道；正文只有工单编号与状态，绝不带客户的消息原文。
 */
export const FQC_NOTIFICATION_CHANNEL = 'inbox';
export const FQC_NOTIFICATION_SOURCE = 'fqc.ticket';
export const FQC_TICKET_NOTIFICATION_NAMESPACE = 'app-local';

export type TicketNotificationKind =
  | 'dispatch'
  | 'reassign'
  | 'resolve'
  | 'close'
  | 'reopen';

export const TICKET_NOTIFICATION_KINDS: readonly TicketNotificationKind[] = [
  'dispatch',
  'reassign',
  'resolve',
  'close',
  'reopen',
];

export interface TicketNotificationEvent {
  readonly kind: TicketNotificationKind;
  readonly ticketId: string;
  readonly code: string;
  readonly state: string;
  /** 幂等键里的版本号：每次流转前进一次，同一事实重放仍是同一个键。 */
  readonly version: number;
  readonly departmentId: string | null;
  readonly assigneeId: string | null;
  /** 转派时原来的经办人；只在 reassign 里使用。 */
  readonly previousAssigneeId?: string | null;
  /** 派单/确认人；resolve 的通知发给他。 */
  readonly createdBy: string | null;
}

/**
 * 收件人按设计第 208 行：派单给责任部门负责人与经办人；转派同上外加原经办人；
 * 解决给确认人；关闭给经办人；重开给经办人与责任部门负责人。
 * 全是用户标识，没有邮箱或手机号；同一人只出现一次。
 */
export function recipientsOf(
  event: TicketNotificationEvent,
  managerId: string | null,
): readonly string[] {
  let ids: readonly (string | null | undefined)[];
  switch (event.kind) {
    case 'dispatch':
      ids = [managerId, event.assigneeId];
      break;
    case 'reassign':
      ids = [managerId, event.assigneeId, event.previousAssigneeId];
      break;
    case 'resolve':
      ids = [event.createdBy];
      break;
    case 'close':
      ids = [event.assigneeId];
      break;
    case 'reopen':
      ids = [event.assigneeId, managerId];
      break;
  }
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** 幂等键跟着业务事实走：同一张工单、同一类事件、同一个版本只有一个键。 */
export function idempotencyKeyOf(event: TicketNotificationEvent): string {
  return `${FQC_NOTIFICATION_SOURCE}:${event.kind}:${event.ticketId}:${event.version}`;
}

/** 词条键；定义预览用占位符，实际发送用真值，两者文案同源。 */
export function renderTicketNotification(
  t: Translator,
  kind: TicketNotificationKind,
  code: string,
  state: string,
): { readonly title: string; readonly body: string } {
  return {
    title: t(`ticketNotifications.${kind}.title`),
    body: t(`ticketNotifications.${kind}.body`, { code, state }),
  };
}

function adminText(key: string, defaultValue: string) {
  // 词条在本应用的 app-local 命名空间，不用插件自己的 notificationI18nText
  // （那会把 ns 钉成 @nocobase/app-plugin-notification，读不到本应用词条）。
  return {
    ns: FQC_TICKET_NOTIFICATION_NAMESPACE,
    key: `ticketNotifications.${key}`,
    defaultValue,
  };
}

/**
 * 五张模板。管理员界面可读到它们；通道名是配置名 `inbox`，不是 channel type。
 * `render` 用 i18n 运行时的纯函数翻译，不做 I/O、不查业务库（框架契约）。
 */
export function ticketNotificationTemplates(
  i18n: I18nRuntime,
  config: NotificationConfigInput | undefined,
): readonly NotificationTemplateDefinition[] {
  return TICKET_NOTIFICATION_KINDS.map((kind) => ({
    id: `fqc.ticket.${kind}`,
    contributor: 'app-local',
    contributorLabel: adminText('contributor', '质量工单'),
    category: adminText('category', '质量工单'),
    name: adminText(`${kind}.name`, {
      dispatch: '派单通知',
      reassign: '转派通知',
      resolve: '解决通知',
      close: '关闭通知',
      reopen: '重开通知',
    }[kind]),
    trigger: adminText(`${kind}.trigger`, {
      dispatch: '一份初筛被确认并派单之后',
      reassign: '一张工单被转派之后',
      resolve: '一张工单被解决之后',
      close: '一张工单被关闭之后',
      reopen: '一张工单被重开之后',
    }[kind]),
    recipients: adminText(`${kind}.recipients`, {
      dispatch: '责任部门负责人与经办人',
      reassign: '责任部门负责人、经办人与原来的经办人',
      resolve: '确认人',
      close: '经办人',
      reopen: '经办人与责任部门负责人',
    }[kind]),
    businessRule: adminText('businessRule', '只在流转提交之后发一次；重放同一个幂等键不重发。'),
    locales: ['zh-CN', 'en-US'],
    languagePolicy: adminText('languagePolicy', '按应用默认语言发送一条。'),
    variables: [
      { name: 'code', description: adminText('variables.code', '工单编号') },
      { name: 'state', description: adminText('variables.state', '工单状态') },
    ],
    channels: () => [
      {
        ...describeNotificationTemplateChannel(config, FQC_NOTIFICATION_CHANNEL, {
          label: adminText('channel', '站内收件箱'),
        }),
      },
    ],
    render: async (locale, example) => {
      await i18n.ensureLocaleLoaded(locale);
      const t = i18n.getFixedT(FQC_TICKET_NOTIFICATION_NAMESPACE, locale);
      return renderTicketNotification(
        t,
        kind,
        example === 'definition' ? '{{code}}' : 'FQC-00000000',
        example === 'definition' ? '{{state}}' : 'open',
      );
    },
  }));
}

export function registerTicketNotificationTemplates(
  registry: NotificationTemplateRegistry,
  i18n: I18nRuntime,
  config: NotificationConfigInput | undefined,
): () => void {
  const unregister = ticketNotificationTemplates(i18n, config).map((definition) =>
    registry.register(definition),
  );
  return () => {
    for (const undo of unregister) undo();
  };
}

export interface TicketNotifier {
  notify(event: TicketNotificationEvent): Promise<boolean>;
}

export interface TicketNotifierOptions {
  readonly notifications: NotificationService;
  readonly i18n: I18nRuntime;
  readonly managerOf: (departmentId: string | null) => Promise<string | null>;
  /** 收件人在落站内信之前过一遍在用账号：停用/删除的人不收到通知。 */
  readonly activeIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
}

/**
 * 站内发送器：收件人解析留在服务端，不发真实邮件、不查邮箱。
 * 通知服务按幂等键去重：同一把键、同一份请求指纹返回 `deduplicated: true`，
 * 不会多投递一条（见 manager.js 的 sendInternal）。
 */
export function createTicketNotifier({
  notifications,
  i18n,
  managerOf,
  activeIds,
}: TicketNotifierOptions): TicketNotifier {
  return {
    async notify(event) {
      const locale = i18n.getDefaultLocale();
      await i18n.ensureLocaleLoaded(locale);
      const t = i18n.getFixedT(FQC_TICKET_NOTIFICATION_NAMESPACE, locale);
      const content = renderTicketNotification(t, event.kind, event.code, event.state);
      const candidates = recipientsOf(event, await managerOf(event.departmentId));
      const active = await activeIds(candidates);
      const to = candidates.filter((id) => active.has(id));
      if (to.length === 0) return false;
      const result = await notifications.send({
        idempotencyKey: idempotencyKeyOf(event),
        source: { type: FQC_NOTIFICATION_SOURCE, referenceId: event.ticketId },
        messages: {
          [FQC_NOTIFICATION_CHANNEL]: {
            to: to as [string, ...string[]],
            title: content.title,
            body: content.body,
            target: { type: 'route', path: `/main/quality` },
          },
        },
      });
      return result.deduplicated === false;
    },
  };
}

export const ticketNotifierToken: ServiceToken<TicketNotifier> =
  createServiceToken<TicketNotifier>('app/ticket-notifier');
