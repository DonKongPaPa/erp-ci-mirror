import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-078 的入口资源：四个动作只管「能不能进报表中心、能不能出数、导出、设常用」。
 * 真正的数据权限来自每张定义的 baseActions 与列上的 requiredActions，逐次二次判定。
 * 每个动作只挂一条最窄的只读权限（定义表的四个非敏感列）让框架能登记动作；
 * 业务数据一律由取数提供者走已有单据读服务，不在这里开业务表。
 * root 直通；这里只声明，不给任何角色授权（授权由 202611280023 种子与升级命令写）。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const definitionTitle = title('authorization.reports.tables.definitions');
const readDefinitions = defineDatabasePermission((permission) =>
  permission.collection('reportDefinitions').title(definitionTitle)
    .read(['id', 'key', 'titleKey', 'category']));

export const REPORT_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'reportDefinitions', title: definitionTitle, actions: ['read'] },
];

export const REPORT_ACTIONS = ['view', 'run', 'export', 'favorite'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export const reports = defineCompositeResource('reports', (resource) => {
  let result = resource.title(title('authorization.reports.title'));
  for (const action of REPORT_ACTIONS) {
    result = result.action(action, (definition) =>
      definition.title(title(`authorization.reports.actions.${action}`))
        .grant('reportDefinitions', readDefinitions));
  }
  return result;
});
