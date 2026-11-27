import {
  encodeAuthorizationTitle,
  type PermissionGrant,
} from '@nocobase/authorization/core';
import {
  definePermissionSet,
  type PermissionSet,
} from '@nocobase/authorization/permission-sets';
import { defineSeed, type QueryAdapter } from '@nocobase/db';
import { randomUUID } from 'node:crypto';

/**
 * R-013 的四个业务角色加 R-014 的销售、采购（seed）。
 *
 * 授权内容照设计文档的角色表：
 * - 质量主管、质量员：FQC 查看与处理、处理工单、质量页、知识库；R-026 再加反馈单页、
 *   「提交反馈」与「维护反馈单」；质量主管另有「维护派单规则」
 * - 部门主管：FQC 查看（只工单表的「本部门及下级」）、质量页；不给他新动作
 * - 普通员工：R-026 的反馈单页与「提交反馈」（两张表都是「仅本人」）；R-025 的班次只读
 *
 * 「查看」「处理」「维护反馈单」的数据范围填 `allRecords`（Q31）；R-026 的
 * 「提交反馈」按设计只给「仅本人」（`recordsIOwn`，比的是 `ownerId`）。两把部门
 * 范围键已经注册，部门表有数据、业务表带 `departmentId` 后会自动开始生效。
 *
 * 六个角色都不授予「用户」资源的任何动作（R-028）：读人员信息只做选择性暴露。
 *
 * 写入照框架的存储形态：`grants` 列里是再包了一层的 JSON 字符串，`title` 存
 * `{ key, ns }`，`ns` 是客户端注册的包名 `app-local`。已经存在的 key 一律跳过，
 * 管理员改过的角色不被覆盖 —— 循环里用 `continue`，跳过一颗不能停下整颗 seed。
 * 角色的定义就写在这个文件里，不另建目录：发布产物的白名单只包含 seed 目录。
 */
const NAMESPACE = 'app-local';

/** 两个质量角色持有确认记录表的全量范围：确认要读要写这张表。 */
const qualityFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
  fqcScreeningReviews: 'allRecords',
} as const;

/** 质量角色的查看、处理各自多一张派单规则表：查看只读，处理要按规则取责任部门。 */
const qualityViewScopes = { ...qualityFqcScopes, fqcRoutingRules: 'allRecords' } as const;
const qualityHandleScopes = {
  ...qualityFqcScopes,
  fqcRoutingRules: 'allRecords',
} as const;

/** R-003：处理工单只展开工单表，维护派单规则只展开派单规则表。 */
const ticketScopes = { fqcTickets: 'allRecords' } as const;
const configureScopes = { fqcRoutingRules: 'allRecords' } as const;

/**
 * R-003：部门主管的「查看」只配工单表的「本部门及下级」。消息表、初筛表、
 * 确认记录表、派单规则表都不配范围 —— 框架回 `NO_RECORD_ACCESS`（读不到），
 * 不是全部。没有 `departmentId` 的表没法按部门收窄，所以不往它们扩。
 */
const readFqcScopes = { fqcTickets: 'org.myDepartmentsAndBelow' } as const;

/**
 * R-026「提交反馈」的范围：两张表都只有「仅本人」，默认也是它。
 * 声明里也只发布这一档（`recordAccess.recordsIOwn`），选不出会被整条跳过的组合。
 */
const submitFqcScopes = {
  fqcMessages: 'recordsIOwn',
  fqcScreenings: 'recordsIOwn',
} as const;

/** R-026「维护反馈单」的范围：三张表都只有「全部」。 */
const maintainFqcScopes = {
  fqcMessages: 'allRecords',
  fqcScreenings: 'allRecords',
  fqcTickets: 'allRecords',
} as const;

/**
 * 业务动作的授权以存入库里的形状直接写出来。
 *
 * seed 拿不到应用容器，框架也没给 seed 一个能解析 `authorizationToken` 的上下文，
 * 所以这里不 import `server/fqc-resources.ts` 的声明。动作名与数据范围键写错不会
 * 悄悄生效：启动扫描会拿 `fqc` 的当前定义逐条展开存量的授权，展开不了就直接拒绝
 * 启动（开发环境），测试也断言了这份形状。
 */
function fqcGrant(
  actions: readonly string[],
  scopes: Readonly<Record<string, string>>,
): PermissionGrant {
  return {
    resource: { type: 'composite', id: 'fqc' },
    actions: actions.map((action) => ({
      action,
      policy: { type: 'composite', scopes },
    })),
  };
}

