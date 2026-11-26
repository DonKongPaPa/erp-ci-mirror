import {
  Building2,
  ContactRound,
  Users,
  ShieldCheck,
  KeyRound,
  ListFilter,
} from 'lucide-react';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

import { EMPLOYEES_PAGE_ID } from './employees/page-id.js';

/**
 * Users and Permission management, in the Accounts and permissions category of the System settings shell
 * (`shell-routes.ts`). Register this contribution as business capabilities are developed; a bare application stays
 * without them.
 */
const systemSettingsRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    parent: 'settingsAccount',
    name: 'settingsUsers',
    path: '/users',
    auth: 'required',
    authz: { resource: { type: 'user', id: '*' }, action: 'read' },
    navigation: {
      title: 'settings.users',
      description: 'settings.usersDescription',
      icon: Users,
    },
    breadcrumb: { title: 'settings.users' },
    componentLoader: () => import('./users.js'),
    children: [
      // The forms declare their presentation, so the dialog or drawer opens at once and the wait for the form's module,
      // its authorization and its data stays inside it instead of under the list.
      {
        name: 'settingsUserCreate',
        path: 'create',
        authz: { resource: { type: 'user', id: '*' }, action: 'create' },
        presentation: { kind: 'dialog', title: 'settings.newUser' },
        componentLoader: () => import('./user-form.js'),
      },
      // A sibling rather than the parent of the editor, so closing the drawer returns to the list instead of to this
      // route, which only forwards older detail links to the editor.
      {
        name: 'settingsUser',
        path: ':userId',
        componentLoader: () => import('./user-detail.js'),
      },
      {
        name: 'settingsUserEdit',
        path: ':userId/edit',
        presentation: { kind: 'drawer', title: 'settings.editUser' },
        componentLoader: () => import('./user-form.js'),
      },
    ],
  },
  {
    parent: 'settingsAccount',
    name: 'settingsDepartments',
    path: '/departments',
    auth: 'required',
    // R-013 七步里的「页面声明」：页面本身是一份授权；读写部门另由业务资源
    // `departments` 的 view / manage 两个动作控制（R-012）。
    authz: { resource: { type: 'page', id: 'departments' }, action: 'access' },
    navigation: {
      title: 'settings.departments',
      description: 'settings.departmentsDescription',
      icon: Building2,
    },
    breadcrumb: { title: 'settings.departments' },
    componentLoader: () => import('./departments/index.js'),
  },
  {
    // R-011 员工管理页：页面授权 `employees` 不写进任何业务角色的 seed，默认只有 root 能进。
    // 页面里的读、写再分别要 `employees` 的 view / manage 两个动作。
    parent: 'settingsAccount',
    name: 'settingsEmployees',
    path: '/employees',
    auth: 'required',
    authz: { resource: { type: 'page', id: EMPLOYEES_PAGE_ID }, action: 'access' },
    navigation: {
      title: 'settings.employees',
      description: 'settings.employeesDescription',
      icon: ContactRound,
    },
    breadcrumb: { title: 'settings.employees' },
    componentLoader: () => import('./employees/index.js'),
  },
  {
    parent: 'settingsAccount',
    name: 'permissionManagement',
    navigation: {
      title: 'settings.permissionManagement',
      description: 'settings.permissionManagementDescription',
      icon: ShieldCheck,
    },
    breadcrumb: { title: 'settings.permissionManagement' },
    children: [
      {
        name: 'settingsRoles',
        path: '/roles',
        auth: 'required',
        authz: {
          resource: {
            type: 'settings',
            id: 'authorization.permission-sets',
          },
          action: 'read',
        },
        navigation: { title: 'settings.roles', icon: KeyRound },
        breadcrumb: { title: 'settings.roles' },
        componentLoader: () => import('./roles.js'),
        children: [
          {
            name: 'settingsRoleCreate',
            path: 'create',
            authz: {
              resource: {
                type: 'settings',
                id: 'authorization.permission-sets',
              },
              action: 'create',
            },
            breadcrumb: { title: 'settings.newRole' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./role-form.js'),
          },
          {
            name: 'settingsRoleEdit',
            path: ':key/edit',
            breadcrumb: { title: 'settings.editRole' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./role-form.js'),
          },
        ],
      },
      {
        name: 'settingsDefaultAccess',
        path: '/default-access',
        auth: 'required',
        authz: {
          resource: {
            type: 'settings',
            id: 'authorization.default-access',
          },
          action: 'read',
        },
        navigation: {
          title: 'settings.defaultAccess.title',
          icon: ListFilter,
        },
        breadcrumb: { title: 'settings.defaultAccess.title' },
        componentLoader: () => import('./default-access.js'),
        children: [
          {
            name: 'settingsDefaultAccessCreate',
            path: 'create',
            authz: {
              resource: {
                type: 'settings',
                id: 'authorization.default-access',
              },
              action: 'create',
            },
            breadcrumb: { title: 'settings.defaultAccess.new' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./default-access-form.js'),
          },
          // Read permission opens the full rule even when the viewer may not update it.
          {
            name: 'settingsDefaultAccessEdit',
            path: ':key/edit',
            breadcrumb: { title: 'settings.defaultAccess.edit' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./default-access-form.js'),
          },
        ],
      },
    ],
  },
  {
    // R-032「应用 API 密钥」：给服务账号签发密钥。页面授权 `application.api-keys`
    // 不写进任何角色的 seed，所以默认只有 root 能进；业务角色连卡片都看不到。
    parent: 'settingsAccount',
    name: 'applicationApiKeysManagement',
    // 注册后的地址是 /settings/api-keys：设置外壳已经提供 /settings 这一段。
    path: '/api-keys',
    auth: 'required',
    authz: {
      resource: { type: 'page', id: 'application.api-keys' },
      action: 'access',
    },
    navigation: {
      title: 'settings.applicationApiKeys',
      description: 'settings.applicationApiKeysDescription',
      icon: KeyRound,
    },
    breadcrumb: { title: 'settings.applicationApiKeys' },
    componentLoader: () => import('./application-api-keys.js'),
  },
]);
export default systemSettingsRoutes;
