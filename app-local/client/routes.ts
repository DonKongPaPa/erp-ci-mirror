import databaseExplorerRoutes from './pages/settings/database-explorer/routes.js';
import { createAppClientConfig } from '@nocobase/app-client';
import { readAppClientRuntimeConfig } from '@nocobase/app-client/runtime';
import { includeNotificationTemplateRoutes } from './pages/settings/notification-routes.js';
import notificationLogRoutes from './pages/settings/notification-log-routes.js';
import { ITEMS_PAGE_ID } from './pages/items/page-id.js';
import { BIZ_DICT_PAGE_ID } from './pages/biz-dict/page-id.js';
import { PURCHASE_ORDERS_PAGE_ID } from './pages/purchase-orders/page-id.js';
import { SALES_ORDERS_PAGE_ID } from './pages/sales-orders/page-id.js';
import { PARTNERS_PAGE_ID } from './pages/partners/page-id.js';
import { SHIFTS_PAGE_ID } from './pages/shifts/page-id.js';
import {
  INBOUND_ORDERS_PAGE_ID,
  OUTBOUND_ORDERS_PAGE_ID,
  STOCK_PAGE_ID,
} from './pages/stock-docs/page-id.js';
import { WAREHOUSES_PAGE_ID } from './pages/warehouses/page-id.js';
import {
  EXPENSES_PAGE_ID,
  INVOICE_RECEIPTS_PAGE_ID,
} from './pages/finance/page-id.js';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Boxes,
  Bot,
  ChartColumn,
  ClipboardCheck,
  Clock,
  Cpu,
  Handshake,
  Home,
  IdCard,
  MessageSquareWarning,
  MonitorSmartphone,
  Package,
  ReceiptText,
  ShieldAlert,
  ShoppingCart,
  Users,
  Warehouse,
  Wrench,
  Wallet,
} from 'lucide-react';
import {
  agentsRoute,
  modelsRoute,
  runtimesRoute,
  skillsRoute,
  usageRoute,
} from '@nocobase/app-plugin-agents/client/routes';
import {
  loadFeedbackDetailModule,
  loadFeedbackNewModule,
} from './pages/feedbacks/preload.js';
import { FEEDBACK_PAGE_ID } from './pages/feedbacks/page-id.js';
import settingsShellRoutes from './pages/settings/shell-routes.js';
import systemSettingsRoutes from './pages/settings/routes.js';
import importRoutes from './pages/settings/imports/routes.js';
import {
  defineAppRoutes,
  type AppClientRouteContribution,
} from '@nocobase/app-client/plugins';

