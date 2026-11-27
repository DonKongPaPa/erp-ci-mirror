import type { ComponentType } from 'react';
import {
  createServiceToken,
  type ServiceToken,
} from '@nocobase/service-provider';

/**
 * 头像菜单里由扩展追加的一段。
 *
 * 菜单不认识任何具体扩展：它在容器里找有没有登记这一段，有就渲染。生产构建里没有谁登记它，
 * 服务不存在，菜单也就不为它留位置 —— 菜单自己不含任何扩展的代码。token 的名字也不指向具体扩展：
 * 它是生产常驻代码里的字串，会原样进产物。
 */
export type UserMenuSection = ComponentType;

export const userMenuExtensionSectionToken: ServiceToken<UserMenuSection> =
  createServiceToken<UserMenuSection>('app-local/user-menu/extension-section');
