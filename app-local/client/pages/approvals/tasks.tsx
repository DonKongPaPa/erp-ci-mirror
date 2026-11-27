import { type ReactElement } from 'react';

import { ApprovalListPage } from './list.js';

/** 我的审批：数据由 `GET /api/approvals/tasks` 按审批人过滤，不接受本地挑人。 */
export default function ApprovalTasksPage(): ReactElement {
  return <ApprovalListPage variant='tasks' />;
}