const appRoutes: AppClientRouteContribution = defineAppRoutes([
  {
    // Every signed-in user reaches the landing page. `authz: 'skip'` takes it out of page authorization entirely, so
    // no permission change can leave a user signed in with nowhere to land.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/home/index.js'),
    name: 'home',
    navigation: { title: 'navigation.home', icon: Home },
    path: '/',
  },
  {
    // Declares no navigation, so the application decides where its entry goes (for example a sidebar item with an
    // unread badge). The plugin's API answers each person's own messages only, so the page needs no authorization of
    // its own.
    authz: 'skip',
    auth: 'required',
    componentLoader: () => import('./pages/inbox.js'),
    name: 'inbox',
    path: '/inbox',
  },
  {
    // 人事（《基座ERP前端设计》第一节）：可折叠的分组。现在只有班次定义一页；员工、部门从系统设置
    // 挪进来是另一片（设计 1.4），到时直接加进这个分组，路径与页面授权 id 都不变。
    auth: 'required',
    name: 'hr',
    navigation: { title: 'navigation.hr', icon: IdCard },
    children: [
      {
        // R-025 班次定义：页面授权 `shifts` 默认只给 root；打开之后读、写再分 shifts 的 view / manage。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: SHIFTS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.shifts' },
        componentLoader: () => import('./pages/shifts/index.js'),
        name: 'shifts',
        navigation: { title: 'navigation.shifts', icon: Clock },
        path: '/shifts',
        // 新建、编辑、复制新建都是路由上的对话框，从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/shifts/new.js'),
            name: 'shiftNew',
            path: 'new',
            presentation: { kind: 'dialog', title: 'shifts.form.newTitle' },
          },
          {
            componentLoader: () => import('./pages/shifts/edit.js'),
            name: 'shiftEdit',
            path: ':shiftId/edit',
            presentation: { kind: 'dialog', title: 'shifts.form.editTitle' },
          },
          {
            componentLoader: () => import('./pages/shifts/copy.js'),
            name: 'shiftCopy',
            path: ':shiftId/copy',
            presentation: { kind: 'dialog', title: 'shifts.form.copyTitle' },
          },
        ],
      },
    ],
  },
  {
    // R-014 客户与供应商：一条路由、一个页面授权 id，「客户」「供应商」两个标签靠
    // customers.view、suppliers.view 各自显隐（销售只看得到客户，采购只看得到供应商）。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: PARTNERS_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.partners' },
    componentLoader: () => import('./pages/partners/index.js'),
    name: 'partners',
    navigation: { title: 'navigation.partners', icon: Handshake },
    path: '/partners',
    children: [
      {
        componentLoader: () => import('./pages/partners/new.js'),
        name: 'partnerNew',
        path: 'new',
        presentation: { kind: 'dialog', title: 'partners.newTitle' },
      },
      {
        // 详情是抽屉；编辑与联系人的对话框叠在抽屉上，都从它继承授权。
        componentLoader: () => import('./pages/partners/detail.js'),
        name: 'partnerDetail',
        path: ':partnerId',
        presentation: { kind: 'drawer', title: 'partners.title' },
        children: [
          {
            componentLoader: () => import('./pages/partners/edit.js'),
            name: 'partnerEdit',
            path: 'edit',
            presentation: { kind: 'dialog', title: 'partners.form.editTitle' },
          },
          {
            componentLoader: () => import('./pages/partners/contact-new.js'),
            name: 'partnerContactNew',
            path: 'contacts/new',
            presentation: {
              kind: 'dialog',
              title: 'partners.contact.addTitle',
            },
          },
          {
            componentLoader: () => import('./pages/partners/contact-edit.js'),
            name: 'partnerContactEdit',
            path: 'contacts/:contactId/edit',
            presentation: {
              kind: 'dialog',
              title: 'partners.contact.editTitle',
            },
          },
          {
            // R-014 加片：交货地址是客户侧的数据，两条写端点只认 customers.update。
            componentLoader: () => import('./pages/partners/address-new.js'),
            name: 'partnerAddressNew',
            path: 'addresses/new',
            presentation: {
              kind: 'dialog',
              title: 'partners.address.addTitle',
            },
          },
          {
            componentLoader: () => import('./pages/partners/address-edit.js'),
            name: 'partnerAddressEdit',
            path: 'addresses/:addressId/edit',
            presentation: {
              kind: 'dialog',
              title: 'partners.address.editTitle',
            },
          },
        ],
      },
    ],
  },
  {
    // 物料与库存（《基座ERP前端设计》第一节）：可折叠的分组。这一片是库存查询、入库单、出库单、仓库四页；
    // 物料（R-019）由另一片加进这个分组，常用的在前、主数据在后。
    auth: 'required',
    name: 'inventory',
    navigation: { title: 'navigation.inventory', icon: Package },
    children: [
      {
        // R-020 库存查询：页面授权 `stock` 默认只给仓管；打开之后读要 inventory.stockView，只读。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: STOCK_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.stock' },
        componentLoader: () => import('./pages/stock/index.js'),
        name: 'stock',
        navigation: { title: 'navigation.stock', icon: Boxes },
        path: '/stock',
      },
      {
        // R-020 入库单：读要 stockView，建改草稿要 stockWrite，过账要 stockPost，作废要 stockVoid。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: INBOUND_ORDERS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.inboundOrders' },
        componentLoader: () => import('./pages/inbound-orders/index.js'),
        name: 'inboundOrders',
        navigation: {
          title: 'navigation.inboundOrders',
          icon: ArrowDownToLine,
        },
        path: '/inbound-orders',
        // 新建、详情、编辑都是盖在列表上的子页，从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/inbound-orders/new.js'),
            name: 'inboundOrderNew',
            path: 'new',
            breadcrumb: { title: 'stockDocs.in.newTitle' },
            presentation: { kind: 'child-page' },
          },
          {
            componentLoader: () => import('./pages/inbound-orders/detail.js'),
            name: 'inboundOrderDetail',
            path: ':docId',
            breadcrumb: { title: 'stockDocs.detail' },
            presentation: { kind: 'child-page' },
            children: [
              {
                componentLoader: () => import('./pages/inbound-orders/edit.js'),
                name: 'inboundOrderEdit',
                path: 'edit',
                breadcrumb: { title: 'stockDocs.in.editTitle' },
                presentation: { kind: 'child-page' },
              },
            ],
          },
        ],
      },
      {
        // R-020 出库单：授权与入库单一样。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: OUTBOUND_ORDERS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.outboundOrders' },
        componentLoader: () => import('./pages/outbound-orders/index.js'),
        name: 'outboundOrders',
        navigation: {
          title: 'navigation.outboundOrders',
          icon: ArrowUpFromLine,
        },
        path: '/outbound-orders',
        children: [
          {
            componentLoader: () => import('./pages/outbound-orders/new.js'),
            name: 'outboundOrderNew',
            path: 'new',
            breadcrumb: { title: 'stockDocs.out.newTitle' },
            presentation: { kind: 'child-page' },
          },
          {
            componentLoader: () => import('./pages/outbound-orders/detail.js'),
            name: 'outboundOrderDetail',
            path: ':docId',
            breadcrumb: { title: 'stockDocs.detail' },
            presentation: { kind: 'child-page' },
            children: [
              {
                componentLoader: () =>
                  import('./pages/outbound-orders/edit.js'),
                name: 'outboundOrderEdit',
                path: 'edit',
                breadcrumb: { title: 'stockDocs.out.editTitle' },
                presentation: { kind: 'child-page' },
              },
            ],
          },
        ],
      },
      {
        // R-020 仓库：页面授权 `warehouses` 给仓管、采购、销售；读要 warehouseView，建改要 warehouseManage（只有 root）。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: WAREHOUSES_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.warehouses' },
        componentLoader: () => import('./pages/warehouses/index.js'),
        name: 'warehouses',
        navigation: { title: 'navigation.warehouses', icon: Warehouse },
        path: '/warehouses',
        // 新建、编辑是路由上的对话框，从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/warehouses/new.js'),
            name: 'warehouseNew',
            path: 'new',
            presentation: { kind: 'dialog', title: 'warehouses.form.newTitle' },
          },
          {
            componentLoader: () => import('./pages/warehouses/edit.js'),
            name: 'warehouseEdit',
            path: ':warehouseId/edit',
            presentation: {
              kind: 'dialog',
              title: 'warehouses.form.editTitle',
            },
          },
        ],
      },
      {
        // R-019 物料：物料清单、计量单位、物料分类三个标签共用这一条路由（标签记在地址栏的 view 上）。
        // 页面授权 `items` 给销售、采购与 root；打开之后读、写再分 items 的 view / manage。
        auth: 'required',
        authz: {
          resource: { type: 'page', id: ITEMS_PAGE_ID },
          action: 'access',
        },
        breadcrumb: { title: 'navigation.items' },
        componentLoader: () => import('./pages/items/index.js'),
        name: 'items',
        navigation: { title: 'navigation.items', icon: Package },
        path: '/items',
        // 新建、编辑的路由对话框与详情抽屉都从这一页继承授权。
        children: [
          {
            componentLoader: () => import('./pages/items/new.js'),
            name: 'itemNew',
            path: 'new',
            presentation: { kind: 'dialog', title: 'items.form.newTitle' },
          },
          {
            // 详情是抽屉；编辑的对话框叠在抽屉上。
            componentLoader: () => import('./pages/items/detail.js'),
            name: 'itemDetail',
            path: ':itemId',
            presentation: { kind: 'drawer', title: 'items.detailTitle' },
            children: [
              {
                componentLoader: () => import('./pages/items/edit.js'),
                name: 'itemEdit',
                path: 'edit',
                presentation: {
                  kind: 'dialog',
                  title: 'items.form.editTitle',
                },
              },
            ],
          },
          {
            componentLoader: () => import('./pages/items/unit-new.js'),
            name: 'unitNew',
            path: 'units/new',
            presentation: { kind: 'dialog', title: 'items.units.newTitle' },
          },
          {
            componentLoader: () => import('./pages/items/unit-edit.js'),
            name: 'unitEdit',
            path: 'units/:unitCode/edit',
            presentation: { kind: 'dialog', title: 'items.units.editTitle' },
          },
          {
            componentLoader: () => import('./pages/items/category-new.js'),
            name: 'categoryNew',
            path: 'categories/new',
            presentation: {
              kind: 'dialog',
              title: 'items.categories.newTitle',
            },
          },
          {
            componentLoader: () => import('./pages/items/category-edit.js'),
            name: 'categoryEdit',
            path: 'categories/:categoryId/edit',
            presentation: {
              kind: 'dialog',
              title: 'items.categories.editTitle',
            },
          },
        ],
      },
    ],
  },
  {
    // R-021 采购订单：一页，入口直接进页面（《基座ERP前端设计》1.1）。页面授权 `purchaseOrders` 只给采购与 root；
    // 打开之后读、写再分 `purchaseOrders` 资源的各动作。另一类订单的角色一个动作都没有，也进不了这一页。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: PURCHASE_ORDERS_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.purchaseOrders' },
    componentLoader: () => import('./pages/purchase-orders/index.js'),
    name: 'purchaseOrders',
    navigation: { title: 'navigation.purchaseOrders', icon: ShoppingCart },
    path: '/purchase-orders',
    children: [
      {
        // 新建是盖在列表上的子页。
        name: 'purchaseOrderNew',
        path: 'new',
        breadcrumb: { title: 'purchaseOrders.newTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/purchase-orders/new.js'),
      },
      {
        // 一张单的子页；编辑的子页与「生成入库单」的对话框叠在它上面，都从这一页继承授权。
        name: 'purchaseOrder',
        path: ':purchaseOrderId',
        breadcrumb: { title: 'purchaseOrders.detailTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () =>
          import('./pages/purchase-orders/detail/index.js'),
        children: [
          {
            name: 'purchaseOrderEdit',
            path: 'edit',
            breadcrumb: { title: 'purchaseOrders.editTitle' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./pages/purchase-orders/edit.js'),
          },
          {
            name: 'purchaseOrderReceipt',
            path: 'create-receipt',
            presentation: {
              kind: 'dialog',
              title: 'purchaseOrders.receiptTitle',
            },
            componentLoader: () => import('./pages/purchase-orders/receipt.js'),
          },
        ],
      },
    ],
  },
  {
    // R-022 销售订单：一页，入口直接进页面（《基座ERP前端设计》1.1）。页面授权 `salesOrders` 只给销售与 root；
    // 打开之后读、写再分 `salesOrders` 资源的各动作。另一类订单的角色一个动作都没有，也进不了这一页。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: SALES_ORDERS_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.salesOrders' },
    componentLoader: () => import('./pages/sales-orders/index.js'),
    name: 'salesOrders',
    navigation: { title: 'navigation.salesOrders', icon: ReceiptText },
    path: '/sales-orders',
    children: [
      {
        // 新建是盖在列表上的子页。
        name: 'salesOrderNew',
        path: 'new',
        breadcrumb: { title: 'salesOrders.newTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/sales-orders/new.js'),
      },
      {
        // 一张单的子页；编辑的子页与「生成出库单」的对话框叠在它上面，都从这一页继承授权。
        name: 'salesOrder',
        path: ':salesOrderId',
        breadcrumb: { title: 'salesOrders.detailTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/sales-orders/detail/index.js'),
        children: [
          {
            name: 'salesOrderEdit',
            path: 'edit',
            breadcrumb: { title: 'salesOrders.editTitle' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./pages/sales-orders/edit.js'),
          },
          {
            name: 'salesOrderIssue',
            path: 'create-issue',
            presentation: { kind: 'dialog', title: 'salesOrders.receiptTitle' },
            componentLoader: () => import('./pages/sales-orders/receipt.js'),
          },
        ],
      },
    ],
  },
  {
    // R-072 业务字典：九个类型一页，标签记在地址栏的 type 上。页面授权 `bizDict` 只给 root
    // （维护入口）；采购、销售、仓管持 bizDict.view 在单据里用下拉选值，默认不进这一页。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: BIZ_DICT_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.bizDict' },
    componentLoader: () => import('./pages/biz-dict/index.js'),
    name: 'bizDict',
    navigation: { title: 'navigation.bizDict', icon: BookOpen },
    path: '/biz-dict',
    children: [
      {
        componentLoader: () => import('./pages/biz-dict/new.js'),
        name: 'bizDictNew',
        path: 'new',
        presentation: { kind: 'dialog', title: 'bizDict.form.newTitle' },
      },
      {
        componentLoader: () => import('./pages/biz-dict/edit.js'),
        name: 'bizDictEdit',
        path: ':entryId/edit',
        presentation: { kind: 'dialog', title: 'bizDict.form.editTitle' },
      },
    ],
  },
  {
    // R-065 支出记录：页面授权只给财务与 root；打开之后读、写再分 `expenses` 资源的动作。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: EXPENSES_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.expenses' },
    componentLoader: () => import('./pages/expenses/index.js'),
    name: 'expenses',
    navigation: { title: 'navigation.expenses', icon: Wallet },
    path: '/expenses',
    children: [
      {
        name: 'expenseNew',
        path: 'new',
        breadcrumb: { title: 'expenses.newTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/expenses/new.js'),
      },
      {
        name: 'expense',
        path: ':expenseId',
        breadcrumb: { title: 'expenses.detailTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/expenses/detail/index.js'),
        children: [
          {
            name: 'expenseEdit',
            path: 'edit',
            breadcrumb: { title: 'expenses.editTitle' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./pages/expenses/edit.js'),
          },
        ],
      },
    ],
  },
  {
    // R-065 到票记录：与支出记录同一骨架，页面授权只给财务与 root。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: INVOICE_RECEIPTS_PAGE_ID },
      action: 'access',
    },
    breadcrumb: { title: 'navigation.invoiceReceipts' },
    componentLoader: () => import('./pages/invoice-receipts/index.js'),
    name: 'invoiceReceipts',
    navigation: { title: 'navigation.invoiceReceipts', icon: ReceiptText },
    path: '/invoice-receipts',
    children: [
      {
        name: 'invoiceReceiptNew',
        path: 'new',
        breadcrumb: { title: 'invoiceReceipts.newTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/invoice-receipts/new.js'),
      },
      {
        name: 'invoiceReceipt',
        path: ':invoiceReceiptId',
        breadcrumb: { title: 'invoiceReceipts.detailTitle' },
        presentation: { kind: 'child-page' },
        componentLoader: () => import('./pages/invoice-receipts/detail/index.js'),
        children: [
          {
            name: 'invoiceReceiptEdit',
            path: 'edit',
            breadcrumb: { title: 'invoiceReceipts.editTitle' },
            presentation: { kind: 'child-page' },
            componentLoader: () => import('./pages/invoice-receipts/edit.js'),
          },
        ],
      },
    ],
  },
  {
    // 质量工单看板：客户反馈初筛与分流。
    // authz 声明在路径首个页面上，page id 用于存储页面授权，改名需要迁移引用它的授权。
    auth: 'required',
    authz: { resource: { type: 'page', id: 'quality' }, action: 'access' },
    componentLoader: () => import('./pages/quality/index.js'),
    name: 'quality',
    navigation: { title: 'navigation.quality', icon: ShieldAlert },
    path: '/quality',
  },
  {
    // R-026：反馈单。另设页面授权（两个动作任一都能进来），能做什么在页面里按动作分；
    // 不挂在质量页下面，否则普通员工会连质量页一起打得开。
    auth: 'required',
    authz: {
      resource: { type: 'page', id: FEEDBACK_PAGE_ID },
      action: 'access',
    },
    componentLoader: () => import('./pages/feedbacks/index.js'),
    name: 'feedbacks',
    navigation: { title: 'navigation.feedbacks', icon: MessageSquareWarning },
    path: '/feedbacks',
    children: [
      {
        name: 'feedbackNew',
        path: 'new',
        presentation: { kind: 'dialog', title: 'feedbacks.form.titleNew' },
        componentLoader: loadFeedbackNewModule,
      },
      {
        name: 'feedbackDetail',
        path: ':feedbackId',
        presentation: { kind: 'dialog', title: 'feedbacks.form.titleEdit' },
        componentLoader: loadFeedbackDetailModule,
      },
    ],
  },
  {
    // R-017 M5：审批的三个页面。个人数据页取 authz: 'skip'（同 inbox），入口对所有登录用户可见，
    // 行级资格由端点按申请人/审批人过滤。列表的页签与筛选记在地址栏查询参数里。
    auth: 'required',
    name: 'approvals',
    navigation: { title: 'navigation.approvals', icon: ClipboardCheck },
    children: [
      {
        auth: 'required',
        authz: 'skip',
        breadcrumb: { title: 'navigation.approvalMine' },
        componentLoader: () => import('./pages/approvals/mine.js'),
        name: 'approvalMine',
        navigation: { title: 'navigation.approvalMine' },
        path: '/approvals/mine',
      },
      {
        auth: 'required',
        authz: 'skip',
        breadcrumb: { title: 'navigation.approvalTasks' },
        componentLoader: () => import('./pages/approvals/tasks.js'),
        name: 'approvalTasks',
        navigation: { title: 'navigation.approvalTasks' },
        path: '/approvals/tasks',
      },
      {
        auth: 'required',
        authz: 'skip',
        breadcrumb: { title: 'approvals.detail.title' },
        componentLoader: () => import('./pages/approvals/detail.js'),
        name: 'approvalDetail',
        path: '/approvals/:id',
      },
    ],
  },
  {
    // R-032「我的 API 密钥」：每个登录用户只管自己的密钥，接口只作用于本人。
    // 所以页面像 inbox 一样不需要页面授权；入口在右上角账号菜单，不声明 navigation。
    auth: 'required',
    authz: 'skip',
    componentLoader: () => import('./pages/account/api-keys.js'),
    name: 'apiKeysManagement',
    path: '/account/api-keys',
  },
  {
    // R-076：浏览器打印视图。不进侧栏，也不登记页面授权——进入时由视图按 docType
    // 检查对应的 print 动作；没有就显示 403，且不发取数请求。
    auth: 'required',
    authz: 'skip',
    componentLoader: () => import('./pages/doc-print/index.js'),
    name: 'docPrintView',
    path: '/main/doc-print/:docType/:docNo',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/login.js'),
    name: 'login',
    path: '/login',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/register.js'),
    name: 'register',
    path: '/register',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/forgot-password.js'),
    name: 'forgot-password',
    path: '/forgot-password',
  },
  {
    auth: 'guest',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/reset-password.js'),
    name: 'reset-password',
    path: '/reset-password',
  },
  {
    // Where a command line's sign-in sends the person to approve it (`pages/auth/device.tsx`). Optional rather than
    // required so it renders outside the shell, like the sign-in pages; the page sends a guest to sign in and back.
    auth: 'optional',
    authz: 'skip',
    componentLoader: () => import('./pages/auth/device.js'),
    name: 'device',
    path: '/device',
  },
  {
    // The AI Agent plugin's five pages are routed by this application (`@nocobase/app-plugin-agents/client/routes`
    // exports them without navigation). They keep the plugin's own top-level paths: its skills pages link to `/skills`
    // directly, so moving them under `/settings` would break those links.
    auth: 'required',
    navigation: { title: 'navigation.ai', icon: Bot },
    name: 'ai',
    children: [
      // `agents.services` read rather than a page grant: the model services are a settings item.
      {
        ...modelsRoute,
        navigation: { title: 'navigation.aiModels', icon: Cpu },
      },
      {
        ...agentsRoute,
        navigation: { title: 'navigation.aiAgents', icon: Users },
      },
      {
        ...runtimesRoute,
        navigation: { title: 'navigation.aiRuntimes', icon: MonitorSmartphone },
      },
      {
        ...skillsRoute,
        navigation: { title: 'navigation.aiSkills', icon: Wrench },
      },
      {
        ...usageRoute,
        navigation: { title: 'navigation.aiUsage', icon: ChartColumn },
      },
    ],
  },
]);

// The System settings shell stays registered: it shows only the modules a viewer may open, and none until the
// application or its plugins contribute one. Business administration such as `./pages/settings/routes.js` joins it.
export function createApplicationRoutes(
  rawConfig: unknown = readAppClientRuntimeConfig(),
): readonly AppClientRouteContribution[] {
  const config = createAppClientConfig({ rawConfig });
  return includeNotificationTemplateRoutes(
    [
      appRoutes,
      settingsShellRoutes,
      systemSettingsRoutes,
      databaseExplorerRoutes,
      notificationLogRoutes,
      importRoutes,
    ],
    config.get<boolean>('notificationTemplates.invitationConfigured') === true,
  );
}

const routes: readonly AppClientRouteContribution[] = createApplicationRoutes();

export default routes;
