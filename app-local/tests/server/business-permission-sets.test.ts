import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { PermissionGrant } from '@nocobase/authorization/core';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';
import type { QueryAdapter } from '@nocobase/db';

import businessPermissionSetsSeed, {
  businessPermissionSets,
  ensureBusinessPermissionSets,
  persistBusinessPermissionSets,
} from '../../database/main/seeds/202611240001_seed_business_permission_sets.js';
import { APPROVAL_GRANT } from '../../database/main/seeds/202611280002_seed_staff_approval_grants.js';
import catchupSeed from '../../database/main/seeds/202611280001_seed_business_permission_sets_catchup.js';
import orderReviewGrantsSeed, {
  orderReviewPermissionSets,
  persistOrderReviewGrants,
  planningPermissionSet,
  salesReviewPermissionSet,
} from '../../database/main/seeds/202611280003_seed_order_review_grants.js';
import orderReviewPageGrantsSeed, {
  persistOrderReviewPageGrants,
  planningPageGrants as expectedPlanningPageGrants,
  salesPageGrants as expectedSalesPageGrants,
} from '../../database/main/seeds/202611280015_seed_order_review_page_grants.js';
import docPrintSeed, {
  docPrintPermissionSets,
  persistDocPrintGrants,
  purchaseDocPrintGrants,
  salesDocPrintGrants,
  warehouseDocPrintGrants,
} from '../../database/main/seeds/202611280006_seed_doc_print_grants.js';
import { financePageGrants as expectedFinancePageGrants } from '../../database/main/seeds/202611280004_seed_finance_page_grants.js';
import financeRequestGrantsSeed, {
  financeFinanceRequestGrant,
  financeRequestPermissionSets,
  persistFinanceRequestGrants,
  staffFinanceRequestGrant,
} from '../../database/main/seeds/202611280017_seed_finance_request_grants.js';
import financeRequestPageGrantsSeed, {
  financeRequestPageGrant,
  financeRequestPagePermissionSets,
  persistFinanceRequestPageGrants,
} from '../../database/main/seeds/202611280018_seed_finance_request_page_grants.js';
import purchaseRequestGrantsSeed, {
  planningPurchaseRequestGrant,
  purchasePurchaseRequestGrant,
  purchaseRequestPermissionSets,
  staffPurchaseRequestGrant,
} from '../../database/main/seeds/202611280007_seed_purchase_request_grants.js';
import purchaseRequestPageGrantsSeed, {
  persistPurchaseRequestPageGrants,
  purchaseRequestPageGrant,
  purchaseRequestPagePermissionSets,
} from '../../database/main/seeds/202611280012_seed_purchase_request_page_grants.js';
import stocktakingTransferSeed, {
  financeStocktakingGrant,
  persistStocktakingTransferGrants,
  stocktakingTransferPermissionSets,
  warehouseStocktakingTransferGrants,
} from '../../database/main/seeds/202611280010_seed_stocktaking_transfer_grants.js';
import stocktakingTransferPageSeed, {
  persistStocktakingTransferPageGrants,
  stocktakingPageGrant,
  stocktakingTransferPagePermissionSets,
  transferPageGrant,
} from '../../database/main/seeds/202611280013_seed_stocktaking_transfer_page_grants.js';
import quotationGrantsSeed, {
  persistQuotationGrants,
  salesQuotationGrant,
  salesQuotationPermissionSet,
} from '../../database/main/seeds/202611280009_seed_quotation_grants.js';
import quotationPageGrantsSeed, {
  persistQuotationPageGrants,
  quotationPageGrant,
  quotationPagePermissionSet,
} from '../../database/main/seeds/202611280016_seed_quotation_page_grants.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-013 四个业务角色的 seed（验收标准第 1 条与第 11 条的前一半）。
 *
 * 角色的定义写在 seed 文件里，先在这里断言它的形状与设计一致（key、名称、授权、
 * 数据范围全部填 allRecords、没有「用户」资源的任何动作），再让 seed 写进库。
 * seed 的行为另测三件：重复执行不重复建、管理员改过的角色不被覆盖、已有的角色
 * 被跳过之后其余的角色仍要建出来（循环里用 continue，不是 return）。
 */
/** 两个质量角色持有确认记录表的全量范围：确认要读要写这张表。 */
const qualityFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
  fqcScreeningReviews: 'allRecords',
};

/** R-003 S2：部门主管的「查看」只配工单表的「本部门及下级」。 */
const deptFqcScopes = { fqcTickets: 'org.myDepartmentsAndBelow' };

/** R-026「提交反馈」：两张表都只有「仅本人」。 */
const submitFqcScopes = {
  fqcMessages: 'recordsIOwn',
  fqcScreenings: 'recordsIOwn',
};

/** R-026「维护反馈单」：三张表都是「全部」。 */
const maintainFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
};

const pageGrant = {
  resource: { type: 'page', id: 'quality' },
  actions: [{ action: 'access' }],
};

/** R-026：反馈单页的页面授权。 */
const feedbackPageGrant = {
  resource: { type: 'page', id: 'feedback' },
  actions: [{ action: 'access' }],
};

const knowledgePageGrant = {
  resource: { type: 'page', id: 'knowledge' },
  actions: [{ action: 'access' }],
};

/** R-014 页面片：客户与供应商页的页面授权，销售与采购各一条。 */
const partnersPageGrant = {
  resource: { type: 'page', id: 'partners' },
  actions: [{ action: 'access' }],
};

const pageGrantOf = (id: string) => ({
  resource: { type: 'page', id },
  actions: [{ action: 'access' }],
});
/** R-020 页面片：仓库页给仓管、采购、销售；库存查询、入库单、出库单只给仓管。 */
const warehousesPageGrant = pageGrantOf('warehouses');
const stockPageGrant = pageGrantOf('stock');
const inboundOrdersPageGrant = pageGrantOf('inboundOrders');
const outboundOrdersPageGrant = pageGrantOf('outboundOrders');
/** R-019 页面片：物料页的页面授权，销售与采购各一条；写（items.manage）不给任何业务角色。 */
const itemsPageGrant = {
  resource: { type: 'page', id: 'items' },
  actions: [{ action: 'access' }],
};
/** R-021 / R-022 页面片：采购只进采购订单页，销售只进销售订单页。 */
const purchaseOrdersPageGrant = {
  resource: { type: 'page', id: 'purchaseOrders' },
  actions: [{ action: 'access' }],
};
const salesOrdersPageGrant = {
  resource: { type: 'page', id: 'salesOrders' },
  actions: [{ action: 'access' }],
};

/** R-002：知识库的业务键是 `{ type: 'kb', id: 'kb.knowledge' }`，动作名带档位。 */
const knowledgeGrant = (action: 'manage.related' | 'propose.related') => ({
  resource: { type: 'kb', id: 'kb.knowledge' },
  actions: [{ action }],
});

const qualityViewScopes = {
  ...qualityFqcScopes,
  fqcRoutingRules: 'allRecords',
};
const qualityHandleScopes = {
  ...qualityFqcScopes,
  fqcRoutingRules: 'allRecords',
};
const ticketScopes = { fqcTickets: 'allRecords' };
const configureScopes = { fqcRoutingRules: 'allRecords' };

const fqcTicket = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'ticket', policy: { type: 'composite', scopes: ticketScopes } },
  ],
};

const fqcConfigure = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'configure',
      policy: { type: 'composite', scopes: configureScopes },
    },
  ],
};

const fqcView = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'view',
      policy: { type: 'composite', scopes: qualityViewScopes },
    },
  ],
};

const fqcInspectorView = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: qualityFqcScopes } },
  ],
};

const fqcHandle = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'handle',
      policy: { type: 'composite', scopes: qualityHandleScopes },
    },
  ],
};

const fqcViewOnly = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    { action: 'view', policy: { type: 'composite', scopes: deptFqcScopes } },
  ],
};

/** R-026：两个新动作各自成一条授权，不并进上面那条「查看、处理」。 */
const fqcSubmit = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'submit',
      policy: { type: 'composite', scopes: submitFqcScopes },
    },
  ],
};

const fqcMaintain = {
  resource: { type: 'composite', id: 'fqc' },
  actions: [
    {
      action: 'maintain',
      policy: { type: 'composite', scopes: maintainFqcScopes },
    },
  ],
};

/** R-025：班次定义不是人员信息，独立资源；staff 只读，没有 policy、没有页面授权。 */
const shiftsViewGrant = {
  resource: { type: 'composite', id: 'shifts' },
  actions: [{ action: 'view' }],
};

/** R-072：字典与两个收窄选项端点的只读授权；维护只给 root，不进任何业务角色。 */
const bizDictGrant = {
  resource: { type: 'composite', id: 'bizDict' },
  actions: [{ action: 'view' }],
};
const bizOptionsGrant = {
  resource: { type: 'composite', id: 'bizOptions' },
  actions: [{ action: 'view' }],
};

