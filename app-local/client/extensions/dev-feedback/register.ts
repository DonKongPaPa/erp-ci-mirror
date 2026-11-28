import type { ClientApplication } from '@nocobase/app-client';

import { extensionOverlayToken } from '../../layouts/extension-overlay.js';
import FeedbackPanel from './panel.js';

/**
 * R-087 把每页的悬浮反馈面板登记到布局的浮层挂点。
 *
 * 单独成文件是因为开发扩展入口只能动态引入它（R-073）：`panel.tsx` 只导出组件，
 * 这个文件把「组件 + token」接起来，生产构建里连模块图都进不去。
 */
export function registerFeedbackPanel(app: ClientApplication): void {
  app.container.instance(extensionOverlayToken, FeedbackPanel);
}