const qualityPage = {
  resource: { type: 'page', id: 'quality' },
  actions: [{ action: 'access' }],
};

/** R-026：反馈单页。页面 id 与路由的 `authz.resource.id` 由守门测试钉在一起。 */
const feedbackPage = {
  resource: { type: 'page', id: 'feedback' },
  actions: [{ action: 'access' }],
};

const knowledgePage = {
  resource: { type: 'page', id: 'knowledge' },
  actions: [{ action: 'access' }],
};

/**
 * R-025：班次定义不是人员信息，独立资源。`staff` 默认只拿 `view`（报工与排班以后要选班次），
 * 写只给 root（root 不受限，不需要在这里登记）；其余业务角色一份都不给。
 * 这张表没有记录范围键，所以授权不带 policy；页面授权也不写（管理页默认只有 root）。
 */
const shiftsView = {
  resource: { type: 'composite', id: 'shifts' },
  actions: [{ action: 'view' }],
};

/**
 * R-020：仓管拿仓库读、单据读写、过账与作废五个动作，**不拿 warehouseManage**
 * （建改仓库只给 root）；其余业务角色一份都不给。没有页面授权（本片不做页面）。
 */
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

/**
 * R-014：客户与供应商各一份业务资源，动作都是 view / create / update（没有删除）。
 * 销售只持 customers，采购只持 suppliers；数据范围初期用全部，授权不带 policy。
 * 页面授权 `partnersPage` 是前端片补的；存量环境跑 `pnpm nocobase authz upgrade-r014-page`。
 */
const PARTNER_ACTIONS = ['view', 'create', 'update'] as const;

const partnerGrant = (id: 'customers' | 'suppliers') => ({
  resource: { type: 'composite', id },
  actions: PARTNER_ACTIONS.map((action) => ({ action })),
});

/**
 * R-014 页面片（《基座ERP前端设计》1.3）：客户与供应商页，一条路由、一个页面授权 id，
 * 两个标签靠 customers.view、suppliers.view 各自显隐。销售、采购都拿页面授权；
 * 页面 id 与路由的 `authz.resource.id` 由守门测试钉在一起。
 */
const partnersPage = {
  resource: { type: 'page', id: 'partners' },
  actions: [{ action: 'access' }],
};

/**
 * R-019 页面片（《基座ERP前端设计》1.3）：物料页（物料清单、计量单位、物料分类三个标签）。
 * 读：销售、采购（它们为订单已经拿了下面的 items.view）、root；写只给 root（items.manage），
 * 不给任何业务角色，仓管也一份不给。页面 id 与路由的 `authz.resource.id` 由守门测试钉在一起。
 */
const itemsPage = {
  resource: { type: 'page', id: 'items' },
  actions: [{ action: 'access' }],
};

/**
 * R-021/R-022：订单六个动作各成一条授权；没有删除。采购另拿物料与仓库只读，
 * 销售拿同一份只读（items.view 同时展开物料分类），都不拿库存单据的读写与过账。
 */
const ORDER_ACTIONS = ['view', 'create', 'update', 'submit', 'cancel'] as const;
const purchaseOrderGrant = {
  resource: { type: 'composite', id: 'purchaseOrders' },
  actions: [...ORDER_ACTIONS, 'createReceipt'].map((action) => ({ action })),
};
const salesOrderGrant = {
  resource: { type: 'composite', id: 'salesOrders' },
  actions: [...ORDER_ACTIONS, 'createIssue'].map((action) => ({ action })),
};
const orderItemRead = {
  resource: { type: 'composite', id: 'items' },
  actions: [{ action: 'view' }],
};
const orderWarehouseRead = {
  resource: { type: 'composite', id: 'inventory' },
  actions: [{ action: 'warehouseView' }],
};

/**
 * R-002：知识库的业务键是 `{ type: 'kb', id: 'kb.knowledge' }`，动作名带档位
 * （`manage.related` / `propose.related`）。`kb.knowledge/manage` 是业务键，不是授权
 * 动作名；知识库插件登记到授权插件的才是这些档位。
 *
 * 用 `.related` 不用 `.all`：本应用只有一个质量标准空间、把它关联到所有账号，两者
 * 今天等价；`.all` 会覆盖以后新加的空间。
 */
