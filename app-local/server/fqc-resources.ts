import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  recordAccess,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-013 FQC 的业务资源声明，按 R-002、R-026 与 R-003 第一个切片改过。
 *
 * 五张表以迁移 202611220001_create_fqc_demo.ts、202611260001_fqc_drafting_reviews.ts、
 * 202611260002_fqc_feedback.ts 与 202611260003_fqc_ticket_dispatch.ts 为准。读的权限
 * 一律逐列列出；写权限另外声明，不在一份带读的声明上叠加（同一个数据范围的键会撞车）：
 *
 * - `view`   消息表去掉发件人姓名与联系方式两列、初筛表原来的十九列（不含 `ownerId`）、
 *            工单表全列去掉停写的 `ownerDepartment` 与 `dueAt`、确认记录按范围、
 *            派单规则只读类别与责任部门；不写
 * - `handle` 五张表都读；初筛表只改三列；工单建行与改判时改类别、严重度；确认记录建行。
 *            读不是可选的：响应里的 `review` 要读刚写的那一行，派单还要读最近一次确认记录
 * - `intake` 两张表各建一行（消息表十六列），另给初筛表逐列的修改权，不读。
 *            工单表的建已收掉：投递不建单，已有的投递权限集要由 upgrade-r003
 *            把 `fqcTickets` 从 scopes 里删掉，否则整条授权会被跳过、投递被拒
 * - `ticket` 处理工单：工单表全列读；改经办人、处理说明、重开次数、责任部门、关闭时间
 *            与 lifecycle 的三列（不写状态列，流转走 lifecycle）
 * - `configure` 维护派单规则：派单规则表读两列、建四列、改三列
 * - `submit` 提交反馈：读消息表十九列、建十七列；初筛表建十五列、改十五列、不读
 * - `maintain` 维护反馈单：消息表全列读、只改十一列；初筛八个字段、工单五个字段
 *
 * 只建不读的权限不能写在带读的声明上：`read('*')` 之后再 `.create('*')` 得到的是读加建。
 * 所以投递的三张表各起一份只含建（初筛表另加逐列修改）的声明。初筛表在 `handle` 里
 * 既读又改，必须是同一份声明。
 *
 * 原文七列（`channel`、`externalId`、`senderName`、`senderContact`、`content`、
 * `rawContentType`、`receivedAt`）可以建、不能改。「查看」对消息表连发件人两列都不读，
 * 收窄靠声明而不是端点记得裁，新加的端点也不会漏。
 *
 * 确认记录表只登记读与建：这张表只追加。派单规则表登记读写、不登记删除。
 *
 * 这里只是纯声明，不注册、不查库、不赋权。注册在 providers/authorization-resources.ts，
 * 初始角色在 database/main/seeds/。动作的数据范围键用集合名，seed 里
 * `{ fqcMessages: 'recordsIOwn', … }` 的键就是它。
 */
const NAMESPACE = 'app-local';

/**
 * 人工确认会改的列（R-002）：只改结论、确认记录指针与更新时间。
 *
 * 草稿的五列（类别、严重度、建议责任方、摘要、置信度）在确认之后谁也不能再改：
 * 「AI 当初怎么判的」正是知识库从历史工单累积与效果对照要的东西。
 */
const SCREENING_UPDATE_FIELDS = ['outcome', 'reviewId', 'updatedAt'] as const;

/**
 * 投递与「提交反馈」能改初筛表的十五列（R-002）：模型版草稿值、已有的依据与模型名、
 * 六个出处列、按模型版置信度重算的结论与更新时间。
 *
 * 不含 `reviewId`、`messageId`、主键与创建时间；`reviewId` 归「处理」。
 * 也不含 `ownerId`：提交人改不到自己的提交人标识。
 */
const INTAKE_SCREENING_UPDATE_FIELDS = [
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'engine',
  'promptVersion',
  'degraded',
  'degradeReason',
  'knowledgeRefs',
  'redacted',
  'outcome',
  'updatedAt',
] as const;

/**
 * 「查看」读消息表的九列：迁移 202611220001 的十一列去掉发件人姓名与联系方式。
 * 这两列只给持「处理」的人；带「查看」范围的查询从 SQL 的 select 里就没有它们。
 */
