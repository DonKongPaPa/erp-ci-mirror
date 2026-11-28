/**
 * R-087 测试反馈的请求体校验：服务端路由与客户端契约测试共用同一份 zod schema。
 *
 * 抽出来的原因：#321 只模拟了接口，页面模式发出去的 target 带着 registryId 也没有被拦住。
 * 让两边引用同一份定义，请求体形状由机器核对，而不是靠人记得「服务端要什么」。
 */

import { z } from 'zod';

export const PageTarget = z.object({
  kind: z.literal('page'),
  route: z.string().min(1),
});
export const ElementTarget = z.object({
  kind: z.literal('element'),
  text: z.string().min(1),
  locator: z.string().min(1),
  source: z.string().optional(),
});
export const RegistryTarget = z.object({
  kind: z.literal('registry'),
  registryId: z.string().min(1),
});
export const Target = z.discriminatedUnion('kind', [
  PageTarget,
  ElementTarget,
  RegistryTarget,
]);

export const CreateSchema = z.object({
  route: z.string().min(1),
  target: Target,
  text: z.string(),
  kinds: z
    .array(z.enum(['display', 'flow', 'data', 'missing', 'copy', 'other']))
    .optional(),
  severe: z.boolean().optional(),
  screenshotId: z.string().optional(),
});
