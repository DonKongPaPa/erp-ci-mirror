import type { AuthorizationCheck } from '@nocobase/app-plugin-authorization/client';
import {
  ArrowLeftRight,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Handshake,
  MessageSquareWarning,
  PackagePlus,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * R-086 首页工作台：部件登记、角色默认与按账户覆盖。
 * 偏好只管显示；每一项的入口与部件内的数据仍走各自的授权判定。
 */
export type WidgetId =
  | 'quickActions'
  | 'myTasks'
  | 'deliveryReminders'
  | 'favoriteReports'
  | 'inventoryShortcuts';

export type WidgetCondition = 'all' | 'unrestricted' | AuthorizationCheck;

export interface WidgetDefinition {
  readonly id: WidgetId;
  readonly titleKey: string;
  /** 显示条件。'all' 表示所有登录用户，仍需部件内的数据端点各自授权。 */
  readonly condition: WidgetCondition;
}

/** 库存快捷入口部件的显示条件；并入「常用操作」块显示时也用它核对一遍。 */
export const INVENTORY_SHORTCUTS_CONDITION: AuthorizationCheck = {
  resource: { type: 'page', id: 'stock' },
  action: 'access',
};

export const WIDGETS: readonly WidgetDefinition[] = [
  { id: 'quickActions', titleKey: 'dashboard.widgets.quickActions', condition: 'all' },
  { id: 'myTasks', titleKey: 'dashboard.widgets.myTasks', condition: 'all' },
  {
    id: 'deliveryReminders',
    titleKey: 'dashboard.widgets.deliveryReminders',
    condition: {
      resource: { type: 'composite', id: 'salesOrders' },
      action: 'ledgerView',
    },
  },
  // R-078：报表入口动作是显示这道部件的前提；没设过常用的由部件自己留一句引导。
  {
    id: 'favoriteReports',
    titleKey: 'dashboard.widgets.favoriteReports',
    condition: { resource: { type: 'composite', id: 'reports' }, action: 'view' },
  },
  {
    id: 'inventoryShortcuts',
    titleKey: 'dashboard.widgets.inventoryShortcuts',
    condition: INVENTORY_SHORTCUTS_CONDITION,
  },
];

export const DEFAULT_ROLE = 'staff';

/** 角色可用的部件（调整面板的上限）；偏好只能从中取交集。 */
export const ROLE_WIDGETS: Readonly<Record<string, readonly WidgetId[]>> = {
  root: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports', 'inventoryShortcuts'],
  purchase: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  sales: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  warehouse: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports', 'inventoryShortcuts'],
  finance: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  planning: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  quality_inspector: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  quality_manager: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
  staff: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports'],
};

/** 角色默认部件与顺序；没有登记的角色用普通员工的那一套。 */
export const ROLE_DEFAULTS: Readonly<Record<string, readonly WidgetId[]>> = {
  root: ['quickActions', 'myTasks', 'deliveryReminders', 'favoriteReports', 'inventoryShortcuts'],
  purchase: ['quickActions', 'deliveryReminders', 'myTasks', 'favoriteReports'],
  sales: ['quickActions', 'deliveryReminders', 'myTasks', 'favoriteReports'],
  warehouse: ['inventoryShortcuts', 'quickActions', 'deliveryReminders', 'myTasks'],
  finance: ['quickActions', 'deliveryReminders', 'myTasks', 'favoriteReports'],
  planning: ['quickActions', 'myTasks', 'deliveryReminders'],
  quality_inspector: ['quickActions', 'myTasks', 'deliveryReminders'],
  quality_manager: ['quickActions', 'myTasks', 'deliveryReminders'],
  staff: ['quickActions', 'myTasks', 'deliveryReminders'],
};

export interface QuickAction {
  readonly id: string;
  readonly titleKey: string;
  readonly path: string;
  /** 快捷入口磁贴上的图标（lucide，R-093 第 2 节；同一语义全站用同一个）。 */
  readonly icon: LucideIcon;
  readonly requirement: AuthorizationCheck;
}

const page = (id: string) => ({ resource: { type: 'page', id }, action: 'access' }) as const;

/** 常用操作的角色默认入口；每一项显示前各自核对页面授权。图标按 R-093 的图标表定。 */
export const QUICK_ACTIONS: Readonly<Record<string, readonly QuickAction[]>> = {
  root: [
    { id: 'newPurchaseOrder', titleKey: 'dashboard.quick.newPurchaseOrder', path: '/purchase-orders', icon: ShoppingCart, requirement: page('purchaseOrders') },
    { id: 'newPurchaseRequest', titleKey: 'dashboard.quick.newPurchaseRequest', path: '/purchase-requests', icon: FileText, requirement: page('purchaseRequests') },
    { id: 'newSalesOrder', titleKey: 'dashboard.quick.newSalesOrder', path: '/sales-orders', icon: ReceiptText, requirement: page('salesOrders') },
    { id: 'orderReview', titleKey: 'dashboard.quick.orderReview', path: '/order-ledger', icon: ClipboardCheck, requirement: page('orderLedger') },
    { id: 'inventoryInbound', titleKey: 'dashboard.quick.inventoryInbound', path: '/inbound-orders', icon: PackagePlus, requirement: page('inboundOrders') },
  ],
  purchase: [
    { id: 'newPurchaseOrder', titleKey: 'dashboard.quick.newPurchaseOrder', path: '/purchase-orders', icon: ShoppingCart, requirement: page('purchaseOrders') },
    { id: 'newPurchaseRequest', titleKey: 'dashboard.quick.newPurchaseRequest', path: '/purchase-requests', icon: FileText, requirement: page('purchaseRequests') },
    { id: 'orderReview', titleKey: 'dashboard.quick.orderReview', path: '/order-ledger', icon: ClipboardCheck, requirement: page('orderLedger') },
  ],
  sales: [
    { id: 'newSalesOrder', titleKey: 'dashboard.quick.newSalesOrder', path: '/sales-orders', icon: ReceiptText, requirement: page('salesOrders') },
    { id: 'orderReview', titleKey: 'dashboard.quick.orderReview', path: '/order-ledger', icon: ClipboardCheck, requirement: page('orderLedger') },
  ],
  warehouse: [
    { id: 'inventoryInbound', titleKey: 'dashboard.quick.inventoryInbound', path: '/inbound-orders', icon: PackagePlus, requirement: page('inboundOrders') },
    { id: 'inventoryOutbound', titleKey: 'dashboard.quick.inventoryOutbound', path: '/outbound-orders', icon: Truck, requirement: page('outboundOrders') },
    { id: 'stocktaking', titleKey: 'dashboard.quick.stocktaking', path: '/stocktakings', icon: ClipboardList, requirement: page('stocktakings') },
  ],
  finance: [
    { id: 'reconciliation', titleKey: 'dashboard.quick.reconciliation', path: '/finance-requests', icon: Handshake, requirement: page('financeRequests') },
    { id: 'expenses', titleKey: 'dashboard.quick.expenses', path: '/expenses', icon: Wallet, requirement: page('expenses') },
  ],
  planning: [
    { id: 'newPurchaseRequest', titleKey: 'dashboard.quick.newPurchaseRequest', path: '/purchase-requests', icon: FileText, requirement: page('purchaseRequests') },
    { id: 'orderReview', titleKey: 'dashboard.quick.orderReview', path: '/order-ledger', icon: ClipboardCheck, requirement: page('orderLedger') },
  ],
  quality_inspector: [
    { id: 'quality', titleKey: 'dashboard.quick.quality', path: '/quality', icon: ShieldCheck, requirement: page('quality') },
    { id: 'feedback', titleKey: 'dashboard.quick.feedback', path: '/feedbacks', icon: MessageSquareWarning, requirement: page('feedbacks') },
  ],
  quality_manager: [
    { id: 'quality', titleKey: 'dashboard.quick.quality', path: '/quality', icon: ShieldCheck, requirement: page('quality') },
    { id: 'feedback', titleKey: 'dashboard.quick.feedback', path: '/feedbacks', icon: MessageSquareWarning, requirement: page('feedbacks') },
  ],
  staff: [
    { id: 'feedback', titleKey: 'dashboard.quick.feedback', path: '/feedbacks', icon: MessageSquareWarning, requirement: page('feedbacks') },
    { id: 'newPurchaseRequest', titleKey: 'dashboard.quick.newPurchaseRequest', path: '/purchase-requests', icon: FileText, requirement: page('purchaseRequests') },
  ],
};

export interface InventoryShortcut {
  readonly id: string;
  readonly path: string;
  /** 名称沿用导航的同名词条，图标也与导航一致（同一语义同一个图标）。 */
  readonly titleKey: string;
  readonly icon: LucideIcon;
  readonly requirement: AuthorizationCheck;
}

/** 库存快捷入口：并入「常用操作」块或单独成块，都从这里取。 */
export const INVENTORY_SHORTCUTS: readonly InventoryShortcut[] = [
  { id: 'inboundOrders', path: '/inbound-orders', titleKey: 'navigation.inboundOrders', icon: PackagePlus, requirement: page('inboundOrders') },
  { id: 'outboundOrders', path: '/outbound-orders', titleKey: 'navigation.outboundOrders', icon: Truck, requirement: page('outboundOrders') },
  { id: 'stock', path: '/stock', titleKey: 'navigation.stock', icon: Boxes, requirement: page('stock') },
  { id: 'stocktakings', path: '/stocktakings', titleKey: 'navigation.stocktakings', icon: ClipboardList, requirement: page('stocktakings') },
  { id: 'transfers', path: '/transfers', titleKey: 'navigation.transfers', icon: ArrowLeftRight, requirement: page('transfers') },
];

export interface WidgetState {
  readonly id: WidgetId;
  readonly collapsed: boolean;
}

export interface DashboardPreference {
  readonly widgets: readonly WidgetState[];
}

/** 偏好值很短，写一条容量断言（R-086 待补查第 5 条）。 */
export const PREFERENCE_KEY = 'dashboard.widgets';
export const MAX_PREFERENCE_BYTES = 4096;

function isWidgetState(value: unknown): value is WidgetState {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { id?: unknown; collapsed?: unknown };
  return (
    typeof entry.id === 'string' &&
    (ids as readonly string[]).includes(entry.id) &&
    typeof entry.collapsed === 'boolean'
  );
}

const ids = WIDGETS.map((widget) => widget.id);

export function parseDashboardPreference(raw: unknown): DashboardPreference | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const widgets = (raw as { widgets?: unknown }).widgets;
  // `widgets: null` 是「恢复默认」写入的形状，不是一份覆盖。
  if (widgets === null) return undefined;
  if (!Array.isArray(widgets) || !widgets.every(isWidgetState)) return undefined;
  if (new Set(widgets.map((entry) => entry.id)).size !== widgets.length)
    return undefined;
  if (new TextEncoder().encode(JSON.stringify({ widgets })).length > MAX_PREFERENCE_BYTES)
    return undefined;
  return { widgets };
}

/**
 * 有效清单 = 按账户的覆盖 ∩ 这个角色允许的部件；没有覆盖就用角色默认。
 * 顺序与收起状态来自覆盖，未知编号与重复编号已在解析时丢掉。
 */
export function resolveWidgets(
  roleKey: string,
  preference: DashboardPreference | undefined,
  allowed: readonly WidgetId[],
): readonly WidgetState[] {
  const allowedSet = new Set(allowed);
  const role = ROLE_DEFAULTS[roleKey] ? roleKey : DEFAULT_ROLE;
  const source = preference
    ? preference.widgets
    : (ROLE_DEFAULTS[role] ?? []).map((id) => ({ id, collapsed: false }));
  return source
    .filter((entry) => allowedSet.has(entry.id))
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => other.id === entry.id) === index,
    );
}