const VIEW_MESSAGE_READ_FIELDS = [
  'id',
  'channel',
  'externalId',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/** 「提交反馈」读消息表的十九列：全部二十一列去掉 `note` 与 `discardedBy`。 */
const SUBMIT_MESSAGE_READ_FIELDS = [
  'id',
  'channel',
  'externalId',
  'senderName',
  'senderContact',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'ownerId',
  'discardedAt',
  'discardReason',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 「提交反馈」建消息表的十七列：全部二十一列去掉 `note` 与丢弃的三列；
 * 其中 `ownerId` 由服务端写。`content` 等原文列在建列里 —— 提交本来就要写原文。
 */
const SUBMIT_MESSAGE_CREATE_FIELDS = [
  'id',
  'channel',
  'externalId',
  'senderName',
  'senderContact',
  'content',
  'rawContentType',
  'receivedAt',
  'status',
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'ownerId',
  'createdAt',
  'updatedAt',
] as const;

/** 「投递」建消息表的十六列：提交反馈的十七列再去掉 `ownerId`（机器入口没有提交人）。 */
const INTAKE_MESSAGE_CREATE_FIELDS = SUBMIT_MESSAGE_CREATE_FIELDS.filter(
  (field) => field !== 'ownerId',
);

/** 「维护反馈单」改消息表的十一列：表单字段、附件、备注、状态与丢弃的三列。 */
const MAINTAIN_MESSAGE_UPDATE_FIELDS = [
  'customerName',
  'productName',
  'model',
  'batchNo',
  'attachmentIds',
  'note',
  'status',
  'discardedAt',
  'discardedBy',
  'discardReason',
  'updatedAt',
] as const;

/**
 * 「提交反馈」建初筛表的十五列：录入函数建这一行时真会写的列。
 *
 * 不在清单里的五列：`reviewId`、`promptVersion` 录入时必须是空；`engine`、`degraded`、
 * `redacted` 靠列上的默认值。给了写权就等于能造一份「已经确认过」或「模型出的、
 * 没回落、没脱敏」的草稿。
 */
const SUBMIT_SCREENING_CREATE_FIELDS = [
  'id',
  'messageId',
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'outcome',
  'degradeReason',
  'knowledgeRefs',
  'ownerId',
  'createdAt',
  'updatedAt',
] as const;

/**
 * 「查看」读初筛表的十九列：迁移 202611220001 的十二列加第一个切片的七列。
 * 本条新加的 `ownerId` 不放进去 —— 部门主管也持「查看」，经这个动作读不到提交人标识。
 */
const VIEW_SCREENING_READ_FIELDS = [
  'id',
  'messageId',
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'evidence',
  'modelName',
  'outcome',
  'createdAt',
  'updatedAt',
  'engine',
  'promptVersion',
  'degraded',
  'degradeReason',
  'knowledgeRefs',
  'redacted',
  'reviewId',
] as const;

/** 「维护反馈单」读初筛表的八个字段：初判与结论，不要依据与出处。 */
const MAINTAIN_SCREENING_READ_FIELDS = [
  'id',
  'messageId',
  'category',
  'severity',
  'suggestedOwner',
  'summary',
  'confidence',
  'outcome',
] as const;

/** 「维护反馈单」读工单表的五个字段：够显示工单号与状态，不读工单正文。 */
const MAINTAIN_TICKET_READ_FIELDS = [
  'id',
  'code',
  'state',
  'screeningId',
  'sourceMessageId',
] as const;

/**
 * 「查看」读工单表的二十列：全列去掉两个停写列（`ownerDepartment`、`dueAt`）。
 *
 * R-003 第一片的七列（`departmentId`、`createdBy`、`resolution`、`reopenCount`、
 * `statusChangedAt`、`lifecycleVersion`、`lifecycleDefinition`）经「查看」放开；
 * 停写两列留在表里、谁也不写不读。逐列列出，不写 `read('*')`。
 */
const VIEW_TICKET_READ_FIELDS = [
  'id',
  'code',
  'title',
  'description',
  'sourceMessageId',
  'screeningId',
  'category',
  'severity',
  'assigneeId',
  'state',
  'closedAt',
  'createdAt',
  'updatedAt',
  'departmentId',
  'createdBy',
  'resolution',
  'reopenCount',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
] as const;

/** 「处理」建工单会写的列：数据模型的全部列去掉停写两列。 */
const HANDLE_TICKET_CREATE_FIELDS = [
  'id',
  'code',
  'title',
  'description',
  'sourceMessageId',
  'screeningId',
  'category',
  'severity',
  'departmentId',
  'createdBy',
  'assigneeId',
  'state',
  'closedAt',
  'createdAt',
  'updatedAt',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
] as const;

/** 改判只改工单的类别与严重度；流转历史与其余列不动。 */
const HANDLE_TICKET_UPDATE_FIELDS = ['category', 'severity'] as const;

/** 「处理工单」能改的列：状态不走这里，由 lifecycle 写。 */
const TICKET_UPDATE_FIELDS = [
  'assigneeId',
  'resolution',
  'reopenCount',
  'departmentId',
  'closedAt',
  'statusChangedAt',
  'lifecycleVersion',
  'lifecycleDefinition',
] as const;

/** 派单规则：页面要显示的是七行的类别与责任部门，其余两列是审计用。 */
const ROUTING_READ_FIELDS = ['category', 'departmentId'] as const;
const ROUTING_CREATE_FIELDS = [
  'category',
  'departmentId',
  'updatedAt',
  'updatedBy',
] as const;
const ROUTING_UPDATE_FIELDS = [
  'departmentId',
  'updatedAt',
  'updatedBy',
] as const;

/** 「查看」：消息表只读九列，发件人两列不放进来。 */
const viewedMessages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .read(VIEW_MESSAGE_READ_FIELDS),
);

/** 「查看」：初筛表只读本条之前的十九列，不含 `ownerId`。 */
const viewedScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read(VIEW_SCREENING_READ_FIELDS),
);