/** R-014：销售只拿 customers，采购只拿 suppliers，各三个动作。 */
const customerGrant = {
  resource: { type: 'composite', id: 'customers' },
  actions: [{ action: 'view' }, { action: 'create' }, { action: 'update' }],
};
const supplierGrant = {
  resource: { type: 'composite', id: 'suppliers' },
  actions: [{ action: 'view' }, { action: 'create' }, { action: 'update' }],
};

/** R-021/R-022：订单六动作各一条，另给物料与仓库只读；动作清单无删除。 */
const purchaseOrderGrant = {
  resource: { type: 'composite', id: 'purchaseOrders' },
  actions: [
    'view',
    'create',
    'update',
    'submit',
    'cancel',
    'createReceipt',
  ].map((action) => ({ action })),
};
const salesOrderGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: ['view', 'create', 'update', 'submit', 'cancel', 'createIssue'].map(
    (action) => ({ action }),
  ),
};
const orderItemRead = {
  resource: { type: 'composite', id: 'items' },
  actions: [{ action: 'view' }],
};
const orderWarehouseRead = {
  resource: { type: 'composite', id: 'inventory' },
  actions: [{ action: 'warehouseView' }],
};

/** R-019 加片：采购拿采购价、销售拿销售价；两个动作互不交叉，仓管两个都不给。 */
const purchasePriceGrant = {
  resource: { type: 'composite', id: 'items' },
  actions: [{ action: 'viewPurchasePrice' }],
};
const salesPriceGrant = {
  resource: { type: 'composite', id: 'items' },
  actions: [{ action: 'viewSalesPrice' }],
};

/** R-021/R-022 加片：订单价格管控，采购与销售各一份。 */
const purchaseOrderPriceGrant = {
  resource: { type: 'composite', id: 'purchaseOrders' },
  actions: [{ action: 'viewPrice' }],
};
const salesOrderPriceGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: [{ action: 'viewPrice' }],
};

/** R-020：仓管五个库存动作，不含 warehouseManage。 */
const inventoryGrant = {
  resource: { type: 'composite', id: 'inventory' },
  actions: [
    { action: 'warehouseView' },
    { action: 'stockView' },
    { action: 'stockWrite' },
    { action: 'stockPost' },
    { action: 'stockVoid' },
  ],
};

const stockPriceViewGrant = {
  resource: { type: 'composite', id: 'inventory' },
  actions: [{ action: 'stockPriceView' }],
};
const purchaseReceiveGrant = {
  resource: { type: 'composite', id: 'purchaseOrders' },
  actions: [{ action: 'receive' }],
};
const salesShipGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: [{ action: 'ship' }],
};
const reviewGrant = {
  resource: { type: 'composite', id: 'orderReviews' },
  actions: ['view', 'create', 'update', 'submit', 'confirm', 'void'].map((action) => ({ action })),
};
const reviewViewGrant = {
  resource: { type: 'composite', id: 'orderReviews' },
  actions: [{ action: 'view' }],
};
const ledgerViewGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: [{ action: 'ledgerView' }],
};

const expectedRoles = {
  quality_manager: {
    title: { key: 'permissionSets.business.qualityManager', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcView,
      fqcHandle,
      fqcTicket,
      fqcConfigure,
      feedbackPageGrant,
      fqcSubmit,
      fqcMaintain,
      knowledgePageGrant,
      knowledgeGrant('manage.related'),
    ],
  },
  quality_inspector: {
    title: { key: 'permissionSets.business.qualityInspector', ns: 'app-local' },
    grants: [
      pageGrant,
      fqcInspectorView,
      fqcHandle,
      fqcTicket,
      feedbackPageGrant,
      fqcSubmit,
      fqcMaintain,
      knowledgePageGrant,
      knowledgeGrant('propose.related'),
    ],
  },
  dept_manager: {
    title: { key: 'permissionSets.business.deptManager', ns: 'app-local' },
    grants: [pageGrant, fqcViewOnly],
  },
  staff: {
    title: { key: 'permissionSets.business.staff', ns: 'app-local' },
    grants: [feedbackPageGrant, fqcSubmit, shiftsViewGrant],
  },
  warehouse: {
    title: { key: 'permissionSets.business.warehouse', ns: 'app-local' },
    grants: [
      warehousesPageGrant,
      stockPageGrant,
      inboundOrdersPageGrant,
      outboundOrdersPageGrant,
      inventoryGrant,
      stockPriceViewGrant,
      purchaseReceiveGrant,
      salesShipGrant,
      bizDictGrant,
      bizOptionsGrant,
    ],
  },
  sales: {
    title: { key: 'permissionSets.business.sales', ns: 'app-local' },
    grants: [
      partnersPageGrant,
      salesOrdersPageGrant,
      warehousesPageGrant,
      customerGrant,
      salesOrderGrant,
      orderItemRead,
      orderWarehouseRead,
      itemsPageGrant,
      bizDictGrant,
      bizOptionsGrant,
      salesPriceGrant,
      salesOrderPriceGrant,
    ],
  },
  finance: {
    title: { key: 'permissionSets.business.finance', ns: 'app-local' },
    grants: [
      {
        resource: { type: 'composite', id: 'expenses' },
        actions: ['view', 'create', 'update', 'confirm', 'void'].map((action) => ({ action })),
      },
      {
        resource: { type: 'composite', id: 'invoiceReceipts' },
        actions: ['view', 'create', 'update', 'confirm', 'void'].map((action) => ({ action })),
      },
      {
        resource: { type: 'composite', id: 'purchaseOrders' },
        actions: [{ action: 'financeView' }],
      },
      bizDictGrant,
      bizOptionsGrant,
    ],
  },
  purchase: {
    title: { key: 'permissionSets.business.purchase', ns: 'app-local' },
    grants: [
      partnersPageGrant,
      purchaseOrdersPageGrant,
      warehousesPageGrant,
      supplierGrant,
      purchaseOrderGrant,
      orderItemRead,
      orderWarehouseRead,
      itemsPageGrant,
      bizDictGrant,
      bizOptionsGrant,
      purchasePriceGrant,
      purchaseOrderPriceGrant,
    ],
  },
} as const;

/** R-064：planning 与给 sales 的两条补丁授权从新种子取，断言照旧逐项钉住。 */
const expectedNewRoles = {
  planning: {
    title: { key: 'permissionSets.business.planning', ns: 'app-local' },
    grants: [reviewGrant, ledgerViewGrant],
  },
} as const;
const expectedSalesAdditions = [reviewViewGrant, ledgerViewGrant] as const;

/** R-021 波 1 加片：新种子给三个现成角色各追加一条请购单授权。 */
const expectedPurchaseRequestAdditions = {
  planning: [planningPurchaseRequestGrant],
  staff: [staffPurchaseRequestGrant],
  purchase: [purchasePurchaseRequestGrant],
} as const;
/** R-021 波 2：三个角色各补一条请购单页面授权，root 天然全通、不写进任何权限集。 */
const expectedPurchaseRequestPageGrants = {
  planning: [purchaseRequestPageGrant],
  staff: [purchaseRequestPageGrant],
  purchase: [purchaseRequestPageGrant],
} as const;
/** R-076：三颗打印补丁按角色钉住；仓管只有 print，没有 printPrice。 */
const expectedDocPrintGrants = {
  warehouse: warehouseDocPrintGrants,
  purchase: purchaseDocPrintGrants,
  sales: salesDocPrintGrants,
} as const;

/** R-066：新种子给 staff 与 finance 各追加一条请款单授权。 */
const expectedFinanceRequestAdditions = {
  staff: [staffFinanceRequestGrant],
  finance: [financeFinanceRequestGrant],
} as const;
/** R-066 页面片：新种子给 staff 与 finance 各追加一条页面授权，root 天然全通、不写进权限集。 */
const expectedFinanceRequestPageGrants = {
  staff: [financeRequestPageGrant],
  finance: [financeRequestPageGrant],
} as const;
/** R-020 波 1：盘点与调拨授权只在补丁种子里声明，原种子一份都不带。 */
const warehouseStocktakingGrants = warehouseStocktakingTransferGrants;
const expectedStocktakingGrantsByRole = {
  warehouse: warehouseStocktakingGrants,
  finance: [financeStocktakingGrant],
} as const;
/** R-020 波 2：仓库两页给仓管，盘点单页给财务；root 天然全通，不写进权限集。 */
const expectedStocktakingPageGrants = {
  warehouse: [stocktakingPageGrant, transferPageGrant],
  finance: [stocktakingPageGrant],
} as const;
/** R-022 复刻波 1：报价六个动作只追加给 sales，别的角色一份没有。 */
const expectedQuotationGrants = [salesQuotationGrant] as const;
/** R-022 波 2：报价单页面授权也只给 sales；root 天然全通，不写进权限集。 */
const expectedQuotationPageGrants = [quotationPageGrant] as const;
/** R-064 页面片：planning 多两条页面授权与选人的 bizOptions.view，sales 只多台账页。 */
const expectedPageGrantsByRole = {
  planning: expectedPlanningPageGrants,
  sales: expectedSalesPageGrants,
} as const;

