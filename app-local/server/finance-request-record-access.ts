import { defineRecordAccess } from '@nocobase/authorization/core';
import { condition } from '@nocobase/app-plugin-authorization/server';

/**
 * R-066：staff 的请款单只限本人建的单。
 *
 * 范围键只盖 financeRequestDocs 一张表，比较的是建单人 createdById；
 * 只有「仅本人」一把，管理员也选不出「全部」。finance 没有这一把，看全部。
 */
export const FINANCE_REQUEST_CREATOR_OWN = 'financeRequest.creatorOwn';

const creatorOwn = defineRecordAccess(FINANCE_REQUEST_CREATOR_OWN, (access) =>
  access
    .title({ key: 'authorization.recordAccess.financeRequestCreator', ns: 'app-local' })
    .collections('financeRequestDocs')
    .resolver(({ principal, collection }) =>
      collection === 'financeRequestDocs' && principal.type === 'user'
        ? condition('createdById', '$eq', principal.id)
        : false,
    ),
).build();

export const FINANCE_REQUEST_RECORD_ACCESS = [creatorOwn] as const;

export const FINANCE_REQUEST_SCOPE_REFERENCES = {
  financeRequestDocs: {
    key: FINANCE_REQUEST_CREATOR_OWN,
    collections: ['financeRequestDocs'],
  },
} as const;