/** 「查看」：工单表二十列，停写两列不读。 */
const viewedTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read(VIEW_TICKET_READ_FIELDS),
);

/** 「处理」：工单表全列读；派单建行、改判只改类别与严重度。 */
const tickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read('*')
    .create(HANDLE_TICKET_CREATE_FIELDS)
    .update(HANDLE_TICKET_UPDATE_FIELDS),
);

/** 「查看」与「处理」对派单规则都只读类别与责任部门。 */
const viewedRoutingRules = defineDatabasePermission((permission) =>
  permission
    .collection('fqcRoutingRules')
    .title({ key: 'authorization.fqc.routingRules', ns: NAMESPACE })
    .read(ROUTING_READ_FIELDS),
);

/** 「处理工单」：工单表全列读，改的列逐项列出（状态列不在这里）。 */
const handledTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read('*')
    .update(TICKET_UPDATE_FIELDS),
);

/** 「维护派单规则」：整体替换七行 —— 建四列，改三列，读两列。 */
const configuredRoutingRules = defineDatabasePermission((permission) =>
  permission
    .collection('fqcRoutingRules')
    .title({ key: 'authorization.fqc.routingRules', ns: NAMESPACE })
    .read(ROUTING_READ_FIELDS)
    .create(ROUTING_CREATE_FIELDS)
    .update(ROUTING_UPDATE_FIELDS),
);

/** 「处理」对消息表的全列读。 */
const messages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .read('*'),
);

/**
 * 确认记录表复用初筛表的标题词条：这张表不进角色编辑器（没有 placement），
 * 只出现在两个业务动作展开的数据范围里；新增一个词条要改客户端文案，那属于
 * 第二个切片。
 */
// 确认记录表的范围**没有缺省**：没配就是拒绝。它是「人的判断」，比客户消息还窄：
// 部门主管只该看到被派给他的工单，不该读到质量人员确认成什么（R-003 的收窄）。
// 已经初始化的环境由 `pnpm nocobase authz upgrade-r002` 只给两个质量角色补上
// 全量范围；漏跑这一步的旧角色确认会 403，这是预期，不是兜底给全量的理由。
const reviews = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreeningReviews')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read('*'),
);

/** 处理：初筛表读到的仍是全字段，能改的只有三列；确认记录能建。 */
const reviewedScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read('*')
    .update(SCREENING_UPDATE_FIELDS),
);

/** 处理：确认记录既读又建，必须是同一份声明（否则同一个数据范围的键会撞车）。 */
const handledReviews = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreeningReviews')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read('*')
    .create('*'),
);

/** 投递：只建不读；消息表收成十六列（不含提交人、备注与丢弃各列）。 */
const createdMessages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .create(INTAKE_MESSAGE_CREATE_FIELDS),
);

/** 投递：初筛表建仍是 R-002 的全列，另给逐列的修改权（模型版换掉规则版草稿）。 */
const createdScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .create('*')
    .update(INTAKE_SCREENING_UPDATE_FIELDS),
);

/**
 * 提交反馈：消息表读十九列、建十七列；范围只有「仅本人」，默认也是它。
 * 范围比的是 `ownerId`（内置的 `recordsIOwn`），人工入口由服务端写成提交人。
 */
