import {
  useInboxRefresh,
  useInboxUnreadCount,
} from '@nocobase/app-plugin-notification-in-app/client/inbox';
import type { ReactElement } from 'react';

import { inboxBadge, useDocumentTitleBadge } from '#components/inbox-badge';
import { InboxButton } from '#components/inbox-button';
import { TooltipProvider } from '#components/ui/tooltip';

import { UserMenu } from './user-menu.js';

/** The header's right-hand actions, shared by every authenticated page. */
export function HeaderActions(): ReactElement {
  // 未读数跟实时推送走：与收件箱页按引用计数共用同一份订阅，离开收件箱页后
  // 头部的角标与标签页标题也会在 `inbox.changed` 到达时刷新。
  useInboxRefresh();
  const { data: unread } = useInboxUnreadCount();
  // 本应用的收件箱来源不产出决策项（`defaultInboxSource` 不加东西），所以只显未读数。
  const badge = inboxBadge(0, unread ?? 0);
  useDocumentTitleBadge(badge?.text ?? null);
  return (
    <TooltipProvider>
      <div className='flex shrink-0 items-center gap-2'>
        <InboxButton badge={badge} />
        <UserMenu />
      </div>
    </TooltipProvider>
  );
}
