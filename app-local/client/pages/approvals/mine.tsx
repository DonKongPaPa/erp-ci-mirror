import { type ReactElement } from 'react';

import { ApprovalListPage } from './list.js';

/** 我的申请：数据由 `GET /api/approvals/mine` 按申请人过滤，页面只管查询串与显隐。 */
export default function ApprovalMinePage(): ReactElement {
  return <ApprovalListPage variant='mine' />;
}
