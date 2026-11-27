import { defineRecordAccess } from '@nocobase/authorization/core';
import { condition } from '@nocobase/app-plugin-authorization/server';

/**
 * R-021 波 1 加片：`staff` 的请购单只限本人建的单。
 *
 * 范围键只盖 `purchaseRequests` 一张表，比较的是建单人 `createdById`；明细通过所属
 * 单据头读，不单独给范围。只有「仅本人」一把，管理员也选不出「全部」。
 */
export const PURCHASE_REQUEST_CREATOR_OWN = 'purchaseRequest.creatorOwn';

const creatorOwn = defineRecordAccess(PURCHASE_REQUEST_CREATOR_OWN, (access) =>
  access
    .title({
      key: 'authorization.recordAccess.purchaseRequestCreator',
      ns: 'app-local',
    })
    .collections('purchaseRequests')
    .resolver(({ principal, collection }) =>
      collection === 'purchaseRequests' && principal.type === 'user'
        ? condition('createdById', '$eq', principal.id)
        : false,
    ),
).build();

export const PURCHASE_REQUEST_RECORD_ACCESS = [creatorOwn] as const;

/** 作用域引用：给资源声明与测试用，形状与审批的两把范围键一致。 */
export const PURCHASE_REQUEST_SCOPE_REFERENCES = {
  purchaseRequests: {
    key: PURCHASE_REQUEST_CREATOR_OWN,
    collections: ['purchaseRequests'],
  },
} as const;
