import type { ClientApplication } from '@nocobase/app-client';

import { userMenuExtensionSectionToken } from '../../layouts/user-menu-section.js';
import { DevAccountSwitcher } from './section.js';

/**
 * 把「切换账户」那一段登记给头像菜单。
 *
 * 这个模块只进开发构建：唯一引入它的是 `client/extensions/development-extensions.ts` 里那次动态引入，
 * 生产构建走不到（R-073）。头像菜单按 service token 找这一段；没人登记，整段不渲染。
 */
export function registerDevAccountSwitcher(app: ClientApplication): void {
  app.container.instance(userMenuExtensionSectionToken, DevAccountSwitcher);
}
