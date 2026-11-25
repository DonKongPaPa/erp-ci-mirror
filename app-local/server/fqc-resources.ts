import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-013 FQC 的业务资源声明。
 *
 * 三张表以迁移 202611220001_create_fqc_demo.ts 为准。读的权限只有三份声明（三张表各一份，
 * 字段全开），业务动作按设计各取所需；写权限另外声明，不在一份带读的声明上叠加：
 *
 * - `view`   读消息、初筛、工单
 * - `handle` 读三张表；只改初筛表的五列（类别、严重度、建议归属、结论、更新时间）
 * - `intake` 三张表各建一行，不读 —— 投递一次只写一行，带读就能读走客户联系方式与消息原文
 *
 * 只建不读的权限不能写在带读的声明上：`read('*')` 之后再 `.create('*')` 得到的是读加建。
 * 所以投递的三张表各起一份只含建的声明。初筛表在 `handle` 里既读又改，必须是同一份声明：
 * 拆成读一份、改一份会在数据范围的键上撞车。
 *
 * 这里只是纯声明，不注册、不查库、不赋权。注册在 providers/authorization-resources.ts，
 * 初始角色在 database/main/seeds/。动作的数据范围键用集合名，seed 里
 * `{ fqcMessages: 'allRecords', … }` 的键就是它。
 */
const NAMESPACE = 'app-local';

/** 人工复核会改的列。主键、创建时间、两个溯源指针、消息原文都不给改。 */
const SCREENING_UPDATE_FIELDS = [
  'category',
  'severity',
  'suggestedOwner',
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

/** 处理：初筛表读到的仍是全字段，能改的只有复核那五列。 */
const reviewedScreenings = defineDatabasePermission((permission) =>
  permission
    .collection('fqcScreenings')
    .title({ key: 'authorization.fqc.screenings', ns: NAMESPACE })
    .read('*')
    .update(SCREENING_UPDATE_FIELDS),
);

/** 投递：只建不读。 */
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
    .create('*'),
);

const createdTickets = defineDatabasePermission((permission) =>
  permission
    .collection('fqcTickets')
    .title({ key: 'authorization.fqc.tickets', ns: NAMESPACE })
    .create('*'),
);

/**
 * 三张表的裸读写登记。
 *
 * 动作清单必须写明：不写的话框架默认把删除也登记上，管理员就能经接口给角色写一条
 * 「可以删质量工单」。三张表不进角色编辑器（没有 placement），只供 `fqc` 的三个业务动作展开。
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
];

export const fqc = defineCompositeResource('fqc', (resource) =>
  resource
    .title({ key: 'authorization.fqc.title', ns: NAMESPACE })
    .action('view', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.view', ns: NAMESPACE })
        .grant('fqcMessages', messages)
        .grant('fqcScreenings', screenings)
        .grant('fqcTickets', tickets),
    )
    .action('handle', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.handle', ns: NAMESPACE })
        .grant('fqcMessages', messages)
        .grant('fqcScreenings', reviewedScreenings)
        .grant('fqcTickets', tickets),
    )
    .action('intake', (action) =>
      action
        .title({ key: 'authorization.fqc.actions.intake', ns: NAMESPACE })
        .grant('fqcMessages', createdMessages)
        .grant('fqcScreenings', createdScreenings)
        .grant('fqcTickets', createdTickets),
    ),
);
