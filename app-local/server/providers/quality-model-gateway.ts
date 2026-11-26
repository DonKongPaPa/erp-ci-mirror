import { agentsToken } from '@nocobase/app-plugin-agents/server/tokens';
import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { ServiceProvider } from '@nocobase/service-provider';
import { createServiceToken, type ServiceToken } from '@nocobase/service-provider';

/**
 * R-002：代填服务的模型网关。
 *
 * 代填服务不直接拿框架的网关，而是依赖这一个只有一个方法的接口：正式环境由一个
 * provider 把它适配到 `agentsToken` 上的 `models.gateway`；测试在应用启动之前把
 * 自己的实现绑进容器（`qualityModelGatewayToken`），这个 provider 看到令牌已经
 * 绑好就不再绑真的。
 *
 * 走 `generate`：它返回时框架自动记一笔 `agModelUsage`（`purpose: 'text'`，
 * `source` 是调用方给的），只回一段文本，失败抛 `ModelError`，自己不等超时。
 * `stream` 不记账，所以不用。参考 `@nocobase/app-plugin-agents@2.0.0-beta.18` 的
 * `dist/server/online/gateway.d.ts:166-174`、`:197-200` 与 `gateway.js:599-630`。
 *
 * 框架的 `generate` 只回文本，不回是哪个模型答的；代填要往 `modelName` 列写
 * 「服务加模型名」，所以这里让适配器把选中的模型一并带回来。选哪个模型也在这里：
 * 框架的目录里有一个「没有自己的模型时用的默认聊天模型」，没有启用任何聊天模型时
 * 它是空 —— 这时抛 `ModelNotConfiguredError`，代填据此记 `model-not-configured`，
 * 也不会发生任何网络请求（`dist/shared/models.d.ts:94-101`、
 * `dist/server/online/services.js:483-496`）。
 */

/** 一次代填要给模型的内容：只有脱敏后的正文与上下文，没有发件人。 */
export interface QualityModelGatewayRequest {
  /** 一段固定的说明：输出的合约与类别、严重度的定义。 */
  readonly system: string;
  /** 用户消息：脱敏后的反馈正文与取到的上下文。 */
  readonly prompt: string;
  /** 记账时写调用方，代填固定写 `fqc.draft`。 */
  readonly source: string;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface QualityModelGatewayResult {
  readonly text: string;
  /** 「服务加模型名」，写进初筛表的 `modelName` 列。 */
  readonly model: string;
}

export interface QualityModelGateway {
  generate(request: QualityModelGatewayRequest): Promise<QualityModelGatewayResult>;
}

/**
 * 开关开着，但没有任何可用的聊天模型。
 *
 * 代填据此把回落原因记成 `model-not-configured`，与网关抛出的其它错误（`model-error`）
 * 区分开。它不对外：只有本 provider 抛、代填服务接。
 */
export class ModelNotConfiguredError extends Error {
  override readonly name = 'ModelNotConfiguredError';
}

export const qualityModelGatewayToken: ServiceToken<QualityModelGateway> =
  createServiceToken<QualityModelGateway>('app/quality-model-gateway');

export default class QualityModelGatewayProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.quality-model-gateway';

  override register(): void {
    // 容器不允许覆盖已绑定的服务（`ServiceContainer.assertAvailable`）。测试要在
    // 启动之前把假的放进来，所以这里看到已经绑定就不再绑真的。
    if (this.app.container.has(qualityModelGatewayToken)) {
      return;
    }
    this.app.container.singleton(qualityModelGatewayToken, () => this.gateway());
  }

  private gateway(): QualityModelGateway {
    const { container } = this.app;
    return {
      generate: async (request) => {
        if (!container.has(agentsToken)) {
          throw new ModelNotConfiguredError(
            'The agents plugin is not registered, so no chat model is available.',
          );
        }
        const gateway = container.resolve(agentsToken).models.gateway;
        const catalog = await gateway.catalog('chat');
        const model = catalog.defaultModel ?? null;
        if (!model) {
          throw new ModelNotConfiguredError(
            'No enabled chat model is configured.',
          );
        }
        const result = await gateway.generate({
          model,
          system: request.system,
          prompt: request.prompt,
          source: request.source,
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return {
          text: result.text,
          model: `${model.modelService}/${model.model}`,
        };
      },
    };
  }
}
