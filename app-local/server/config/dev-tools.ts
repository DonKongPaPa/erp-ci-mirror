import {
  defineAppConfig,
  type AppConfigFactory,
} from '@nocobase/app-server/config';

/**
 * R-037 开发环境专用的开发工具。
 *
 * 默认关闭。打开之后只在开发环境生效；环境不是开发（`app.nodeEnv` 不是 `develop` 或
 * `development`，含缺失）时应用启动失败 —— 宁可起不来，也不悄悄关掉。
 *
 * 客户端只认 `accountSwitcher.enabled`，头像菜单按它决定渲染不渲染，所以它发布到公开配置。
 */
export interface DevToolsConfig {
  readonly accountSwitcher?: {
    readonly enabled?: boolean;
  };
}

const devTools: AppConfigFactory<DevToolsConfig> = defineAppConfig({
  defaults: { accountSwitcher: { enabled: false } },
  public: ['accountSwitcher.enabled'],
});

export default devTools;
