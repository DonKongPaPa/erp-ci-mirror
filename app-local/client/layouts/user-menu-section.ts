import type { ComponentType } from 'react';
import {
  createServiceToken,
  type ServiceToken,
} from '@nocobase/service-provider';

/**
 * 头像菜单里由扩展追加的一段。
 *
 * 菜单不认识任何具体扩展：它在容器里找有没有登记这一段，有就渲染。开发的组合里由
 * `client/extensions/dev-account-switcher` 登记；正式构建不登记它，服务不存在，
 * 菜单也就不为它留位置 —— 菜单自己不含那个扩展的任何代码。
 */
export type UserMenuSection = ComponentType;

export const devAccountSwitcherSectionToken: ServiceToken<UserMenuSection> =
  createServiceToken<UserMenuSection>(
    'app-local/user-menu/dev-account-switcher',
  );