const submittedMessages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .read(SUBMIT_MESSAGE_READ_FIELDS)
    .create(SUBMIT_MESSAGE_CREATE_FIELDS)
    .options(recordAccess.recordsIOwn)
    .default(recordAccess.recordsIOwn),
);

/**
 * 提交反馈：初筛表建十五列、改十五列（与投递逐项相同），不读。
 *
 * 不读是设计定死的：模型升级只改不读，用带谓词的更新；带读就等于让普通员工读到
 * 全公司的初筛。范围同样只有「仅本人」，本人那一份草稿才改得到。
 */
const submittedScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .create(SUBMIT_SCREENING_CREATE_FIELDS)
    .update(INTAKE_SCREENING_UPDATE_FIELDS)
    .options(recordAccess.recordsIOwn)
    .default(recordAccess.recordsIOwn),
);

/** 维护反馈单：消息表全列读、只改十一列；范围只有「全部」。 */
const maintainedMessages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .read('*')
    .update(MAINTAIN_MESSAGE_UPDATE_FIELDS)
    .options(recordAccess.allRecords)
    .default(recordAccess.allRecords),
);

/** 维护反馈单：初筛表读八个字段；范围只有「全部」。 */
const maintainedScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read(MAINTAIN_SCREENING_READ_FIELDS)
    .options(recordAccess.allRecords)
    .default(recordAccess.allRecords),
);

/** 维护反馈单：工单表读五个字段；范围只有「全部」。 */
const maintainedTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read(MAINTAIN_TICKET_READ_FIELDS)
    .options(recordAccess.allRecords)
    .default(recordAccess.allRecords),
);

/**
 * 四张表的裸读写登记。
 *
 * 动作清单必须写明：不写的话框架默认把删除也登记上，管理员就能经接口给角色写一条
 * 「可以删质量工单」。四张表不进角色编辑器（没有 placement），只供 `fqc` 的业务动作展开。
 * 确认记录表只登记读与建：只追加。
 */
export const FQC_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  {
    name: 'fqcMessages',
    title: { key: 'authorization.fqc.messages', ns: NAMESPACE },
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'fqcScreenings',
    title: { key: 'authorization.fqc.screenings', ns: NAMESPACE },
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'fqcTickets',
    title: { key: 'authorization.fqc.tickets', ns: NAMESPACE },
    actions: ['read', 'create', 'update'],
  },
  {
    name: 'fqcScreeningReviews',
    title: { key: 'authorization.fqc.screenings', ns: NAMESPACE },
    actions: ['read', 'create'],
  },
  {
    name: 'fqcRoutingRules',
    title: { key: 'authorization.fqc.routingRules', ns: NAMESPACE },
    actions: ['read', 'create', 'update'],
  },
];

export const fqc = defineCompositeResource('fqc', (resource) =>
  resource
    .title({ key: 'authorization.fqc.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.view', ns: NAMESPACE })
        .grant('fqcMessages', viewedMessages)
        .grant('fqcScreenings', viewedScreenings)
        .grant('fqcTickets', viewedTickets)
        .grant('fqcScreeningReviews', reviews)
        .grant('fqcRoutingRules', viewedRoutingRules),
    )
    .action('handle', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.handle', ns: NAMESPACE })
        .grant('fqcMessages', messages)
        .grant('fqcScreenings', reviewedScreenings)
        .grant('fqcTickets', tickets)
        .grant('fqcScreeningReviews', handledReviews)
        .grant('fqcRoutingRules', viewedRoutingRules),
    )
    .action('intake', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.intake', ns: NAMESPACE })
        .grant('fqcMessages', createdMessages)
        .grant('fqcScreenings', createdScreenings),
    )
    .action('ticket', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.ticket', ns: NAMESPACE })
        .grant('fqcTickets', handledTickets),
    )
    .action('configure', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.configure', ns: NAMESPACE })
        .grant('fqcRoutingRules', configuredRoutingRules),
    )
    .action('submit', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.submit', ns: NAMESPACE })
        .grant('fqcMessages', submittedMessages)
        .grant('fqcScreenings', submittedScreenings),
    )
    .action('maintain', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.maintain', ns: NAMESPACE })
        .grant('fqcMessages', maintainedMessages)
        .grant('fqcScreenings', maintainedScreenings)
        .grant('fqcTickets', maintainedTickets),
    ),
);