const roleKeys = Object.keys(expectedRoles);
const newRoleKeys = Object.keys(expectedNewRoles);
const allRoleKeys = [...roleKeys, ...newRoleKeys];

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

test('R-013: declares the keys, titles and grants of the designed roles', () => {
  expect(businessPermissionSets.map((set) => set.key)).toEqual(roleKeys);
  for (const set of businessPermissionSets) {
    const expected = expectedRoles[set.key as keyof typeof expectedRoles];
    expect(set.title).toEqual(expected.title);
    expect(set.grants).toEqual(expected.grants);
  }
});

/** R-064：原种子恢复成主线样子后，planning 与 sales 补丁只由新种子声明。 */
test('R-064: the new seed declares planning and the sales additions', () => {
  expect(planningPermissionSet.key).toBe('planning');
  expect(planningPermissionSet.title).toEqual(
    expectedNewRoles.planning.title,
  );
  expect(planningPermissionSet.grants).toEqual(
    expectedNewRoles.planning.grants,
  );
  expect(salesReviewPermissionSet.key).toBe('sales');
  expect(salesReviewPermissionSet.grants).toEqual(expectedSalesAdditions);
  expect(orderReviewPermissionSets.map((set) => set.key)).toEqual([
    'planning',
    'sales',
  ]);
  // 原种子里不该再有 R-064 的任何授权；否则老环境校验和警告不会带来新角色。
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到评审授权`).not.toBe(
        'orderReviews',
      );
    }
  }
});

/** R-066：新种子只声明两个现成角色的请款单授权，staff 按建单人收窄。 */
test('R-066: the new seed declares only finance-request grants for staff and finance', () => {
  expect(financeRequestGrantsSeed.name).toBe('202611280017_seed_finance_request_grants');
  expect(financeRequestPermissionSets.map((set) => set.key)).toEqual(['staff', 'finance']);
  expect(financeRequestPermissionSets.map((set) => set.grants)).toEqual([
    [staffFinanceRequestGrant],
    [financeFinanceRequestGrant],
  ]);
  expect(staffFinanceRequestGrant.actions.map((entry) => entry.action)).toEqual([
    'view', 'create', 'update', 'submit', 'void',
  ]);
  expect(
    staffFinanceRequestGrant.actions.every(
      (entry) => entry.policy?.scopes?.financeRequestDocs === 'financeRequest.creatorOwn',
    ),
  ).toBe(true);
  expect(financeFinanceRequestGrant.actions.map((entry) => entry.action)).toEqual([
    'view', 'convert',
  ]);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到请款单授权`).not.toBe('financeRequests');
    }
  }
});

/**
 * 2026-11-28 定的规矩：幂等只看本条授权在不在，不比对角色的整份授权。
 * 两个角色先带着别的种子加的授权，种子照常补；已有动作不重复，落库必须带仅本人范围。
 */
test('R-066: the seed fills its own grants beside grants added by other seeds', async () => {
  const makeQuery = (rows: ReadonlyMap<string, string>) => {
    const stored = new Map(rows);
    const writes: { key: string; grants: string }[] = [];
    const query = {
      selectFrom: () => ({
        select: () => ({
          where: (_column: string, _op: string, key: string) => ({
            executeTakeFirst: async () => {
              const value = stored.get(key);
              return value === undefined ? undefined : { key, grants: value };
            },
          }),
        }),
      }),
      updateTable: () => ({
        set: (value: { grants: string }) => ({
          where: (_column: string, _op: string, key: string) => ({
            execute: async () => {
              writes.push({ key, grants: value.grants });
              stored.set(key, value.grants);
            },
          }),
        }),
      }),
    } as unknown as QueryAdapter;
    return { query, writes, stored };
  };

  /** 模拟别的种子后来加的同形状授权，以及 staff 上只补了一半的请款单授权。 */
  const otherGrant: PermissionGrant = {
    resource: { type: 'page', id: 'quotations' },
    actions: [{ action: 'access' }],
  };
  const partialStaffGrant: PermissionGrant = {
    resource: { type: 'composite', id: 'financeRequests' },
    actions: [staffFinanceRequestGrant.actions[0]!],
  };
  const state = makeQuery(
    new Map([
      ['staff', JSON.stringify([otherGrant, partialStaffGrant])],
      ['finance', JSON.stringify([otherGrant])],
    ]),
  );

  expect(await persistFinanceRequestGrants(state.query)).toEqual({
    granted: ['staff', 'finance'],
    skipped: [],
  });
  expect(state.writes.map((write) => write.key)).toEqual(['staff', 'finance']);
  const storedStaff = JSON.parse(state.stored.get('staff') ?? '[]') as PermissionGrant[];
  const storedFinance = JSON.parse(state.stored.get('finance') ?? '[]') as PermissionGrant[];
  // 已有授权一份不改、不重排；别的种子加的授权也留在原处。
  expect(storedStaff.slice(0, 2)).toEqual([otherGrant, partialStaffGrant]);
  expect(storedFinance[0]).toEqual(otherGrant);

  const staffActions = storedStaff
    .filter((grant) => grant.resource.id === 'financeRequests')
    .flatMap((grant) => grant.actions);
  expect(staffActions.map((entry) => entry.action)).toEqual([
    'view', 'create', 'update', 'submit', 'void',
  ]);
  // 范围键必须是「仅本人」，不能写成不带范围的更宽授权。
  expect(
    staffActions.every(
      (entry) => entry.policy?.scopes?.financeRequestDocs === 'financeRequest.creatorOwn',
    ),
  ).toBe(true);
  const financeActions = storedFinance
    .filter((grant) => grant.resource.id === 'financeRequests')
    .flatMap((grant) => grant.actions);
  expect(financeActions.map((entry) => entry.action)).toEqual(['view', 'convert']);
  expect(financeActions.every((entry) => entry.policy === undefined)).toBe(true);

  // 都已在：重跑什么都不写。
  expect(await persistFinanceRequestGrants(state.query)).toEqual({
    granted: [],
    skipped: ['staff', 'finance'],
  });
  expect(state.writes, '重跑不写').toHaveLength(2);

  // 角色不存在：跳过、不建新角色、不写。
  const absent = makeQuery(new Map());
  expect(await persistFinanceRequestGrants(absent.query)).toEqual({
    granted: [],
    skipped: ['staff', 'finance'],
  });
  expect(absent.writes, '不建新角色').toHaveLength(0);
});

/** R-066 页面片：018 只声明两个现成角色的页面授权，root 天然全通、不写进权限集。 */
test('R-066 页面片: the page seed declares only the finance request page grant for staff and finance', () => {
  expect(financeRequestPageGrantsSeed.name).toBe(
    '202611280018_seed_finance_request_page_grants',
  );
  expect(typeof financeRequestPageGrantsSeed.run).toBe('function');
  expect(financeRequestPageGrant).toEqual({
    resource: { type: 'page', id: 'financeRequests' },
    actions: [{ action: 'access' }],
  });
  expect(financeRequestPagePermissionSets.map((set) => set.key)).toEqual([
    'staff',
    'finance',
  ]);
  expect(financeRequestPagePermissionSets.map((set) => set.grants)).toEqual([
    [financeRequestPageGrant],
    [financeRequestPageGrant],
  ]);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(
        grant.resource.id,
        `${set.key} 不该在原种子拿到请款页面授权`,
      ).not.toBe('financeRequests');
    }
  }
});

