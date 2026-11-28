import { defineCompositeResource } from '@nocobase/authorization/core';
import {
  defineDatabasePermission,
  recordAccess,
  type DatabaseCollectionDefinition,
} from '@nocobase/app-plugin-authorization/server';

import { FINANCE_REQUEST_SCOPE_REFERENCES } from './finance-request-record-access.js';

/**
 * R-066：请款单与报销单的业务资源声明（只声明，不查库、不赋权）。
 *
 * 六个动作，不登记删除 —— 作废进终态。createdById 是审计列，任何读授权里都没有它；
 * `view/create/update/submit/void` 允许「仅本人」范围（staff 用），`convert` 不带范围
 * （只有 finance 与 root）。不新增角色，默认授权由新种子与 upgrade-r066 写。
 */
const NAMESPACE = 'app-local';
const title = (key: string) => ({ key, ns: NAMESPACE }) as const;

const requestTitle = title('authorization.financeRequests.tables.requests');
const orderTitle = title('authorization.expenses.tables.records');

/** 与接口契约的 FinanceRequest 窄列一致；不含 createdById、电话、邮箱。 */
const REQUEST_READ = [
  'id', 'docType', 'docNo', 'requestDate', 'expenseTypeCode', 'amount',
  'reason', 'handlerUserId', 'projectCode', 'status', 'approvalId',
  'expenseRecordId', 'createdAt', 'updatedAt',
] as const;
const REQUEST_CREATE = [...REQUEST_READ, 'createdById'] as const;
const REQUEST_UPDATE = [
  'requestDate', 'expenseTypeCode', 'amount', 'reason', 'handlerUserId',
  'projectCode', 'status', 'approvalId', 'expenseRecordId', 'updatedAt',
] as const;
/** 转出的支出记录草稿：财务随后自己补收款方并登记。 */
const EXPENSE_CREATE = [
  'id', 'docNo', 'expenseDate', 'status', 'expenseTypeCode', 'fundAccountCode',
  'payeeName', 'supplierId', 'payeeAccountNo', 'payeeBankName', 'payeeBankCode',
  'bindMode', 'handlerUserId', 'projectCode', 'remark', 'totalAmount',
  'createdById', 'createdAt', 'updatedAt',
] as const;

export const FINANCE_REQUEST_COLLECTIONS: readonly DatabaseCollectionDefinition[] = [
  { name: 'financeRequestDocs', title: requestTitle, actions: ['read', 'create', 'update'] },
];

const readRequests = defineDatabasePermission((permission) =>
  permission
    .collection('financeRequestDocs')
    .title(requestTitle)
    .read(REQUEST_READ)
    .options(FINANCE_REQUEST_SCOPE_REFERENCES.financeRequestDocs, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const createRequests = defineDatabasePermission((permission) =>
  permission
    .collection('financeRequestDocs')
    .title(requestTitle)
    .read(REQUEST_READ)
    .create(REQUEST_CREATE)
    .options(FINANCE_REQUEST_SCOPE_REFERENCES.financeRequestDocs, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const updateRequests = defineDatabasePermission((permission) =>
  permission
    .collection('financeRequestDocs')
    .title(requestTitle)
    .read(REQUEST_READ)
    .update(REQUEST_UPDATE)
    .options(FINANCE_REQUEST_SCOPE_REFERENCES.financeRequestDocs, recordAccess.allRecords)
    .default(recordAccess.allRecords),
);
const createExpense = defineDatabasePermission((permission) =>
  permission
    .collection('expenseRecords')
    .title(orderTitle)
    .read(EXPENSE_CREATE)
    .create(EXPENSE_CREATE),
);

export const financeRequests = defineCompositeResource('financeRequests', (resource) =>
  resource
    .title(title('authorization.financeRequests.title'))
    .action('view', (action) =>
      action.title(title('authorization.financeRequests.actions.view')).grant('financeRequestDocs', readRequests))
    .action('create', (action) =>
      action.title(title('authorization.financeRequests.actions.create')).grant('financeRequestDocs', createRequests))
    .action('update', (action) =>
      action.title(title('authorization.financeRequests.actions.update')).grant('financeRequestDocs', updateRequests))
    .action('submit', (action) =>
      action.title(title('authorization.financeRequests.actions.submit')).grant('financeRequestDocs', updateRequests))
    .action('void', (action) =>
      action.title(title('authorization.financeRequests.actions.void')).grant('financeRequestDocs', updateRequests))
    .action('convert', (action) =>
      action
        .title(title('authorization.financeRequests.actions.convert'))
        .grant('financeRequestDocs', readRequests)
        .grant('expenseRecords', createExpense)),
);
