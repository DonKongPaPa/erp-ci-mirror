import { DatabaseBackup } from 'lucide-react';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

/**
 * R-068 导入工具：只在系统设置的「系统」分类里露出，不进普通业务导航。
 * 页面授权 `imports` 不写进任何业务角色的 seed，默认只有 root 能进；
 * 服务端的三个端点另外核对 root，直接打 API 也没有用。
 */
const importRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    parent: 'settingsSystem',
    name: 'imports',
    path: '/imports',
    auth: 'required',
    authz: { resource: { type: 'page', id: 'imports' }, action: 'access' },
    navigation: {
      title: 'settings.imports',
      description: 'settings.importsDescription',
      icon: DatabaseBackup,
    },
    breadcrumb: { title: 'settings.imports' },
    componentLoader: () => import('./index.js'),
  },
]);

export default importRoutes;