/** 018 排在 017 之后：按本条授权判幂等，staff/finance 带着 017 的业务动作也照常补。 */
test('R-066 页面片: the page seed fills its grant beside other grants and re-runs write nothing', async () => {
  const makeQuery = (rows: ReadonlyMap<string, string>) => {
    const stored = new Map(rows);
    const writes: { key: string; grants: string }[] = [];
    const query = {
      selectFrom: () => ({
        select: () => ({
          where: (_column: string, _op: string, key: string) => ({
            executeTakeFirst: async () => {
              const value = stored.get(key);
              return value === undefined ? undefined : { key, grants: value };
            },
          }),
        }),
      }),
      updateTable: () => ({
        set: (value: { grants: string }) => ({
          where: (_column: string, _op: string, key: string) => ({
            execute: async () => {
              writes.push({ key, grants: value.grants });
              stored.set(key, value.grants);
            },
          }),
        }),
      }),
    } as unknown as QueryAdapter;
    return { query, writes, stored };
  };

  const otherGrant: PermissionGrant = {
    resource: { type: 'page', id: 'quotations' },
    actions: [{ action: 'access' }],
  };
  const state = makeQuery(
    new Map([
      ['staff', JSON.stringify([otherGrant])],
      ['finance', JSON.stringify([otherGrant, financeFinanceRequestGrant])],
    ]),
  );
  expect(await persistFinanceRequestPageGrants(state.query)).toEqual({
    granted: ['staff', 'finance'],
    skipped: [],
  });
  expect(state.writes.map((write) => write.key)).toEqual(['staff', 'finance']);
  expect(JSON.parse(state.stored.get('staff') ?? '[]')).toEqual([
    otherGrant,
    financeRequestPageGrant,
  ]);
  expect(JSON.parse(state.stored.get('finance') ?? '[]')).toEqual([
    otherGrant,
    financeFinanceRequestGrant,
    financeRequestPageGrant,
  ]);

  // 都已在：重跑什么都不写；角色不存在：跳过、不建新角色。
  expect(await persistFinanceRequestPageGrants(state.query)).toEqual({
    granted: [],
    skipped: ['staff', 'finance'],
  });
  expect(state.writes, '重跑不写').toHaveLength(2);
  const absent = makeQuery(new Map());
  expect(await persistFinanceRequestPageGrants(absent.query)).toEqual({
    granted: [],
    skipped: ['staff', 'finance'],
  });
  expect(absent.writes, '不建新角色').toHaveLength(0);
});

/** R-064 页面片：原种子与 003 都不带页面授权；页面授权只在 011 里声明。 */
test('R-064 pages: the new seed grants only the page access the pages need', () => {
  expect(orderReviewPageGrantsSeed.name).toBe(
    '202611280015_seed_order_review_page_grants',
  );
  expect(typeof orderReviewPageGrantsSeed.run).toBe('function');
  expect(expectedPlanningPageGrants).toEqual([
    {
      resource: { type: 'page', id: 'salesOrders' },
      actions: [{ action: 'access' }],
    },
    {
      resource: { type: 'page', id: 'orderLedger' },
      actions: [{ action: 'access' }],
    },
    {
      resource: { type: 'composite', id: 'bizOptions' },
      actions: [{ action: 'view' }],
    },
  ]);
  // sales 原种子已有销售订单页 access；这里只补台账页。
  expect(expectedSalesPageGrants).toEqual([
    {
      resource: { type: 'page', id: 'orderLedger' },
      actions: [{ action: 'access' }],
    },
  ]);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到台账页授权`).not.toBe(
        'orderLedger',
      );
    }
  }
});

test('R-064 pages: an administrator-changed role is skipped without writing', async () => {
  // 纯函数验证幂等分支：角色授权里出现未知形状就整条跳过，不碰库、不污染后续用例。
  const changed = {
    resource: { type: 'composite', id: 'someOtherResource' },
    actions: [{ action: 'view' }],
  };
  const query = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () => ({ key: 'sales', grants: JSON.stringify([changed]) }),
        }),
      }),
    }),
    updateTable: () => {
      throw new Error('管理员改过的角色不应被写入');
    },
  } as unknown as QueryAdapter;
  expect(await persistOrderReviewPageGrants(query)).toEqual({
    granted: [],
    skipped: ['planning', 'sales'],
  });
});

test('R-021 波 1：新种子只声明三个角色的请购单授权，staff 按建单人收窄', () => {
  expect(purchaseRequestGrantsSeed.name).toBe('202611280007_seed_purchase_request_grants');
  expect(purchaseRequestPermissionSets.map((set) => set.key)).toEqual([
    'planning', 'staff', 'purchase',
  ]);
  expect(purchaseRequestPermissionSets.map((set) => set.grants)).toEqual([
    [planningPurchaseRequestGrant],
    [staffPurchaseRequestGrant],
    [purchasePurchaseRequestGrant],
  ]);
  expect(planningPurchaseRequestGrant.actions.map((entry) => entry.action)).toEqual([
    'view', 'create', 'update', 'submit', 'void',
  ]);
  expect(staffPurchaseRequestGrant.actions.map((entry) => entry.action)).toEqual([
    'view', 'create', 'update', 'submit', 'void',
  ]);
  expect(
    staffPurchaseRequestGrant.actions.every(
      (entry) => entry.policy?.scopes?.purchaseRequests === 'purchaseRequest.creatorOwn',
    ),
  ).toBe(true);
  expect(purchasePurchaseRequestGrant.actions.map((entry) => entry.action)).toEqual([
    'view', 'convert',
  ]);
});

/** R-021 波 2：页面授权只由新种子声明，三个角色各一条；重跑不写，改过的角色跳过。 */
test('R-021 波 2: the page-grant seed gives planning, staff and purchase access and is idempotent', async ({
  app,
  connection,
}) => {
  expect(purchaseRequestPageGrantsSeed.name).toBe(
    '202611280012_seed_purchase_request_page_grants',
  );
  expect(purchaseRequestPageGrant).toEqual({
    resource: { type: 'page', id: 'purchaseRequests' },
    actions: [{ action: 'access' }],
  });
  expect(purchaseRequestPagePermissionSets.map((set) => set.key)).toEqual([
    'planning',
    'staff',
    'purchase',
  ]);
  for (const set of purchaseRequestPagePermissionSets) {
    expect(set.grants).toEqual([purchaseRequestPageGrant]);
  }
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到请购单页面授权`).not.toBe(
        'purchaseRequests',
      );
    }
  }

  const sets = app.container.resolve(authorizationToken).permissionSets;
  for (const key of ['planning', 'staff', 'purchase']) {
    expect((await sets.get(key))?.grants ?? []).toContainEqual(
      purchaseRequestPageGrant,
    );
  }
  for (const key of ['warehouse', 'sales', 'finance']) {
    expect((await sets.get(key))?.grants ?? []).not.toContainEqual(
      purchaseRequestPageGrant,
    );
  }
  expect(await persistPurchaseRequestPageGrants(connection.query)).toEqual({
    granted: [],
    skipped: ['planning', 'staff', 'purchase'],
  });

});

test('R-013: the seed creates the designed roles', async ({ app }) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const stored = await sets.list();
  for (const [key, expected] of Object.entries(expectedRoles)) {
    const set = stored.find((entry) => entry.key === key);
    expect(set, `seed 没有建出角色 ${key}`).toBeDefined();
    expect(set?.title).toEqual(expected.title);
    // 几颗种子都跑过：staff 在 M3 补了审批的两个仅本人动作；sales 在原种子的授权后面
    // 多出 R-064 的两条只读授权；warehouse / purchase / sales 再按 R-076 各补一份打印授权；
    // finance 再按 R-065 的页面片补两条页面授权（支出与到票两个页面）；
    // planning / staff / purchase 最后按 R-021 波 1 各补一条请购单授权；
    // staff 与 finance 的请款单授权来自 017，排在按整份授权判幂等的页面种子之后。
    expect(set?.grants).toEqual([
      ...expected.grants,
      ...(key === 'staff' ? [APPROVAL_GRANT] : []),
      ...(key === 'sales' ? expectedSalesAdditions : []),
      ...(key === 'finance' ? expectedFinancePageGrants : []),
      ...(expectedDocPrintGrants[key as keyof typeof expectedDocPrintGrants] ?? []),
      ...(expectedPurchaseRequestAdditions[key as keyof typeof expectedPurchaseRequestAdditions] ?? []),
      ...(expectedStocktakingGrantsByRole[key as keyof typeof expectedStocktakingGrantsByRole] ?? []),
      ...(key === 'sales' ? expectedQuotationGrants : []),
      ...(expectedStocktakingPageGrants[key as keyof typeof expectedStocktakingPageGrants] ?? []),
      ...(expectedPurchaseRequestPageGrants[key as keyof typeof expectedPurchaseRequestPageGrants] ?? []),
      ...(expectedPageGrantsByRole[key as keyof typeof expectedPageGrantsByRole] ?? []),
      ...(key === 'sales' ? expectedQuotationPageGrants : []),
      ...(expectedFinanceRequestAdditions[key as keyof typeof expectedFinanceRequestAdditions] ?? []),
      ...(expectedFinanceRequestPageGrants[key as keyof typeof expectedFinanceRequestPageGrants] ?? []),
    ]);
  }
});

