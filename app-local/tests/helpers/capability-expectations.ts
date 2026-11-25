/**
 * 「功能与扩展」页上 33 项能力项的期望状态（R-031）。
 *
 * 这一页的状态没有任何命令或接口能一次导出，所以把它钉成一张写死的表：
 * 哪一项的状态变了，必须同时改这张表。这样「哪些还没做」每次跑测试都被核对，
 * 不会悄悄退回「未配置」。
 *
 * 清单来自 2026-11-24 的盘点与独立复核：
 * `raw/数模设计/2026-11-24-调研-能力项全量清单.md`、`raw/数模设计/2026-11-24-复核-能力项全量清单.md`。
 * 页面标识（路由名、路径）照框架的声明抄，来源在各插件的能力页里。
 *
 * 两个测试各断言一半：`tests/client/capability-status.test.ts` 管客户端路由能判的，
 * `tests/server/capability-status.test.ts` 管要服务端发布的东西才能判的。
 */
export type CapabilityStatus = '已提供' | '未配置' | '待确认';

type DecidedBy =
  /** 有对应的页面就「已提供」，没有就「未配置」。 */
  | {
      readonly kind: 'page';
      readonly names: readonly string[];
      readonly paths?: readonly string[];
    }
  /** 同上，但页面必须声明 `auth: 'required'`，路由名一个字母都不能差。 */
  | {
      readonly kind: 'apiKeyPage';
      readonly scope: 'personal' | 'application';
    }
  /** 由客户端的语言清单决定。 */
  | {
      readonly kind: 'clientLocales';
      readonly rule: 'any' | 'moreThanOne' | 'includesDefault';
    }
  /**
   * 页面在不在仍由路由判，最终状态还要看服务端发布的东西。
   * `pages` 是前提：这些页面都不在的话，服务端那一半的断言就没有意义了。
   */
  | {
      readonly kind: 'server';
      readonly rule:
        | 'password'
        | 'signUp'
        | 'passwordReset'
        | 'serverLocales'
        | 'connections';
      readonly pages: readonly { readonly names: readonly string[] }[];
    }
  /** 框架不按路由判（`knownRoute: false`），登记了页面状态也不会变。 */
  | { readonly kind: 'notByRoute' };

export interface CapabilityExpectation {
  /** 页面上显示的名字，与《前端与地基配置规划》的写法一致。 */
  readonly title: string;
  /** 归属的能力页：`/settings/capabilities/<插件>`。 */
  readonly plugin: string;
  readonly decidedBy: DecidedBy;
  readonly expected: CapabilityStatus;
}

