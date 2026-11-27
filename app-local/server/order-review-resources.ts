import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

/**
 * R-064 的业务资源声明（只声明，不查库、不赋权）。评审是一张新表加五项明细，
 * 动作清单写全，不登记删除 —— 停用与替代都走 `void`。销售订单的 `ledgerView`
 * 动作加在 orders-resources.ts 的销售资源上（只读窄列，不连价格）。
 * 注册在 providers/authorization-resources.ts；默认授权由 seed 与 upgrade-r064 写。
 * 本片没有页面，所以不做 ui.place。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const reviewTitle = title('authorization.orderReviews.tables.reviews');
const lineTitle = title('authorization.orderReviews.tables.lines');

/** createdById 是审计列，任何读授权都不包含它。 */
const REVIEW_READ = [
  'id', 'salesOrderId', 'status', 'reviewerUserId', 'reviewedAt',
  'confirmedDeliveryDate', 'confirmedAt', 'createdAt', 'updatedAt',
] as const;
const LINE_READ = ['id', 'reviewId', 'factor', 'conclusion', 'note'] as const;
const REVIEW_CREATE = [
  'salesOrderId', 'status', 'reviewerUserId', 'confirmedDeliveryDate',
  'confirmedAt', 'createdById', 'createdAt', 'updatedAt',
] as const;
const REVIEW_UPDATE = [
  'status', 'reviewerUserId', 'confirmedDeliveryDate', 'confirmedAt', 'updatedAt',
] as const;
const LINE_CREATE = ['reviewId', 'factor', 'conclusion', 'note'] as const;

export const ORDER_REVIEW_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'orderReviews', title: reviewTitle, actions: ['read', 'create', 'update'] },
  { name: 'orderReviewLines', title: lineTitle, actions: ['read', 'create', 'update', 'delete'] },
];

const readReviews = defineDatabasePermission((permission) =>
  permission.collection('orderReviews').title(reviewTitle).read(REVIEW_READ),
);
const readLines = defineDatabasePermission((permission) =>
  permission.collection('orderReviewLines').title(lineTitle).read(LINE_READ),
);
const createReviews = defineDatabasePermission((permission) =>
  permission
    .collection('orderReviews')
    .title(reviewTitle)
    .read(REVIEW_READ)
    .create(REVIEW_CREATE),
);
const createLines = defineDatabasePermission((permission) =>
  permission
    .collection('orderReviewLines')
    .title(lineTitle)
    .read(LINE_READ)
    .create(LINE_CREATE)
    .delete(),
);
const updateReviews = defineDatabasePermission((permission) =>
  permission
    .collection('orderReviews')
    .title(reviewTitle)
    .read(REVIEW_READ)
    .update(REVIEW_UPDATE),
);
const updateLines = defineDatabasePermission((permission) =>
  permission
    .collection('orderReviewLines')
    .title(lineTitle)
    .read(LINE_READ)
    .update(['conclusion', 'note'])
    .delete(),
);

export const orderReviews = defineCompositeResource('orderReviews', (resource) =>
  resource
    .title(title('authorization.orderReviews.title'))
    .action('view', (action) =>
      action
        .title(title('authorization.orderReviews.actions.view'))
        .grant('orderReviews', readReviews)
        .grant('orderReviewLines', readLines),
    )
    .action('create', (action) =>
      action
        .title(title('authorization.orderReviews.actions.create'))
        .grant('orderReviews', createReviews)
        .grant('orderReviewLines', createLines),
    )
    .action('update', (action) =>
      action
        .title(title('authorization.orderReviews.actions.update'))
        .grant('orderReviews', updateReviews)
        .grant('orderReviewLines', updateLines),
    )
    .action('submit', (action) =>
      action
        .title(title('authorization.orderReviews.actions.submit'))
        .grant('orderReviews', updateReviews)
        .grant('orderReviewLines', readLines),
    )
    .action('confirm', (action) =>
      action
        .title(title('authorization.orderReviews.actions.confirm'))
        .grant('orderReviews', updateReviews)
        .grant('orderReviewLines', readLines),
    )
    .action('void', (action) =>
      action
        .title(title('authorization.orderReviews.actions.void'))
        .grant('orderReviews', updateReviews)
        .grant('orderReviewLines', readLines),
    ),
);