/** 全新库：两颗种子都跑，planning 落库，sales 恰好多出两条只读授权。 */
test('R-064: the new seed creates planning and adds the two sales grants on a fresh database', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const stored = await sets.list();
  const planning = stored.find((entry) => entry.key === 'planning');
  expect(planning, '新种子没有建出 planning').toBeDefined();
  expect(planning?.title).toEqual(expectedNewRoles.planning.title);
  expect(planning?.grants).toEqual([
    ...expectedNewRoles.planning.grants,
    ...expectedPurchaseRequestAdditions.planning,
    ...expectedPurchaseRequestPageGrants.planning,
    ...expectedPlanningPageGrants,
  ]);

  const sales = stored.find((entry) => entry.key === 'sales');
  expect(sales?.grants).toEqual([
    ...expectedRoles.sales.grants,
    ...expectedSalesAdditions,
    ...salesDocPrintGrants,
    ...expectedQuotationGrants,
    ...expectedSalesPageGrants,
    ...expectedQuotationPageGrants,
  ]);

  // 重跑什么都不写：角色与授权都已经存在。
  expect(await persistOrderReviewGrants(connection.query)).toEqual({
    created: [],
    granted: [],
  });
});

/**
 * 全新库按文件名次序执行：012（请购单页面）、015（评审页签与总台账页面）、016（报价单页面）。
 * 015 在 016 之前跑，不必认识报价单页授权；016 只看本条授权在不在，sales 因此同时拿到
 * 总台账页与报价单页。逐角色钉住最终授权：planning 两份都在、sales 多一张总台账页与
 * 一张报价单页、别的角色不变。017 的请款单授权排在页面种子之后，也是这里的既有基线。
 */
test('R-064 页面片 / R-021 波 2 / R-022 波 2: 015 先于 016 执行，sales 同时拿到两份页面授权', async ({
  app,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const stored = new Map((await sets.list()).map((set) => [set.key, set]));

  expect(stored.get('planning')?.grants, 'planning 同时拿到 012 与 015 的授权').toEqual([
    ...expectedNewRoles.planning.grants,
    ...expectedPurchaseRequestAdditions.planning,
    ...expectedPurchaseRequestPageGrants.planning,
    ...expectedPlanningPageGrants,
  ]);

  expect(stored.get('sales')?.grants, 'sales 同时拿到 015 的总台账页与 016 的报价单页').toEqual([
    ...expectedRoles.sales.grants,
    ...expectedSalesAdditions,
    ...salesDocPrintGrants,
    ...expectedQuotationGrants,
    ...expectedSalesPageGrants,
    ...expectedQuotationPageGrants,
  ]);

  for (const key of [
    'quality_manager',
    'quality_inspector',
    'dept_manager',
    'staff',
    'warehouse',
    'purchase',
    'finance',
  ] as const) {
    expect(stored.get(key)?.grants, `${key} 不该被页面种子改动`).toEqual([
      ...expectedRoles[key].grants,
      ...(key === 'staff' ? [APPROVAL_GRANT] : []),
      ...(key === 'finance' ? expectedFinancePageGrants : []),
      ...(expectedDocPrintGrants[key as keyof typeof expectedDocPrintGrants] ?? []),
      ...(expectedPurchaseRequestAdditions[key as keyof typeof expectedPurchaseRequestAdditions] ?? []),
      ...(expectedStocktakingGrantsByRole[key as keyof typeof expectedStocktakingGrantsByRole] ?? []),
      ...(expectedPurchaseRequestPageGrants[key as keyof typeof expectedPurchaseRequestPageGrants] ?? []),
      ...(expectedStocktakingPageGrants[key as keyof typeof expectedStocktakingPageGrants] ?? []),
      ...(expectedFinanceRequestAdditions[key as keyof typeof expectedFinanceRequestAdditions] ?? []),
      ...(expectedFinanceRequestPageGrants[key as keyof typeof expectedFinanceRequestPageGrants] ?? []),
    ]);
  }
});

test('R-064 pages: the page-grant seed is idempotent on a fresh database', async ({
  connection,
}) => {
  // 全新库里 015 已经跑过：planning 与 sales 的目标授权都在，重跑什么都不写。
  // 这里不改角色授权 —— 同文件的后续用例共用这个库，改了会污染它们的基线。
  expect(await persistOrderReviewPageGrants(connection.query)).toEqual({
    granted: [],
    skipped: ['planning', 'sales'],
  });
});

/** R-076：打印授权只在补丁种子里声明，原种子一份都不带。 */
test('R-076: the new seed declares three roles print grants and the base seed has none', () => {
  expect(docPrintSeed.name).toBe('202611280006_seed_doc_print_grants');
  expect(docPrintPermissionSets.map((set) => set.key)).toEqual([
    'warehouse',
    'purchase',
    'sales',
  ]);
  for (const set of docPrintPermissionSets) {
    expect(set.grants).toEqual(
      expectedDocPrintGrants[set.key as keyof typeof expectedDocPrintGrants],
    );
  }
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到打印授权`).not.toMatch(
        /^docPrint/u,
      );
    }
  }
});

/** 全新库三份都补上；管理员改过的角色整条跳过，重跑不写。 */
test('R-076: fresh database gets the print grants, a changed role is never overwritten', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  for (const [key, expected] of Object.entries(expectedDocPrintGrants)) {
    const stored = (await sets.get(key))?.grants ?? [];
    for (const grant of expected) {
      expect(stored, `${key} 缺少打印授权`).toContainEqual(grant);
    }
  }
  expect(await persistDocPrintGrants(connection.query)).toEqual({
    created: [],
    granted: [],
    skipped: ['warehouse', 'purchase', 'sales'],
  });

  const changedGrants = [
    {
      resource: { type: 'page', id: 'quality' },
      actions: [{ action: 'access' }],
    },
  ];
  await sets.update('warehouse', { key: 'warehouse', grants: changedGrants });
  expect(await persistDocPrintGrants(connection.query)).toEqual({
    created: [],
    granted: [],
    skipped: ['warehouse', 'purchase', 'sales'],
  });
  expect((await sets.get('warehouse'))?.grants, '管理员改过的仓管不被覆盖').toEqual(
    changedGrants,
  );
});

/** R-022 复刻波 1：新种子只声明 sales 的六个报价动作，原种子一份不带。 */
test('R-022: the quotation seed declares six actions for sales only and is idempotent', async ({
  app,
  connection,
}) => {
  expect(quotationGrantsSeed.name).toBe('202611280009_seed_quotation_grants');
  expect(salesQuotationPermissionSet.key).toBe('sales');
  expect(salesQuotationPermissionSet.grants).toEqual(expectedQuotationGrants);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到报价授权`).not.toBe('quotations');
    }
  }
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const sales = (await sets.get('sales'))?.grants ?? [];
  expect(sales).toContainEqual(salesQuotationGrant);
  for (const key of ['purchase', 'warehouse', 'finance', 'staff']) {
    expect((await sets.get(key))?.grants ?? [], `${key} 不该拿到报价授权`).not.toContainEqual(
      salesQuotationGrant,
    );
  }
  expect(await persistQuotationGrants(connection.query)).toEqual({
    created: [], granted: [], skipped: ['sales'],
  });
});

/**
 * R-022 波 2：016 排在 015 之后，幂等只看报价单页这一条授权在不在 —— sales 带着
 * 015 给的总台账页（以及别的授权）时照常补上；在就跳过，不建新角色、不补用户指派。
 */