export const capabilityExpectations: readonly CapabilityExpectation[] = [
  // ---- 已提供 ----
  {
    title: '密码登录',
    plugin: 'app-plugin-authentication',
    decidedBy: {
      kind: 'server',
      rule: 'password',
      pages: [{ names: ['login'] }],
    },
    expected: '已提供',
  },
  {
    title: '自助注册',
    plugin: 'app-plugin-authentication',
    decidedBy: {
      kind: 'server',
      rule: 'signUp',
      pages: [{ names: ['register'] }, { names: ['login'] }],
    },
    expected: '已提供',
  },
  {
    title: '命令行与设备登录确认',
    plugin: 'app-plugin-authentication',
    decidedBy: { kind: 'page', names: ['device'] },
    expected: '已提供',
  },
  {
    title: '数据库浏览器',
    plugin: 'app-plugin-database-explorer',
    decidedBy: { kind: 'page', names: ['databaseExplorer'] },
    expected: '已提供',
  },
  {
    title: '功能与扩展',
    plugin: 'app-plugin-foundation',
    decidedBy: {
      kind: 'page',
      names: ['capabilityGuide'],
      paths: ['/settings/capabilities'],
    },
    expected: '已提供',
  },
  {
    title: '可用语言',
    plugin: 'app-plugin-i18n',
    decidedBy: { kind: 'clientLocales', rule: 'any' },
    expected: '已提供',
  },
  {
    title: '语言切换入口',
    plugin: 'app-plugin-i18n',
    decidedBy: { kind: 'clientLocales', rule: 'moreThanOne' },
    expected: '已提供',
  },
  {
    title: '默认语言',
    plugin: 'app-plugin-i18n',
    decidedBy: { kind: 'clientLocales', rule: 'includesDefault' },
    expected: '已提供',
  },
  {
    title: '消息与通知语言',
    plugin: 'app-plugin-i18n',
    decidedBy: { kind: 'server', rule: 'serverLocales', pages: [] },
    expected: '已提供',
  },
  {
    title: '个人收件箱',
    plugin: 'app-plugin-notification-in-app',
    decidedBy: { kind: 'page', names: ['inbox'], paths: ['/inbox'] },
    expected: '已提供',
  },
  {
    title: '数据库连接',
    plugin: 'db',
    decidedBy: { kind: 'server', rule: 'connections', pages: [] },
    expected: '已提供',
  },
  // 第 0 步登记了三组管理页，授权的 5 项里这 3 项、用户管理的 1 项随之变成已提供。
  {
    title: '角色与权限配置界面',
    plugin: 'app-plugin-authorization',
    decidedBy: { kind: 'page', names: ['settingsRoles'] },
    expected: '已提供',
  },
  {
    title: '用户角色分配界面',
    plugin: 'app-plugin-authorization',
    decidedBy: { kind: 'page', names: ['settingsUsers'] },
    expected: '已提供',
  },
  {
    title: '用户管理界面',
    plugin: 'app-plugin-users',
    decidedBy: { kind: 'page', names: ['settingsUsers'] },
    expected: '已提供',
  },
  {
    title: '默认数据范围管理界面',
    plugin: 'app-plugin-authorization',
    decidedBy: { kind: 'page', names: ['settingsDefaultAccess'] },
    expected: '已提供',
  },
  // R-042 把 AI Agent 插件自带的五个管理页登记进主导航的 AI 分组。
  {
    title: 'Agent 管理界面',
    plugin: 'app-plugin-agents',
    decidedBy: { kind: 'page', names: ['agents'] },
    expected: '已提供',
  },
  {
    title: '模型管理界面',
    plugin: 'app-plugin-agents',
    decidedBy: { kind: 'page', names: ['models'] },
    expected: '已提供',
  },
  {
    title: '技能管理界面',
    plugin: 'app-plugin-agents',
    decidedBy: { kind: 'page', names: ['skills'] },
    expected: '已提供',
  },
  {
    title: '机器连接界面',
    plugin: 'app-plugin-agents',
    decidedBy: { kind: 'page', names: ['runtimes'] },
    expected: '已提供',
  },
  {
    title: '用量查看界面',
    plugin: 'app-plugin-agents',
    decidedBy: { kind: 'page', names: ['usage'] },
    expected: '已提供',
  },

  // ---- 未配置 ----
  {
    title: '找回密码',
    plugin: 'app-plugin-authentication',
    decidedBy: {
      kind: 'server',
      rule: 'passwordReset',
      pages: [{ names: ['forgot-password'] }, { names: ['reset-password'] }],
    },
    expected: '未配置',
  },
  {
    title: '共享规则管理界面',
    plugin: 'app-plugin-authorization',
    decidedBy: { kind: 'page', names: ['settingsSharingRules'] },
    expected: '未配置',
  },
  {
    title: '限制规则管理界面',
    plugin: 'app-plugin-authorization',
    decidedBy: { kind: 'page', names: ['settingsRestrictionRules'] },
    expected: '未配置',
  },
  {
    title: '我的 API 密钥界面',
    plugin: 'app-plugin-api-keys',
    decidedBy: { kind: 'apiKeyPage', scope: 'personal' },
    expected: '已提供',
  },
  {
    title: '应用 API 密钥界面',
    plugin: 'app-plugin-api-keys',
    decidedBy: { kind: 'apiKeyPage', scope: 'application' },
    expected: '已提供',
  },
  {
    title: '知识库界面',
    plugin: 'app-plugin-knowledge',
    decidedBy: { kind: 'page', names: ['knowledge'] },
    expected: '未配置',
  },
  {
    title: '通知模板目录',
    plugin: 'app-plugin-notification',
    decidedBy: { kind: 'page', names: ['notificationTemplates'] },
    expected: '已提供',
  },

  // ---- 待确认：框架不按路由判，只能逐个决定做不做 ----
  {
    title: '邮箱账号管理界面',
    plugin: 'app-plugin-mail',
    decidedBy: { kind: 'notByRoute' },
    expected: '待确认',
  },
  {
    title: '邮件工作台',
    plugin: 'app-plugin-mail',
    decidedBy: { kind: 'notByRoute' },
    expected: '待确认',
  },
  {
    title: '通知记录界面',
    plugin: 'app-plugin-notification',
    decidedBy: { kind: 'page', names: ['notificationLogs'] },
    expected: '已提供',
  },
  {
    title: '定时任务管理界面',
    plugin: 'app-plugin-scheduler',
    decidedBy: { kind: 'notByRoute' },
    expected: '待确认',
  },
  {
    title: '业务文档生成入口',
    plugin: 'app-plugin-template-print',
    decidedBy: { kind: 'notByRoute' },
    expected: '待确认',
  },
  {
    title: '邀请成员界面',
    plugin: 'app-plugin-users',
    decidedBy: { kind: 'notByRoute' },
    expected: '待确认',
  },
];
