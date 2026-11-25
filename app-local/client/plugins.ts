import foundation from '@nocobase/app-plugin-foundation/client';
import applicationManifest from '../package.json' with { type: 'json' };
import defaultAccess from '@nocobase/app-plugin-authz-default-access/client';
import sharingRules from '@nocobase/app-plugin-authz-sharing-rules/client';
import restrictionRules from '@nocobase/app-plugin-authz-restriction-rules/client';
import {
  defineClientPlugin,
  defineClientPlugins,
  type AppClientPluginRegistration,
  type AppClientPlugins,
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
import devAccountSwitcher from './extensions/dev-account-switcher/plugin.js';

/**
 * R-037 开发工具。只在开发构建里登记它的贡献：生产构建里 `import.meta.env.DEV` 是常量假，
 * 走下面那个空登记项。单独包一层，是为了让构建能把扩展的代码一起摇掉 —— 应用的 Vite
 * 插件要求组合数组里每一项都是显式的工厂调用，条件展开写在数组里会让构建失败。
 *
 * 显式参数只给行为测试用：生产构建把 DEV 置假时入口不登记，这条要能真的跑出来，不能只查源码。
 * 组合数组里的那次调用不带参数，读的仍是构建期的 `import.meta.env.DEV`。
 */
export function devAccountSwitcherRegistration(
  isDevelopmentBuild: boolean = import.meta.env.DEV,
): AppClientPluginRegistration {
  return isDevelopmentBuild
    ? devAccountSwitcher({ enabled: true })
    : defineClientPlugin({ packageName: 'app-local' })();
}

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
  // R-037 开发工具：只在开发构建里登记它的贡献；服务端那边也不会发布开关
  // （正式环境写开启会让应用起不来）。
  devAccountSwitcherRegistration(),
  // The manifest is what the capability guide lists: every plugin this application declares.
  foundation({
    settingsGroup: true,
    manifest: applicationManifest,
    guideSettingsPath: '/settings',
    navigation: false,
  }),
]);

export default clientPlugins;