test('R-022 波 2: 016 grants the quotation page beside other grants and re-runs write nothing', async ({
  app,
}) => {
  expect(quotationPageGrantsSeed.name).toBe(
    '202611280016_seed_quotation_page_grants',
  );
  expect(quotationPageGrant).toEqual({
    resource: { type: 'page', id: 'quotations' },
    actions: [{ action: 'access' }],
  });
  expect(quotationPagePermissionSet.key).toBe('sales');
  expect(quotationPagePermissionSet.grants).toEqual(expectedQuotationPageGrants);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到报价单页面授权`).not.toBe(
        'quotations',
      );
    }
  }

  const sets = app.container.resolve(authorizationToken).permissionSets;
  expect((await sets.get('sales'))?.grants ?? []).toContainEqual(
    quotationPageGrant,
  );
  for (const key of ['purchase', 'warehouse', 'finance', 'staff', 'planning']) {
    expect(
      (await sets.get(key))?.grants ?? [],
      `${key} 不该拿到报价单页面授权`,
    ).not.toContainEqual(quotationPageGrant);
  }

  // 假查询只记录写入：sales 已带 015 的总台账页与别的授权，016 仍只追加报价单页。
  const makeQuery = (storedGrants: readonly PermissionGrant[] | undefined) => {
    let stored: string | undefined = storedGrants
      ? JSON.stringify(storedGrants)
      : undefined;
    const writes: string[] = [];
    const query = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () =>
              stored === undefined ? undefined : { key: 'sales', grants: stored },
          }),
        }),
      }),
      updateTable: () => ({
        set: (value: { grants: string }) => ({
          where: () => ({
            execute: async () => {
              writes.push(value.grants);
              stored = value.grants;
            },
          }),
        }),
      }),
    } as unknown as QueryAdapter;
    return { query, writes, current: () => stored };
  };

  const otherGrant: PermissionGrant = {
    resource: { type: 'page', id: 'quality' },
    actions: [{ action: 'access' }],
  };
  const salesWithOtherGrants = [...expectedSalesPageGrants, otherGrant];
  const state = makeQuery(salesWithOtherGrants);
  expect(await persistQuotationPageGrants(state.query)).toEqual({
    granted: ['sales'],
    skipped: [],
  });
  expect(JSON.parse(state.current() ?? '[]')).toEqual([
    ...salesWithOtherGrants,
    quotationPageGrant,
  ]);
  expect(state.writes).toHaveLength(1);
  expect(await persistQuotationPageGrants(state.query)).toEqual({
    granted: [],
    skipped: ['sales'],
  });
  expect(state.writes, '重跑不写').toHaveLength(1);

  // 角色不存在：跳过、不建新角色、不写。
  const missing = makeQuery(undefined);
  expect(await persistQuotationPageGrants(missing.query)).toEqual({
    granted: [],
    skipped: ['sales'],
  });
  expect(missing.writes, '不建新角色').toHaveLength(0);
});

/** 建一个持有所给角色的用户；用户名只收字母数字。 */
const createRoleUser = async (
  admin: Awaited<ReturnType<typeof signIn>>,
  name: string,
  role: string,
): Promise<string> => {
  const username = name.replace(/-/gu, '');
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
    },
    body: JSON.stringify({
      name,
      username,
      email: `${username}@example.test`,
      password: 'R026-seed-test-123!',
      roleScopes: { app: [role] },
    }),
  });
  expect(response.status, `建用户 ${name} 失败`).toBe(201);
  return ((await response.json()).data as { id: string }).id;
};

/** R-017 S1：审批三张表，seed 里没有任何业务角色拿到授权。 */
const APPROVAL_TABLES = ['approvals', 'approvalRounds', 'approvalRecords'];

/**
 * R-017 S1 的默认拒绝形状在 M3 被新种子延伸。原文保留：
 * 「staff 与零角色用户对三表的读、建、改都必须 deny」。M3 的新种子给 staff
 * 挂了 `approval.submit`（approvals 按 applicantId 仅本人）与 `approval.review`
 * （approvalRecords 按 assigneeId 仅本人），这两张表因此变成 conditional；
 * approvalRounds 与零角色用户仍默认拒绝。
 *
 * > Status: Outdated（2026-11-28，R-017 M3）上面那句 staff 全 deny 只适用于 S1。
 */
test('R-017 S1: with the seed applied, staff and a roleless user are denied on approval tables', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const staff = await createRoleUser(admin, 'r017-seed-staff', 'staff');
  const nobody = await createRoleUser(admin, 'r017-seed-nobody', 'staff');
  await authz.permissionSets.revoke(`user:${nobody}:staff`);

  const decision = (userId: string, table: string, action: string) =>
    authz.for({ principal: { type: 'user', id: userId } }).authorize({
      resource: { type: 'database.collection', id: table },
      action,
    });
  const codes = (d: { reasons: readonly { code: string }[] }) =>
    d.reasons.map((reason) => reason.code);

  for (const table of APPROVAL_TABLES) {
    for (const action of ['read', 'create', 'update'] as const) {
      const staffDecision = await decision(staff, table, action);
      if (table === 'approvalRounds') {
        expect(staffDecision.effect, `approvalRounds 不该放开 ${action}`).toBe('deny');
        expect(codes(staffDecision)).toContain('NO_OBJECT_PERMISSION');
      } else {
        expect(staffDecision.effect, `staff 只能有仅本人的 ${action} ${table}`).toBe(
          'conditional',
        );
      }
      const denied = await decision(nobody, table, action);
      expect(denied.effect, `零角色用户不该能 ${action} ${table}`).toBe('deny');
      expect(codes(denied), `零角色用户 ${action} ${table} 的拒绝原因`).toContain(
        'NO_OBJECT_PERMISSION',
      );
      const rootDecision = await decision(String(admin.user.id), table, action);
      expect(rootDecision.effect, `root 不能 ${action} ${table}`).not.toBe(
        'deny',
      );
    }
    const remove = await decision(String(admin.user.id), table, 'delete');
    expect(remove.effect, `delete 没有登记，root 也删得了 ${table}`).toBe(
      'deny',
    );
    expect(codes(remove)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');
  }
});

// 这一条要在「管理员改过的角色不被覆盖」之前跑：那条测试会把 quality_manager 的
// 授权改成只剩页面授权，后面的测试看到的不再是 seed 的初始状态。
test('R-026 25: seed 的五个动作逐条展开，该放行的没有 NO_MATCHING_GRANT', async ({
  app,
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const cases = [
    {
      role: 'staff',
      allowed: ['submit'],
      denied: ['view', 'handle', 'intake', 'maintain'],
    },
    {
      role: 'quality_manager',
      allowed: ['view', 'handle', 'submit', 'maintain'],
      denied: ['intake'],
    },
    {
      role: 'quality_inspector',
      allowed: ['view', 'handle', 'submit', 'maintain'],
      denied: ['intake'],
    },
    {
      role: 'dept_manager',
      allowed: ['view'],
      denied: ['handle', 'intake', 'submit', 'maintain'],
    },
  ] as const;

  for (const entry of cases) {
    const userId = await createRoleUser(
      admin,
      `r026seed${entry.role.replace(/_/gu, '')}`,
      entry.role,
    );
    const context = authz.for({ principal: { type: 'user', id: userId } });
    const allowed = new Set<string>(entry.allowed);
    // R-026 的建人初始化器会给每个「人」补基线 staff。这条用例验的是 seed 里
    // 各角色自己的授权，所以把基线撤掉（staff 本身就是要验的角色，不撤），
    // 让测试用户只持有被验的那一个角色。
    if (entry.role !== 'staff') {
      await authz.permissionSets.revoke(`user:${userId}:staff`);
    }
    for (const action of [...entry.allowed, ...entry.denied]) {
      const decision = await context.authorize({
        resource: { type: 'composite', id: 'fqc' },
        action,
      });
      const reasons = decision.reasons.map((reason) => reason.code);
      if (allowed.has(action)) {
        expect(decision.effect, `${entry.role} 应当能 ${action}`).not.toBe(
          'deny',
        );
        // 质量主管的「查看」「处理」没有因为加了新动作而丢。
        expect(
          reasons,
          `${entry.role} ${action} 返回 NO_MATCHING_GRANT`,
        ).not.toContain('NO_MATCHING_GRANT');
      } else {
        expect(decision.effect, `${entry.role} 不应当能 ${action}`).toBe(
          'deny',
        );
        expect(reasons, `${entry.role} ${action} 不是没有授权`).toContain(
          'NO_MATCHING_GRANT',
        );
      }
    }
  }
});

test('R-013: does not create the same role twice and keeps administrator changes', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;

  // 重复执行：除了 seed 的历史表，seed 自己也不重复建。
  expect(await persistBusinessPermissionSets(connection.query)).toEqual([]);

  const rowsFor = async () =>
    connection.query
      .selectFrom('authorizationPermissionSets')
      .select(['key', 'grants'])
      .where('key', 'in', roleKeys)
      .execute();
  expect((await rowsFor()).length).toBe(roleKeys.length);

  // 管理员改了 quality_manager 的授权，删掉另外两个角色，模拟“一部分已存在”。
  const changedGrants = [
    {
      resource: { type: 'page', id: 'quality' },
      actions: [{ action: 'access' }],
    },
  ];
  await sets.update('quality_manager', {
    key: 'quality_manager',
    grants: changedGrants,
  });
  await sets.delete('quality_inspector');
  await sets.delete('dept_manager');

  // 循环里跳过已存在的角色要用 continue：改了的不覆盖，缺的要补回来。
  expect(
    (await persistBusinessPermissionSets(connection.query)).sort(),
  ).toEqual(['dept_manager', 'quality_inspector']);

  const rows = await rowsFor();
  expect(rows.length).toBe(roleKeys.length);
  expect(rows.filter((row) => row.key === 'quality_manager').length).toBe(1);
  const stored = await sets.list();
  expect(stored.find((set) => set.key === 'quality_manager')?.grants).toEqual(
    changedGrants,
  );
  for (const key of ['quality_inspector', 'dept_manager']) {
    expect(stored.find((set) => set.key === key)?.grants).toEqual(
      expectedRoles[key as keyof typeof expectedRoles].grants,
    );
  }
});

/**
 * 存量环境：planning 还没建，sales 已被管理员改过。新种子只补出缺的角色，
 * 改过的 sales 一份不动；第二次执行也什么都不写。
 */
test('R-064: the new seed rebuilds planning but never overwrites a changed sales', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  await sets.delete('planning');
  const changedGrants = [
    {
      resource: { type: 'composite', id: 'orderReviews' },
      actions: [{ action: 'view' }],
    },
  ];
  await sets.update('sales', { key: 'sales', grants: changedGrants });

  expect(await persistOrderReviewGrants(connection.query)).toEqual({
    created: ['planning'],
    granted: [],
  });
  const stored = new Map((await sets.list()).map((set) => [set.key, set]));
  expect(stored.get('planning')?.title).toEqual(expectedNewRoles.planning.title);
  expect(stored.get('planning')?.grants).toEqual(
    expectedNewRoles.planning.grants,
  );
  expect(stored.get('sales')?.grants, '管理员改过的 sales 不被覆盖').toEqual(
    changedGrants,
  );

  expect(await persistOrderReviewGrants(connection.query)).toEqual({
    created: [],
    granted: [],
  });
  expect(
    (await sets.get('sales'))?.grants,
    '重跑也不覆盖管理员改过的 sales',
  ).toEqual(changedGrants);
});

test('R-013: writes no grant on the user resource for any business role', async ({
  connection,
}) => {
  const rows = await connection.query
    .selectFrom('authorizationPermissionSets')
    .select(['key', 'grants'])
    .where('key', 'in', allRoleKeys)
    .execute();
  expect(rows.length).toBe(allRoleKeys.length);
  for (const row of rows) {
    const grants = JSON.parse(String(row.grants)) as {
      resource: { type: string; id: string };
      actions: { action: string }[];
    }[];
    for (const grant of grants) {
      expect(
        grant.resource.type,
        `角色 ${String(row.key)} 授予了「用户」资源：${JSON.stringify(grant)}`,
      ).not.toBe('user');
    }
  }
});

/**
 * R-017 S1：审批的「默认授权」是默认拒绝。
 *
 * R-017.md 把审批授权放在端点自己身上、页面取 authz='skip'，没有定义 composite
 * 资源与业务动作；seed 因此不给任何业务角色审批表的授权，也不给「用户 · 读」
 * （R-028）。后续片在端点与页面落地时按实际读写列补声明与授权，本测试守住
 * 「没有在 seed 里先放开」这一条；谁加了一条宽授权这里就红。
 */
test('R-017 S1: the seed grants no approval table and no user resource to business roles', () => {
  for (const set of [...businessPermissionSets, ...orderReviewPermissionSets]) {
    for (const grant of set.grants) {
      expect(
        grant.resource.type,
        `角色 ${set.key} 被授了「用户」资源`,
      ).not.toBe('user');
      if (grant.resource.type === 'database.collection') {
        expect(
          APPROVAL_TABLES,
          `角色 ${set.key} 被授了审批表 ${grant.resource.id}`,
        ).not.toContain(grant.resource.id);
      }
      const scopes = grant.actions.flatMap((action) =>
        action.policy?.type === 'composite' && action.policy.scopes
          ? Object.keys(action.policy.scopes)
          : [],
      );
      for (const table of APPROVAL_TABLES) {
        expect(
          scopes,
          `角色 ${set.key} 的授权里出现了审批表 ${table}`,
        ).not.toContain(table);
      }
    }
  }
});

test('R-002: only the two quality roles get the confirmation-record scope in the seed', () => {
  // 确认记录表是「人的判断」。seed 只把它给两个质量角色；部门主管等角色没有这个
  // 范围键，底层就是拒绝 —— R-003 的收窄靠的就是这一点。
  for (const set of businessPermissionSets) {
    const actions = set.grants
      .filter((grant) => grant.resource.type === 'composite')
      .filter((grant) => grant.resource.id === 'fqc')
      .flatMap((grant) => grant.actions);
    const scoped = actions.some(
      (action) =>
        action.policy?.type === 'composite' &&
        action.policy.scopes !== undefined &&
        'fqcScreeningReviews' in action.policy.scopes,
    );
    expect(scoped, `角色 ${set.key} 的确认记录范围与设计不一致`).toBe(
      set.key === 'quality_manager' || set.key === 'quality_inspector',
    );
  }
});

test('R-002: the seed grants the knowledge actions the plugin registers, related not all', async ({
  app,
}) => {
  // 插件登记到授权模型的动作才是 `manage.related` / `propose.related` 这样的档位；
  // `kb.knowledge/manage` 是业务键，登记不出来。写成业务键时这里会红，角色编辑器里
  // 那一项也永远勾不上。
  const item = app.container
    .resolve(authorizationToken)
    .resourceTypes.get('kb')
    .items?.get('kb.knowledge');
  const registered = new Set(item?.actions.map((action) => action.name) ?? []);

  const knowledgeGrants = businessPermissionSets.flatMap((set) =>
    set.grants
      .filter((grant) => grant.resource.type === 'kb')
      .flatMap((grant) =>
        grant.actions.map((entry) => ({
          role: set.key,
          resourceId: grant.resource.id,
          action: entry.action,
        })),
      ),
  );
  expect(knowledgeGrants).toEqual([
    {
      role: 'quality_manager',
      resourceId: 'kb.knowledge',
      action: 'manage.related',
    },
    {
      role: 'quality_inspector',
      resourceId: 'kb.knowledge',
      action: 'propose.related',
    },
  ]);
  for (const grant of knowledgeGrants) {
    expect(
      registered.has(grant.action),
      `知识库动作 ${grant.action} 没有被插件登记`,
    ).toBe(true);
    expect(
      grant.action.endsWith('.all'),
      'seed 用 .related，不用 .all：.all 会覆盖以后新加的空间',
    ).toBe(false);
  }
  // 投递的服务账号也要有 read.related（管理员建它时的一步）：动作本身必须先被登记。
  expect(registered.has('read.related')).toBe(true);
});

test('R-013: names the seed after its file so the loader can find it', () => {
  expect(businessPermissionSetsSeed.name).toBe(
    '202611240001_seed_business_permission_sets',
  );
  expect(typeof businessPermissionSetsSeed.run).toBe('function');
});

test('R-064: names the new seed after its file so the loader can find it', () => {
  expect(orderReviewGrantsSeed.name).toBe(
    '202611280003_seed_order_review_grants',
  );
  expect(typeof orderReviewGrantsSeed.run).toBe('function');
});

test('R-075: the catchup seed is named after its file', () => {
  expect(catchupSeed.name).toBe(
    '202611280001_seed_business_permission_sets_catchup',
  );
  expect(typeof catchupSeed.run).toBe('function');
});

/**
 * R-075：老环境里先跑过原种子、后来它又被追加了角色，所以缺 warehouse 与 finance。
 * 新种子只补这两个；sales 被管理员改过的授权保持原样；重跑一次什么也不写。
 */
test('R-075: catchup rebuilds missing sets and keeps administrator changes', async ({
  app,
  connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const rowsFor = () =>
    connection.query
      .selectFrom('authorizationPermissionSets')
      .select('key')
      .where('key', 'in', roleKeys)
      .execute();

  // 模拟存量环境：两个后来加的角色不在，管理员改过另一个角色的授权。
  await sets.delete('warehouse');
  await sets.delete('finance');
  const changedGrants = [
    {
      resource: { type: 'page', id: 'quality' },
      actions: [{ action: 'access' }],
    },
  ];
  await sets.update('sales', { key: 'sales', grants: changedGrants });

  expect((await rowsFor()).map((row) => String(row.key)).sort()).toEqual(
    roleKeys.filter((key) => key !== 'warehouse' && key !== 'finance').sort(),
  );

  // 种子 run 拿到的就是这个 query；只建缺的，不碰已经存在的。
  expect((await ensureBusinessPermissionSets(connection.query)).sort()).toEqual(
    ['finance', 'warehouse'],
  );

  const stored = new Map((await sets.list()).map((set) => [set.key, set]));
  for (const key of ['warehouse', 'finance'] as const) {
    expect(stored.get(key)?.title, `${key} 的名称`).toEqual(
      expectedRoles[key].title,
    );
    expect(stored.get(key)?.grants, `${key} 的授权`).toEqual(
      expectedRoles[key].grants,
    );
  }
  expect(stored.get('sales')?.grants, '管理员改过的 sales 不被覆盖').toEqual(
    changedGrants,
  );

  // 第二次执行全部跳过：管理员改过的 sales 与刚补出的两个都不动。
  expect(await ensureBusinessPermissionSets(connection.query)).toEqual([]);
  const after = new Map((await sets.list()).map((set) => [set.key, set]));
  expect(after.get('sales')?.grants).toEqual(changedGrants);
  expect(after.get('warehouse')?.grants).toEqual(expectedRoles.warehouse.grants);
  expect(after.get('finance')?.grants).toEqual(expectedRoles.finance.grants);
});


test('R-020 波 1: the new seed declares only the warehouse and finance stocktaking grants', () => {
  expect(stocktakingTransferSeed.name).toBe('202611280010_seed_stocktaking_transfer_grants');
  expect(stocktakingTransferPermissionSets.map((set) => set.key)).toEqual(['warehouse', 'finance']);
  expect(stocktakingTransferPermissionSets[0]?.grants).toEqual(warehouseStocktakingGrants);
  expect(stocktakingTransferPermissionSets[1]?.grants).toEqual(expectedStocktakingGrantsByRole.finance);
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到盘点或调拨授权`).not.toMatch(
        /^(stocktakings|transfers)$/u,
      );
    }
  }
});

