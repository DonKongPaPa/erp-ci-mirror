import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';
import {
  Handshake,
  Layers3,
  ShieldAlert,
  ShoppingBasket,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import packageMetadata from '../../package.json' with { type: 'json' };

import type { RouteNavigationItem } from '../routing/route-navigation.js';

/**
 * R-085 加片：侧栏只放公司事务。管理员顶层散着的业务页按业务归组；
 * 非事务的 AI 五页挪进系统设置。路径与页面授权都不变，这里只改权限过滤之后的导航树。
 */
interface BusinessGroup {
  readonly name: string;
  readonly titleKey: string;
  readonly icon: LucideIcon;
  readonly pages: readonly string[];
}

export const BUSINESS_GROUPS: readonly BusinessGroup[] = [
  {
    name: 'businessMasterData',
    titleKey: 'navigation.businessMasterData',
    // 首个子页「往来单位」用 Building2，组图标取调研备选，避免重复。
    icon: Layers3,
    pages: ['partners', 'bizDict'],
  },
  {
    name: 'businessPurchase',
    titleKey: 'navigation.businessPurchase',
    // 不与首个子页「采购订单」的 ShoppingCart 重复，也不与盘点单的 ClipboardList 重复。
    icon: ShoppingBasket,
    pages: ['purchaseOrders', 'purchaseRequests'],
  },
  {
    name: 'businessSales',
    titleKey: 'navigation.businessSales',
    // 首选 ReceiptText 与第一个子页「销售订单」重复；取调研给的备选。
    icon: Handshake,
    pages: ['salesOrders', 'quotations', 'orderLedger'],
  },
  {
    name: 'businessFinance',
    titleKey: 'navigation.businessFinance',
    icon: Wallet,
    // R-065 第二片的四张财务页（收入、销项发票、应收对账、应付对账）排在到票记录后。
    pages: [
      'financeRequests',
      'expenses',
      'invoiceReceipts',
      'incomeRecords',
      'saleInvoiceRecords',
      'receivableRecons',
      'payableRecons',
    ],
  },
  {
    name: 'businessQuality',
    titleKey: 'navigation.businessQuality',
    // 第一个子页按路由顺序是「来料检验」(ShieldCheck)，不与组的 ShieldAlert 重复。
    icon: ShieldAlert,
    // 来料检验（R-070）是质量业务页：按 R-085 归进可收起的组，不占侧栏顶层。
    pages: ['quality', 'inspections', 'feedbacks'],
  },
];

/** AI 五页以及继承父页授权的对话框：设置入口在它们上面保持选中。 */
export const AI_ROUTE_NAMES: readonly string[] = [
  'models',
  'agents',
  'runtimes',
  'runtimes-connect',
  'skills',
  'skills-new',
  'skills-detail',
  'usage',
];

const AI_GROUP = 'ai';
const SETTINGS_GROUP = 'settings';
const SETTINGS_AI_CATEGORY = 'settingsAi';
const SETTINGS_SYSTEM_CATEGORY = 'settingsSystem';

function isSettings(item: RouteNavigationItem): boolean {
  return (
    item.route.name === SETTINGS_GROUP &&
    item.route.children?.some((child) => child.name === 'settingsHome') === true
  );
}

function groupRoute(group: BusinessGroup): AppClientRegisteredRoute {
  return {
    name: group.name,
    id: group.name,
    path: `/business/${group.name}`,
    // 标题词条按路由的包名去查（navigation-menu 里 useTranslation(route.packageName)）：
    // 写成占位的 'application' 会在外壳测试的词条表里查不到（2026-11-28 起主线上八个外壳测试因此红）。
    packageName: packageMetadata.name,
    source: 'application',
    auth: 'required',
    authz: 'skip',
    navigation: { title: group.titleKey, icon: group.icon },
    children: [],
  };
}

function findRoute(
  routes: readonly AppClientRegisteredRoute[],
  name: string,
): AppClientRegisteredRoute | undefined {
  for (const route of routes) {
    if (route.name === name) return route;
    const nested = findRoute(route.children ?? [], name);
    if (nested) return nested;
  }
  return undefined;
}

/** 把 AI 组从侧栏摘掉，五页挂到系统设置已有的 AI 分类里；授权过滤在前，没权限的页不会进来。 */
function moveAiIntoSettings(
  items: readonly RouteNavigationItem[],
  routes: readonly AppClientRegisteredRoute[],
): readonly RouteNavigationItem[] {
  const ai = items.find((item) => item.route.name === AI_GROUP);
  if (!ai || ai.children.length === 0) return items;
  const settings = items.find(isSettings);
  if (!settings) return items;
  const categoryRoute = findRoute(routes, SETTINGS_AI_CATEGORY) ?? {
    name: SETTINGS_AI_CATEGORY,
    id: SETTINGS_AI_CATEGORY,
    path: '/settings/ai',
    packageName: 'application',
    source: 'application',
    auth: 'required',
    authz: 'skip',
    navigation: { title: 'settings.categories.ai' },
    children: [],
  };
  const category: RouteNavigationItem = {
    route: categoryRoute,
    children: ai.children,
  };
  const children = [...settings.children, category].sort((left, right) => {
    const order = [
      'settingsAccount',
      'settingsBusiness',
      SETTINGS_AI_CATEGORY,
      SETTINGS_SYSTEM_CATEGORY,
    ];
    return order.indexOf(left.route.name) - order.indexOf(right.route.name);
  });
  return items.flatMap((item) => {
    if (item === ai) return [];
    if (item === settings) return [{ ...settings, children }];
    return [item];
  });
}

/** 业务页归组，顶层只剩首页与组；业务角色仍是全部展开的节，链接数不变。 */
function groupBusinessPages(
  items: readonly RouteNavigationItem[],
): readonly RouteNavigationItem[] {
  const buckets = new Map<string, RouteNavigationItem[]>();
  const others: RouteNavigationItem[] = [];
  for (const item of items) {
    const group = BUSINESS_GROUPS.find((entry) =>
      entry.pages.includes(item.route.name),
    );
    if (!group) {
      others.push(item);
      continue;
    }
    buckets.set(group.name, [...(buckets.get(group.name) ?? []), item]);
  }
  const grouped = BUSINESS_GROUPS.flatMap((group) => {
    const children = buckets.get(group.name) ?? [];
    return children.length ? [{ route: groupRoute(group), children }] : [];
  });
  const first = others.filter((item) => item.route.name === 'home');
  const hr = others.filter((item) => item.route.name === 'hr');
  const tailGroups = ['inventory', 'approvals'].flatMap((name) =>
    others.filter((item) => item.route.name === name),
  );
  const settings = others.filter(isSettings);
  const used = [...first, ...hr, ...tailGroups, ...settings];
  const rest = others.filter((item) => !used.includes(item));
  return [...first, ...hr, ...grouped, ...tailGroups, ...rest, ...settings];
}

export function organizeCompanyNavigation(
  items: readonly RouteNavigationItem[],
  routes: readonly AppClientRegisteredRoute[],
): readonly RouteNavigationItem[] {
  return groupBusinessPages(moveAiIntoSettings(items, routes));
}
