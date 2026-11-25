import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-013 FQC 的业务资源声明，按 R-002 第一个切片改过一遍。
 *
 * 四张表以迁移 202611220001_create_fqc_demo.ts 与 202611260001_fqc_drafting_reviews.ts 为准。
 * 读的权限只有四份声明（四张表各一份，字段全开），业务动作按设计各取所需；写权限
 * 另外声明，不在一份带读的声明上叠加：
 *
 * - `view`   读消息、初筛、工单、确认记录
 * - `handle` 读四张表；只改初筛表的三列（结论、确认记录指针、更新时间）；在确认记录
 *            表上建一行 —— 读不是可选的：响应里的 `review` 要读刚写的那一行，R-003
 *            的派单与改判还要在同一个事务里读最近一次确认记录取生效值
 * - `intake` 三张业务表各建一行，另给初筛表逐列的修改权（模型版在第二笔写入里换掉
 *            规则版草稿），不读 —— 投递一次只写一行，带读就能读走客户联系方式与消息原文
 *
 * 只建不读的权限不能写在带读的声明上：`read('*')` 之后再 `.create('*')` 得到的是读加建。
 * 所以投递的三张表各起一份只含建（初筛表另加逐列修改）的声明。初筛表在 `handle` 里
 * 既读又改，必须是同一份声明：拆成读一份、改一份会在数据范围的键上撞车。
 *
 * 确认记录表只登记读与建：这张表只追加，R-003 的三个动作都只写新行。
 *
 * 这里只是纯声明，不注册、不查库、不赋权。注册在 providers/authorization-resources.ts，
 * 初始角色在 database/main/seeds/。动作的数据范围键用集合名，seed 里
 * `{ fqcMessages: 'allRecords', … }` 的键就是它。
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
 * 投递能改的十五列（R-002）：模型版草稿值、已有的依据与模型名、六个出处列、
 * 按模型版置信度重算的结论与更新时间。
 *
 * 不含 `reviewId`、`messageId`、主键与创建时间；`reviewId` 归「处理」。
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

const messages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .read('*'),
);

const screenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read('*'),
);

const tickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
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

/** 投递：只建不读；初筛表另给逐列的修改权（模型版换掉规则版草稿）。 */
const createdMessages = defineDatabasePermission((permission) =>
  permission
    .collection('fqcMessages')
    .title({ key: 'authorization.fqc.messages', ns: NAMESPACE })
    .create('*'),
);

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
 * 四张表的裸读写登记。
 *
 * 动作清单必须写明：不写的话框架默认把删除也登记上，管理员就能经接口给角色写一条
 * 「可以删质量工单」。四张表不进角色编辑器（没有 placement），只供 `fqc` 的三个业务动作展开。
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
        .grant('fqcMessages', messages)
        .grant('fqcScreenings', screenings)
        .grant('fqcTickets', tickets)
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
    ),
);