test('R-020 波 1: fresh database gets the stocktaking grants; a changed role is never overwritten', async ({
  app, connection,
}) => {
  const sets = app.container.resolve(authorizationToken).permissionSets;
  // 同文件前面的用例删掉并重建过 warehouse/finance，所以这里先跑一次 apply 补出授权。
  await persistStocktakingTransferGrants(connection.query);
  for (const [key, expected] of Object.entries(expectedStocktakingGrantsByRole)) {
    const stored = (await sets.get(key))?.grants ?? [];
    for (const grant of expected) expect(stored, `${key} 缺少盘点/调拨授权`).toContainEqual(grant);
  }
  expect(await persistStocktakingTransferGrants(connection.query)).toEqual({
    created: [], granted: [], skipped: ['warehouse', 'finance'],
  });

  const changedGrants = [
    { resource: { type: 'page', id: 'quality' }, actions: [{ action: 'access' }] },
  ];
  await sets.update('finance', { key: 'finance', grants: changedGrants });
  expect(await persistStocktakingTransferGrants(connection.query)).toEqual({
    created: [], granted: [], skipped: ['warehouse', 'finance'],
  });
  expect((await sets.get('finance'))?.grants, '管理员改过的财务角色不被覆盖').toEqual(changedGrants);
});

/** R-020 波 2：页面授权只由新种子声明，仓管两页、财务一页；重跑不写，两页都在就跳过。 */
test('R-020 波 2: the page-grant seed gives warehouse both pages and finance only stocktaking', async ({
  app,
  connection,
}) => {
  expect(stocktakingTransferPageSeed.name).toBe(
    '202611280013_seed_stocktaking_transfer_page_grants',
  );
  expect(stocktakingPageGrant).toEqual({
    resource: { type: 'page', id: 'stocktakings' },
    actions: [{ action: 'access' }],
  });
  expect(transferPageGrant).toEqual({
    resource: { type: 'page', id: 'transfers' },
    actions: [{ action: 'access' }],
  });
  expect(stocktakingTransferPagePermissionSets.map((set) => set.key)).toEqual([
    'warehouse',
    'finance',
  ]);
  expect(stocktakingTransferPagePermissionSets[0]?.grants).toEqual(
    expectedStocktakingPageGrants.warehouse,
  );
  expect(stocktakingTransferPagePermissionSets[1]?.grants).toEqual(
    expectedStocktakingPageGrants.finance,
  );
  for (const set of businessPermissionSets) {
    for (const grant of set.grants) {
      expect(grant.resource.id, `${set.key} 不该在原种子拿到盘点/调拨页面授权`).not.toMatch(
        /^(stocktakings|transfers)$/u,
      );
    }
  }

  const sets = app.container.resolve(authorizationToken).permissionSets;
  // 同文件前面的用例删掉并重建过这两个角色、还改过 finance；先恢复一份确定的授权，
  // 再让种子补出页面授权（带着别的授权也能补的情形在下面的假查询用例里覆盖）。
  await sets.update('finance', {
    key: 'finance',
    grants: [
      ...expectedRoles.finance.grants,
      ...expectedFinancePageGrants,
      ...expectedStocktakingGrantsByRole.finance,
    ],
  });
  await persistStocktakingTransferPageGrants(connection.query);
  const warehouseGrants = (await sets.get('warehouse'))?.grants ?? [];
  expect(warehouseGrants).toContainEqual(stocktakingPageGrant);
  expect(warehouseGrants).toContainEqual(transferPageGrant);
  const financeGrants = (await sets.get('finance'))?.grants ?? [];
  expect(financeGrants).toContainEqual(stocktakingPageGrant);
  expect(financeGrants).not.toContainEqual(transferPageGrant);
  expect(await persistStocktakingTransferPageGrants(connection.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });

  // 幂等只看两条页面授权在不在：带着别的授权也跳过，原样保留、不重排。
  const changedGrants = [
    { resource: { type: 'page', id: 'quality' }, actions: [{ action: 'access' }] },
    ...expectedStocktakingPageGrants.warehouse,
  ];
  await sets.update('warehouse', { key: 'warehouse', grants: changedGrants });
  expect(await persistStocktakingTransferPageGrants(connection.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });
  expect((await sets.get('warehouse'))?.grants, '带着别的授权也不覆盖、不重排').toEqual(
    changedGrants,
  );
});

