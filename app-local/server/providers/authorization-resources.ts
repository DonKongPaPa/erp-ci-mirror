import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import { ServiceProvider } from '@nocobase/service-provider';

import {
  APPROVAL_COLLECTIONS,
  APPROVAL_RECORD_ACCESS,
  APPROVAL_RESOURCE,
} from '../approvals-resources.js';
import {
  BIZ_DICT_COLLECTIONS,
  bizDict as bizDictResource,
  bizOptions as bizOptionsResource,
} from '../biz-dict-resources.js';
import {
  DEPARTMENT_COLLECTIONS,
  departments as departmentsResource,
} from '../department-resources.js';
import { DOC_PRINT_RESOURCES } from '../doc-print-resources.js';
import { DOC_FILE_COLLECTIONS } from '../doc-files-resources.js';
import {
  expenses as expenseRecordsResource,
  FINANCE_COLLECTIONS,
  invoiceReceipts as invoiceReceiptsResource,
} from '../finance-resources.js';
import {
  incomeRecords as incomeRecordsResource,
  payableRecons as payableReconsResource,
  RECONCILIATION_COLLECTIONS,
  receivableRecons as receivableReconsResource,
  saleInvoiceRecords as saleInvoiceRecordsResource,
} from '../reconciliation-resources.js';
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
import { IQC_COLLECTIONS, inspectionOrders as inspectionOrdersResource } from '../iqc-resources.js';
import { ITEM_COLLECTIONS, items as itemsResource } from '../items-resources.js';
import { BOM_COLLECTIONS, boms as bomsResource } from '../bom-resources.js';
import { REPORT_COLLECTIONS, reports as reportsResource } from '../reports-resources.js';
import {
  ORDER_COLLECTIONS,
  purchaseOrders as purchaseOrdersResource,
  salesOrders as salesOrdersResource,
} from '../orders-resources.js';
import {
  QUOTATION_COLLECTIONS,
  quotations as quotationsResource,
} from '../quotation-resources.js';
import {
  ORDER_REVIEW_COLLECTIONS,
  orderReviews as orderReviewsResource,
} from '../order-review-resources.js';
import { SHIFT_COLLECTIONS, shifts as shiftsResource } from '../shift-resources.js';
import { MES_COLLECTIONS, mesSettings as mesSettingsResource } from '../mes-resources.js';
import {
  STOCKTAKING_COLLECTIONS,
  stocktakings as stocktakingsResource,
} from '../stocktaking-resources.js';
import {
  TRANSFER_COLLECTIONS,
  transfers as transfersResource,
} from '../transfer-resources.js';
import {
  RETURN_COLLECTIONS,
  purchaseReturns as purchaseReturnsResource,
  salesReturns as salesReturnsResource,
} from '../returns-resources.js';
import {
  PURCHASE_REQUEST_COLLECTIONS,
  purchaseRequests as purchaseRequestsResource,
} from '../purchase-request-resources.js';
import { PURCHASE_REQUEST_RECORD_ACCESS } from '../purchase-request-record-access.js';
import {
  FINANCE_REQUEST_COLLECTIONS,
  financeRequests as financeRequestsResource,
} from '../finance-request-resources.js';
import { FINANCE_REQUEST_RECORD_ACCESS } from '../finance-request-record-access.js';
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
      ...BOM_COLLECTIONS,
      ...INVENTORY_COLLECTIONS,
      ...ORDER_COLLECTIONS,
      // R-022 复刻波 1：报价单头与明细两张表。
      ...QUOTATION_COLLECTIONS,
      ...DOC_FILE_COLLECTIONS,
      ...FINANCE_COLLECTIONS,
      ...RECONCILIATION_COLLECTIONS,
      ...BIZ_DICT_COLLECTIONS,
      ...ORDER_REVIEW_COLLECTIONS,
      ...FINANCE_REQUEST_COLLECTIONS,
      ...STOCKTAKING_COLLECTIONS,
      ...TRANSFER_COLLECTIONS,
      ...RETURN_COLLECTIONS,
      ...PURCHASE_REQUEST_COLLECTIONS,
      // R-070：采购检验单头与明细。
      ...IQC_COLLECTIONS,
      // R-023 W3-1：七张基础设置表。
      ...MES_COLLECTIONS,
      // R-078：报表定义表只读（四个入口动作各挂同一条窄读）。
      ...REPORT_COLLECTIONS,
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
    // R-019 波 2：BOM 资源只声明，不 ui.place —— 本片没有页面。
    authz.compositeResources.define(bomsResource);
    // R-020：库存资源只声明，不 ui.place —— 本片没有页面，也不改角色编辑器目录。
    authz.compositeResources.define(inventoryResource);
    // R-021/R-022：采购与销售订单各一份资源，同样不做页面目录。
    authz.compositeResources.define(purchaseOrdersResource);
    authz.compositeResources.define(salesOrdersResource);
    // R-022 复刻波 1：报价单资源六个动作，只声明、不做页面目录。
    authz.compositeResources.define(quotationsResource);
    // R-072：字典与两个收窄的选项资源只声明，不做 ui.place —— 本片没有页面。
    authz.compositeResources.define(bizDictResource);
    authz.compositeResources.define(bizOptionsResource);
    authz.compositeResources.define(expenseRecordsResource);
    authz.compositeResources.define(invoiceReceiptsResource);
    // R-065 复刻波 2：四份财务单据资源只声明、不 ui.place，授权只给 finance 与 root。
    authz.compositeResources.define(incomeRecordsResource);
    authz.compositeResources.define(saleInvoiceRecordsResource);
    authz.compositeResources.define(receivableReconsResource);
    authz.compositeResources.define(payableReconsResource);
    // R-017 M3：审批的业务动作与两把「仅本人」范围键。资源 id 用单数 approval，
    // 与 S1 守门测试里「不注册 approvals composite」不冲突；三张表仍是裸数据库资源。
    authz.compositeResources.define(APPROVAL_RESOURCE);
    // R-064：评审资源只声明，不做 ui.place —— 本片没有页面；销售订单的 ledgerView
    // 动作已在 orders-resources.ts 的销售资源上追加。
    authz.compositeResources.define(orderReviewsResource);
    // R-020 波 1：盘点与调拨只声明资源与动作，不做页面目录（页面随波 2）。
    authz.compositeResources.define(stocktakingsResource);
    authz.compositeResources.define(transfersResource);
    // R-020 波 2：退货单资源只声明动作，不做页面目录。
    authz.compositeResources.define(purchaseReturnsResource);
    authz.compositeResources.define(salesReturnsResource);
    // R-021 波 1 加片：请购单资源只声明、不 ui.place；staff 通过「仅本人」范围键收窄。
    authz.compositeResources.define(purchaseRequestsResource);
    // R-066：请款单资源只声明、不 ui.place；staff 通过「仅本人」范围键收窄。
    authz.compositeResources.define(financeRequestsResource);
    // R-070 IQC：只声明资源与六个动作，不做 ui.place（本片没有页面）。
    authz.compositeResources.define(inspectionOrdersResource);
    // R-023 W3-1：mesSettings 只有 view / maintain / priceView 三个动作，不做 ui.place。
    authz.compositeResources.define(mesSettingsResource);
    // R-076：三类打印单据各两个动作（print / printPrice）；表沿用 inventory 已登记的
    // stockDocs / stockDocLines，不重复登记，也不做页面目录（打印视图按 docType 自检动作）。
    for (const resource of DOC_PRINT_RESOURCES) authz.compositeResources.define(resource);
    // R-078：报表只声明四个入口动作，不做 ui.place；每张报表再按自己的 baseActions 二次判定。
    authz.compositeResources.define(reportsResource);
    const departmentService = this.app.container.resolve(
      departmentServiceToken,
    );
    for (const access of defineDepartmentRecordAccess(departmentService)) {
      authz.recordAccess.define(access);
    }
    for (const access of APPROVAL_RECORD_ACCESS) {
      authz.recordAccess.define(access);
    }
    for (const access of PURCHASE_REQUEST_RECORD_ACCESS) {
      authz.recordAccess.define(access);
    }
    for (const access of FINANCE_REQUEST_RECORD_ACCESS) {
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