const knowledgeGrant = (action: 'manage.related' | 'propose.related') => ({
  resource: { type: 'kb', id: 'kb.knowledge' },
  actions: [{ action }],
});

export const businessPermissionSets: readonly PermissionSet[] = [
  definePermissionSet('quality_manager')
    .title({ key: 'permissionSets.business.qualityManager', ns: NAMESPACE })
    .grant(qualityPage)
    .grant(fqcGrant(['view'], qualityViewScopes))
    .grant(fqcGrant(['handle'], qualityHandleScopes))
    // R-003：新动作各成一条授权；已有的「查看、处理」不改。
    .grant(fqcGrant(['ticket'], ticketScopes))
    .grant(fqcGrant(['configure'], configureScopes))
    // R-026：两个新动作各成一条授权，不并进上面那条「查看、处理」。
    .grant(feedbackPage)
    .grant(fqcGrant(['submit'], submitFqcScopes))
    .grant(fqcGrant(['maintain'], maintainFqcScopes))
    .grant(knowledgePage)
    .grant(knowledgeGrant('manage.related'))
    .build(),
  definePermissionSet('quality_inspector')
    .title({ key: 'permissionSets.business.qualityInspector', ns: NAMESPACE })
    .grant(qualityPage)
    // 派单规则只给质量主管「查看」；质量员在处理里读它取责任部门即可。
    .grant(fqcGrant(['view'], qualityFqcScopes))
    .grant(fqcGrant(['handle'], qualityHandleScopes))
    .grant(fqcGrant(['ticket'], ticketScopes))
    .grant(feedbackPage)
    .grant(fqcGrant(['submit'], submitFqcScopes))
    .grant(fqcGrant(['maintain'], maintainFqcScopes))
    .grant(knowledgePage)
    .grant(knowledgeGrant('propose.related'))
    .build(),
  definePermissionSet('dept_manager')
    .title({ key: 'permissionSets.business.deptManager', ns: NAMESPACE })
    .grant(qualityPage)
    .grant(fqcGrant(['view'], readFqcScopes))
    .build(),
  definePermissionSet('staff')
    .title({ key: 'permissionSets.business.staff', ns: NAMESPACE })
    .grant(feedbackPage)
    .grant(fqcGrant(['submit'], submitFqcScopes))
    // R-025：只读班次定义，没有写、没有页面授权。
    .grant(shiftsView)
    .build(),
  definePermissionSet('warehouse')
    .title({ key: 'permissionSets.business.warehouse', ns: NAMESPACE })
    .grant(inventoryGrant)
    .build(),
  definePermissionSet('sales')
    .title({ key: 'permissionSets.business.sales', ns: NAMESPACE })
    .grant(partnersPage)
    .grant(partnerGrant('customers'))
    .grant(salesOrderGrant)
    .grant(orderItemRead)
    .grant(orderWarehouseRead)
    .grant(itemsPage)
    .build(),
  definePermissionSet('purchase')
    .title({ key: 'permissionSets.business.purchase', ns: NAMESPACE })
    .grant(partnersPage)
    .grant(partnerGrant('suppliers'))
    .grant(purchaseOrderGrant)
    .grant(orderItemRead)
    .grant(orderWarehouseRead)
    .grant(itemsPage)
    .build(),
];

/**
 * 把七个角色写进权限集表，返回这一次新建的 key。
 *
 * seed 的 run 只做这一件事：开发服务器可能在文件写入后立刻执行这颗 seed，
 * 逻辑放在这里，单元测试可以直接断言它写入的形状与幂等行为。
 */
export async function persistBusinessPermissionSets(
  query: QueryAdapter,
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const set of businessPermissionSets) {
    const existing = await query
      .selectFrom('authorizationPermissionSets')
      .select('key')
      .where('key', '=', set.key)
      .executeTakeFirst();
    // 保留管理员已经改过的角色；跳过这一颗，继续建后面的。
    if (existing) {
      continue;
    }
    const now = new Date();
    await query
      .insertInto('authorizationPermissionSets')
      .values({
        id: randomUUID(),
        key: set.key,
        title: encodeAuthorizationTitle(set.title),
        grants: JSON.stringify(set.grants),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    created.push(set.key);
  }
  return created;
}

export default defineSeed({
  name: '202611240001_seed_business_permission_sets',
  async run({ query }) {
    await persistBusinessPermissionSets(query);
  },
});