/**
 * R-020 波 2（幂等口径改为按本条授权）：013 排在 011（请款报销业务动作）之后，
 * 幂等只看本条页面授权在不在 —— finance/warehouse 带着别的授权也照常补；
 * 在就跳过，不在就加；不建新角色、不补指派、不重排已有授权、重跑不写。
 */
test('R-020 波 2: 013 grants pages beside other grants and re-runs write nothing', async () => {
  const makeQuery = (stored: Readonly<Record<string, readonly PermissionGrant[]>>) => {
    const rows = new Map(
      Object.entries(stored).map(([key, grants]) => [key, JSON.stringify(grants)]),
    );
    const writes: { key: string; grants: PermissionGrant[]; updatedAt: unknown }[] = [];
    const query = {
      selectFrom: () => ({
        select: () => ({
          where: (...args: unknown[]) => ({
            executeTakeFirst: async () => {
              const key = args[args.length - 1] as string;
              const grants = rows.get(key);
              return grants === undefined ? undefined : { key, grants };
            },
          }),
        }),
      }),
      updateTable: () => ({
        set: (value: { grants: string; updatedAt: unknown }) => ({
          where: (...args: unknown[]) => ({
            execute: async () => {
              const key = args[args.length - 1] as string;
              writes.push({
                key,
                grants: JSON.parse(value.grants) as PermissionGrant[],
                updatedAt: value.updatedAt,
              });
              rows.set(key, value.grants);
            },
          }),
        }),
      }),
    } as unknown as QueryAdapter;
    return {
      query,
      writes,
      current: (key: string) => JSON.parse(rows.get(key) ?? '[]') as PermissionGrant[],
    };
  };

  // 模拟 011 先跑给 finance 加的业务动作：形状相同，但不属于 013 的已知授权。
  const expenseClaimGrant: PermissionGrant = {
    resource: { type: 'collection', id: 'expenseClaims' },
    actions: [{ action: 'create' }],
  };
  const financeStored = [...expectedFinancePageGrants, expenseClaimGrant];
  const financeState = makeQuery({ finance: financeStored });
  expect(await persistStocktakingTransferPageGrants(financeState.query)).toEqual({
    granted: ['finance'],
    skipped: ['warehouse'],
  });
  expect(financeState.current('finance')).toEqual([
    ...financeStored,
    stocktakingPageGrant,
  ]);
  expect(financeState.writes, '只写缺的那一条').toHaveLength(1);
  expect(financeState.writes[0]?.updatedAt).toBeInstanceOf(Date);
  expect(await persistStocktakingTransferPageGrants(financeState.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });
  expect(financeState.writes, '重跑不写（revision 不动）').toHaveLength(1);

  // 仓管已带打印与盘点/调拨业务动作，两页照常补齐，已有授权不重排。
  const warehouseStored = [
    ...warehouseDocPrintGrants,
    ...warehouseStocktakingGrants,
    expenseClaimGrant,
  ];
  const warehouseState = makeQuery({ warehouse: warehouseStored });
  expect(await persistStocktakingTransferPageGrants(warehouseState.query)).toEqual({
    granted: ['warehouse'],
    skipped: ['finance'],
  });
  expect(warehouseState.current('warehouse')).toEqual([
    ...warehouseStored,
    stocktakingPageGrant,
    transferPageGrant,
  ]);
  expect(warehouseState.writes).toHaveLength(1);
  expect(await persistStocktakingTransferPageGrants(warehouseState.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });
  expect(warehouseState.writes, '重跑不写').toHaveLength(1);

  // 两页都在时整条跳过；角色不存在时也跳过、不建新角色。
  const complete = makeQuery({
    warehouse: [...warehouseStored, ...expectedStocktakingPageGrants.warehouse],
    finance: [...financeStored, stocktakingPageGrant],
  });
  expect(await persistStocktakingTransferPageGrants(complete.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });
  expect(complete.writes).toHaveLength(0);
  const missing = makeQuery({});
  expect(await persistStocktakingTransferPageGrants(missing.query)).toEqual({
    granted: [],
    skipped: ['warehouse', 'finance'],
  });
  expect(missing.writes, '不建新角色').toHaveLength(0);
});
