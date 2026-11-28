import type { ReactElement } from 'react';

import { ACTION_ICONS, type ActionIconKey } from '#lib/action-icons';

/**
 * 按钮里的主操作图标：从 action-icons 按动作键取，位置交给 `data-icon`，
 * 尺寸由宿主组件控制。图标不单独表意，旁边一定有文字。
 */
export function ActionGlyph({
  action,
}: {
  readonly action: ActionIconKey;
}): ReactElement {
  const Icon = ACTION_ICONS[action];
  return <Icon data-icon='inline-start' aria-hidden='true' />;
}
