import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { ServiceProvider } from '@nocobase/service-provider';

import {
  DEPARTMENT_COLLECTIONS,
  departments as departmentsResource,
} from '../department-resources.js';
import { defineDepartmentRecordAccess } from '../department-record-access.js';
import {
  EMPLOYEE_COLLECTIONS,
  employees as employeesResource,
} from '../employees-resources.js';
import { FQC_COLLECTIONS, fqc } from '../fqc-resources.js';
import { departmentServiceToken } from './departments.js';

/**
 * R-013 的启动注册：把 FQC 接进授权模型；R-012 的部门资源、R-011 的员工资源
 * 也在这里登记。
 *
 * 声明在 server/fqc-resources.ts、server/department-resources.ts、
 * server/employees-resources.ts 与 server/department-record-access.ts，这里只做注册：
 * 三张 FQC 表、三张部门表、四张员工表、`fqc`、`departments` 与 `employees`
 * 三个业务资源、两把部门范围键、工作区的分节与条目。
 * 注册只描述能做什么，不给任何人授权；初始角色由 seed 建。
 */
export default class AuthorizationResourcesProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.authorization-resources';

  private registered = false;

  override boot(): Promise<void> {
    // 授权插件可以不在：模板允许把它从组合里去掉，那时没有任何东西可注册。
    // 已经注册过就直接返回：`boot()` 可以被调用两次，而 `compositeResources.define`
    // 对同名资源一律抛「already defined」。框架自带的 provider 也都做了这个守卫。
    if (!this.app.container.has(authorizationToken) || this.registered) {
      return Promise.resolve();
    }
    const authz = this.app.container.resolve(authorizationToken);
    for (const collection of [
      ...FQC_COLLECTIONS,
      ...DEPARTMENT_COLLECTIONS,
      ...EMPLOYEE_COLLECTIONS,
    ]) {
      authz.database.collections.add(collection);
    }
    const reference = authz.compositeResources.define(fqc);
    const departmentsReference = authz.compositeResources.define(
      departmentsResource,
    );
    const employeesReference = authz.compositeResources.define(
      employeesResource,
    );
    const departmentService = this.app.container.resolve(
      departmentServiceToken,
    );
    for (const access of defineDepartmentRecordAccess(departmentService)) {
      authz.recordAccess.define(access);
    }
    authz.ui.sections.add({
      name: 'quality',
      title: { key: 'authorization.sections.quality', ns: 'app-local' },
      parent: 'business',
    });
    authz.ui.sections.add({
      name: 'organization',
      title: { key: 'authorization.sections.organization', ns: 'app-local' },
      parent: 'business',
    });
    authz.ui.place(reference, { section: 'quality' });
    authz.ui.place(departmentsReference, { section: 'organization' });
    authz.ui.place(employeesReference, { section: 'organization' });
    this.registered = true;
    return Promise.resolve();
  }
}
