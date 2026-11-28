import type { ComponentType } from 'react';
import {
  createServiceToken,
  type ServiceToken,
} from '@nocobase/service-provider';

/**
 * 布局上给扩展留的一个浮层挂点。
 *
 * 布局不认识任何具体扩展：它只在容器里找有没有登记这一段，有就渲染。生产构建里没有谁登记它，
 * 服务不存在，布局也不为它留 DOM。token 的名字不指向具体扩展 —— 它是生产常驻代码里的字串，
 * 会原样进产物。
 */
export type ExtensionOverlay = ComponentType;

export const extensionOverlayToken: ServiceToken<ExtensionOverlay> =
  createServiceToken<ExtensionOverlay>('app-local/layout/extension-overlay');
