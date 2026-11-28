import { useCan } from '@nocobase/app-plugin-authorization/client';
import type { AuthorizationRequirement } from '@nocobase/app-plugin-authorization/client';

import { DEFAULT_ROLE } from './dashboard-config.js';

/**
 * 服务端只给权限快照，不把角色随会话下发；这里用每岗位的特征页面授权识别角色。
 * 顺序即优先级：root 先看，销售用报价单 distinguishing（计划经理没有），财务用支出记录（普通员工没有）。
 * 一个人兼多角色时取第一个命中的；没命中按普通员工。若以后服务端下发角色，换掉这个文件即可。
 */
export const ROLE_MARKERS: Readonly<Record<string, AuthorizationRequirement>> = {
  warehouse: { resource: { type: 'page', id: 'stock' }, action: 'access' },
  purchase: { resource: { type: 'page', id: 'purchaseOrders' }, action: 'access' },
  sales: { resource: { type: 'page', id: 'quotations' }, action: 'access' },
  finance: { resource: { type: 'page', id: 'expenses' }, action: 'access' },
  quality_inspector: { resource: { type: 'page', id: 'quality' }, action: 'access' },
  planning: { resource: { type: 'page', id: 'orderLedger' }, action: 'access' },
};

export function resolveRoleKey(
  can: (requirement: AuthorizationRequirement) => boolean,
): string {
  if (can('unrestricted')) return 'root';
  for (const [role, marker] of Object.entries(ROLE_MARKERS)) {
    if (can(marker)) return role;
  }
  return DEFAULT_ROLE;
}

/** 权限还在读时返回 undefined；首页先不渲染部件，避免按错误角色画一次再跳。 */
export function useDashboardRole(): string | undefined {
  const root = useCan('unrestricted');
  const warehouse = useCan(ROLE_MARKERS.warehouse);
  const purchase = useCan(ROLE_MARKERS.purchase);
  const sales = useCan(ROLE_MARKERS.sales);
  const finance = useCan(ROLE_MARKERS.finance);
  const quality = useCan(ROLE_MARKERS.quality_inspector);
  const planning = useCan(ROLE_MARKERS.planning);
  const checks = [root, warehouse, purchase, sales, finance, quality, planning];
  if (checks.some((check) => check.isPending)) return undefined;
  const answers = [root, warehouse, purchase, sales, finance, quality, planning].map(
    (check) => check.can,
  );
  return resolveRoleKey((requirement) => {
    if (requirement === 'unrestricted') return answers[0];
    const index = Object.values(ROLE_MARKERS).findIndex(
      (marker) =>
        marker !== 'unrestricted' &&
        marker.resource.type === requirement.resource.type &&
        marker.resource.id === requirement.resource.id &&
        marker.action === requirement.action,
    );
    return index >= 0 ? answers[index + 1] : false;
  });
}
