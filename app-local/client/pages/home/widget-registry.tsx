import type { ComponentType } from 'react';

import type { WidgetId } from './dashboard-config.js';
import { DeliveryReminders } from './delivery-reminders.js';
import {
  FavoriteReportsWidget,
  InventoryShortcutsWidget,
  MyTasksWidget,
  QuickActionsWidget,
  type WidgetProps,
} from './widgets.js';

/** 部件编号到渲染组件的登记； dashboard-config 管显示条件，这里只管画。 */
export const WIDGET_RENDERERS: Readonly<Record<WidgetId, ComponentType<WidgetProps>>> = {
  quickActions: QuickActionsWidget,
  myTasks: MyTasksWidget,
  deliveryReminders: () => <DeliveryReminders />,
  favoriteReports: FavoriteReportsWidget,
  inventoryShortcuts: InventoryShortcutsWidget,
};
