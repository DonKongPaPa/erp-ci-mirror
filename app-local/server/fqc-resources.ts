import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  recordAccess,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-013 FQC 的业务资源声明，按 R-002 第一个切片与 R-026 第一个切片改过。
 *
 * 四张表以迁移 202611220001_create_fqc_demo.ts、202611260001_fqc_drafting_reviews.ts
 * 与 202611260002_fqc_feedback.ts 为准。读的权限只有四份全列声明，业务动作按设计
 * 各取所需；写权限另外声明，不在一份带读的声明上叠加：
 *
 * - `view`   读消息表原来的十一列、初筛表原来的十九列（不含本条的 `ownerId`）、
 *            工单原来的十五列、确认记录按范围。部门主管也持这个动作，本条新加的
 *            十列一列也不放进来（R-026 的暴露面）；R-003 新加的七列等第二片定契约
 * - `handle` 读四张表全列；只改初筛表的三列（结论、确认记录指针、更新时间）；在
 *            确认记录表上建一行 —— 读不是可选的：响应里的 `review` 要读刚写的那一行，
 *            R-003 的派单与改判还要在同一个事务里读最近一次确认记录取生效值
 * - `intake` 三张业务表各建一行（消息表收成十六列），另给初筛表逐列的修改权
 *            （模型版在第二笔写入里换掉规则版草稿），不读 —— 投递一次只写一行，
 *            带读就能读走客户联系方式与消息原文
 * - `submit` 提交反馈：读消息表十九列、建十七列；初筛表建十五列、改十五列、不读。
 *            两张表的范围都只有「仅本人」，默认也是它；没有发布给「全部」的档，
 *            管理员选不出会被整条跳过的组合
 * - `maintain` 维护反馈单：消息表全列读、只改十一列；初筛八个字段、工单五个字段；
 *            三张表的范围都只有「全部」
 *
 * 只建不读的权限不能写在带读的声明上：`read('*')` 之后再 `.create('*')` 得到的是读加建。
 * 所以投递的三张表各起一份只含建（初筛表另加逐列修改）的声明。初筛表在 `handle` 里
 * 既读又改，必须是同一份声明：拆成读一份、改一份会在数据范围的键上撞车。
 *
 * 原文七列（`channel`、`externalId`、`senderName`、`senderContact`、`content`、
 * `rawContentType`、`receivedAt`）可以建、不能改：两个新动作与投递的改列清单里
 * 都没有它们，「查看」与「处理」对消息表也没有改权。
 *
 * 确认记录表只登记读与建：这张表只追加，R-003 的三个动作都只写新行。
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

/** 消息表原来的十一列（迁移 202611220001）：「查看」只读这些。 */
const VIEW_MESSAGE_READ_FIELDS = [
  'id',
  'channel',
  'externalId',
  'senderName',
  'senderContact',
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
 * 「查看」读工单表的十五列：迁移 202611220001 建表时的全部列。
 *
 * R-003 第一个切片给工单加了七列（`departmentId`、`createdBy`、`resolution`、
 * `reopenCount`、`statusChangedAt`、`lifecycleVersion`、`lifecycleDefinition`）。
 * 第二个切片才会定下这几列经「查看」放开哪几列；在那之前逐列列出来，不写 `read('*')`，
 * 免得列表端点把还没定契约的列先漏出去。守门的「201 与列表字段一致」也靠这一份清单。
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
  'ownerDepartment',
  'assigneeId',
  'state',
  'dueAt',
  'closedAt',
  'createdAt',
  'updatedAt',
] as const;

/** 「查看」：消息表只读本条之前的十一列。 */
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

/** 「查看」：工单表只读原来的十五列，逐列列出；R-003 新加的七列第二片再定。 */
const viewedTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read(VIEW_TICKET_READ_FIELDS),
);

/** 「处理」：工单表仍是全列读，派单与改判要写新列，也要读回来。 */
const tickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .read('*'),
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

const createdTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .create('*'),
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
        .grant('fqcScreeningReviews', reviews),
    )
    .action('handle', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.handle', ns: NAMESPACE })
        .grant('fqcMessages', messages)
        .grant('fqcScreenings', reviewedScreenings)
        .grant('fqcTickets', tickets)
        .grant('fqcScreeningReviews', handledReviews),
    )
    .action('intake', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.intake', ns: NAMESPACE })
        .grant('fqcMessages', createdMessages)
        .grant('fqcScreenings', createdScreenings)
        .grant('fqcTickets', createdTickets),
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
