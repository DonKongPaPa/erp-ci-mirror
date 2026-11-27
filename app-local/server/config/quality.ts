import {
  defineAppConfig,
  type AppConfigFactory,
} from '@nocobase/app-server/config';

/**
 * R-002：代填服务的模型开关。
 *
 * 默认关闭。关着的时候代填只出规则版，不碰模型网关、不发任何请求；打开它的前提是
 * 用户点头（客户反馈的正文会发给云端模型），不是管理员在「模型管理」里填了密钥。
 *
 * 「不进应用的公开配置」：它只在服务端读，客户端不需要知道，也就没有 `public`。
 * 写法就是 `defineAppConfig` 的 `defaults`，不带 `public`。
 */
export interface QualityConfig {
  readonly drafting?: {
    readonly modelEnabled?: boolean;
  };
}

const quality: AppConfigFactory<QualityConfig> = defineAppConfig({
  defaults: { drafting: { modelEnabled: false } },
});

export default quality;
