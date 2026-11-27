import foundation from '@nocobase/app-plugin-foundation/client';
import applicationManifest from '../package.json' with { type: 'json' };
import defaultAccess from '@nocobase/app-plugin-authz-default-access/client';
import sharingRules from '@nocobase/app-plugin-authz-sharing-rules/client';
import restrictionRules from '@nocobase/app-plugin-authz-restriction-rules/client';
import {
  type AppClientPlugins,
  defineClientPlugins,
} from '@nocobase/app-client/plugins';
import apiKeys from '@nocobase/app-plugin-api-keys/client';
import authentication from '@nocobase/app-plugin-authentication/client';
import authorization from '@nocobase/app-plugin-authorization/client';
import databaseExplorer from '@nocobase/app-plugin-database-explorer/client';
import users from '@nocobase/app-plugin-users/client';
import notificationInApp from '@nocobase/app-plugin-notification-in-app/client';
import i18n from '@nocobase/app-plugin-i18n/client';
import notification from '@nocobase/app-plugin-notification/client';
import scheduler from '@nocobase/app-plugin-scheduler/client';
import file from '@nocobase/app-plugin-file/client';
import mail from '@nocobase/app-plugin-mail/client';
import agents from '@nocobase/app-plugin-agents/client';
import knowledge from '@nocobase/app-plugin-knowledge/client';
import developmentExtensions from './extensions/development-extensions.js';

/**
 * R-037 / R-073 开发环境专用的扩展（账号切换器）只从 `developmentExtensions()` 这一项进组合。
 *
 * 它是一个生产常驻的小入口，本身不含扩展的代码：开发构建里由它动态引入并登记扩展；生产构建里
 * `import.meta.env.DEV` 是常量假，那次引入连同被引入的模块一起不进模块图。组合数组里不放条件展开，
 * 因为应用的 Vite 插件要求每一项都是显式的工厂调用。细节见 `client/extensions/development-extensions.ts`。
 */

// Array order is contribution order. A plugin is enabled by appearing in this
// list; removing its entry and its import disables it.
const clientPlugins: AppClientPlugins = defineClientPlugins([
  authentication(),
  authorization(),
  defaultAccess(),
  sharingRules(),
  restrictionRules(),
  databaseExplorer(),
  users(),
  apiKeys(),
  i18n(),
  notificationInApp(),
  notification(),
  file(),
  scheduler(),
  mail(),
  agents(),
  // R-002：质量知识库。索引关着，与服务端 createKnowledgePlugin({ indexing: false })
  // 配套：不登记索引表单，第一版不加载按平台预编译的原生模块。
  // 客户端工厂自带 /knowledge 页面，能力项「知识库界面」据此从「未配置」变「已提供」。
  // 页面首请求必须带解析器认的空间（R-002 只认 quality/standards）：不传就用插件默认的
  // default/''，解析器回空、/spaces 报 400、首屏红条「无法加载知识库」。
  knowledge({
    indexing: false,
    space: { scope: 'quality', scopeId: 'standards' },
  }),
  developmentExtensions(),
  // The manifest is what the capability guide lists: every plugin this application declares.
  foundation({
    settingsGroup: true,
    manifest: applicationManifest,
    guideSettingsPath: '/settings',
    navigation: false,
  }),
]);

export default clientPlugins;
