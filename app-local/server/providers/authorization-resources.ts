import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { ServiceProvider } from '@nocobase/service-provider';

import { APPROVAL_COLLECTIONS } from '../approvals-resources.js';
import {
  BIZ_DICT_COLLECTIONS,
  bizDict as bizDictResource,
  bizOptions as bizOptionsResource,
} from '../biz-dict-resources.js';
import {
  DEPARTMENT_COLLECTIONS,
  departments as departmentsResource,
} from '../department-resources.js';
import { DOC_FILE_COLLECTIONS } from '../doc-files-resources.js';
import {
  expenses as expenseRecordsResource,
  FINANCE_COLLECTIONS,
  invoiceReceipts as invoiceReceiptsResource,
} from '../finance-resources.js';
import { defineDepartmentRecordAccess } from '../department-record-access.js';
import {
  EMPLOYEE_COLLECTIONS,
  employees as employeesResource,
} from '../employees-resources.js';
import { FQC_COLLECTIONS, fqc } from '../fqc-resources.js';
import {
  INVENTORY_COLLECTIONS,
  inventory as inventoryResource,
} from '../inventory-resources.js';
import {
  PARTNER_COLLECTIONS,
  customers as customersResource,
  suppliers as suppliersResource,
} from '../partner-resources.js';
import { ITEM_COLLECTIONS, items as itemsResource } from '../items-resources.js';
import {
  ORDER_COLLECTIONS,
  purchaseOrders as purchaseOrdersResource,
  salesOrders as salesOrdersResource,
} from '../orders-resources.js';
import { SHIFT_COLLECTIONS, shifts as shiftsResource } from '../shift-resources.js';
import { departmentServiceToken } from './departments.js';

/**
 * R-013 的启动注册：把 FQC 接进授权模型；R-012 的部门资源、R-011 的员工资源
 * 也在这里登记。R-017 S1 只登记三张审批表，没有业务资源与业务动作（设计把
 * 授权放在端点自己身上，seed 默认不给业务角色审批授权）。
 *
 * 声明在 server/fqc-resources.ts、server/department-resources.ts、
 * server/employees-resources.ts、server/shift-resources.ts、
 * server/approvals-resources.ts 与 server/department-record-access.ts，这里只做注册：
 * FQC、部门、员工、班次、物料、往来单位、审批、库存的表，以及 `fqc`、`departments`、`employees`、
 * `shifts`、`items`、`customers`、`suppliers` 与 `inventory` 业务资源、两把部门范围键、工作区分节。
 * R-019 的物料三张表与 `items` 资源在这里登记；读、建、改默认只给 root，
 * 加片拆出的 `viewPurchasePrice` / `viewSalesPrice` 由 seed 各给一个业务角色。
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
      ...APPROVAL_COLLECTIONS,
      ...SHIFT_COLLECTIONS,
      ...PARTNER_COLLECTIONS,
      ...ITEM_COLLECTIONS,
      ...INVENTORY_COLLECTIONS,
      ...ORDER_COLLECTIONS,
      ...DOC_FILE_COLLECTIONS,
      ...FINANCE_COLLECTIONS,
      ...BIZ_DICT_COLLECTIONS,
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
    const shiftsReference = authz.compositeResources.define(shiftsResource);
    const customersReference = authz.compositeResources.define(customersResource);
    const suppliersReference = authz.compositeResources.define(suppliersResource);
    const itemsReference = authz.compositeResources.define(itemsResource);
    // R-020：库存资源只声明，不 ui.place —— 本片没有页面，也不改角色编辑器目录。
    authz.compositeResources.define(inventoryResource);
    // R-021/R-022：采购与销售订单各一份资源，同样不做页面目录。
    authz.compositeResources.define(purchaseOrdersResource);
    authz.compositeResources.define(salesOrdersResource);
    // R-072：字典与两个收窄的选项资源只声明，不做 ui.place —— 本片没有页面。
    authz.compositeResources.define(bizDictResource);
    authz.compositeResources.define(bizOptionsResource);
    authz.compositeResources.define(expenseRecordsResource);
    authz.compositeResources.define(invoiceReceiptsResource);
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
    authz.ui.sections.add({
      name: 'materials',
      title: { key: 'authorization.sections.materials', ns: 'app-local' },
      parent: 'business',
    });
    authz.ui.place(reference, { section: 'quality' });
    authz.ui.place(departmentsReference, { section: 'organization' });
    authz.ui.place(employeesReference, { section: 'organization' });
    authz.ui.place(shiftsReference, { section: 'organization' });
    authz.ui.place(customersReference, { section: 'organization' });
    authz.ui.place(suppliersReference, { section: 'organization' });
    authz.ui.place(itemsReference, { section: 'materials' });
    this.registered = true;
    return Promise.resolve();
  }
}
