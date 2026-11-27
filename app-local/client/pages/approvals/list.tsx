import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, type ReactElement } from 'react';
import { useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import {
  ListPage,
  ListSearch,
  ListTabs,
  ResultCount,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { RecordLink } from '#components/record-link';
import { StatusBadge } from '#components/status-badge';

import type { MineRow, TaskRow } from './client.js';
import {
  APPROVAL_RESOURCE,
  formatTime,
  MINE_SCOPES,
  recordStatusLabel,
  statusLabel,
  statusTone,
  TASK_SCOPES,
} from './model.js';
import { useApprovalList } from './use-approval-list.js';

/** 「我的申请」与「我的审批」共用的列表骨架；两者只是端点、页签与列不同。 */
export function ApprovalListPage({
  variant,
}: {
  readonly variant: 'mine' | 'tasks';
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const location = useLocation();
  const submit = useCan({ resource: APPROVAL_RESOURCE, action: 'submit' });
  const review = useCan({ resource: APPROVAL_RESOURCE, action: 'review' });
  const mine = variant === 'mine';
  const scopes = mine ? MINE_SCOPES : TASK_SCOPES;
  const sortColumns = mine
    ? ['createdAt', 'updatedAt', 'status']
    : ['createdAt', 'actedAt', 'dueAt'];
  // 两个业务动作任一持有者都可以进列表；端点再按申请人/审批人过滤数据。
  const enabled = mine ? (submit.can || review.can) : review.can;
  const list = useApprovalList<MineRow | TaskRow>({
    path: mine ? 'approvals/mine' : 'approvals/tasks',
    scopes,
    sortColumns,
    enabled,
  });

  const columns = useMemo<ColumnDef<MineRow | TaskRow>[]>(() => {
    const search = location.search;
    const linkTo = (id: string, task?: string) => {
      const params = new URLSearchParams(search);
      params.set('from', mine ? 'mine' : 'tasks');
      if (task) params.set('task', task);
      return {
        pathname: `/approvals/${encodeURIComponent(id)}`,
        search: `?${params.toString()}`,
      };
    };
    if (mine) {
      return [
        {
          id: 'workflowKey',
          header: t('approvals.fields.workflowKey'),
          cell: ({ row }: CellContext<MineRow | TaskRow, unknown>) => {
            const item = row.original as MineRow;
            return (
              <RecordLink data-testid='approval-link' to={linkTo(item.id)}>
                {item.workflowKey}
              </RecordLink>
            );
          },
        },
        {
          id: 'collectionName',
          header: t('approvals.fields.collectionName'),
          cell: ({ row }) => (row.original as MineRow).collectionName,
        },
        {
          id: 'status',
          header: t('approvals.fields.status'),
          cell: ({ row }) => {
            const status = row.original.status;
            return (
              <StatusBadge tone={statusTone(status)} size='sm'>
                {statusLabel(t, status)}
              </StatusBadge>
            );
          },
        },
        {
          id: 'currentRound',
          header: t('approvals.fields.currentRound'),
          cell: ({ row }) => <span className='tabular-nums'>{(row.original as MineRow).currentRound}</span>,
        },
        {
          id: 'updatedAt',
          header: t('approvals.fields.updatedAt'),
          cell: ({ row }) => formatTime((row.original as MineRow).updatedAt, locale),
        },
      ];
    }
    return [
      {
        id: 'nodeKey',
        header: t('approvals.fields.nodeKey'),
        cell: ({ row }: CellContext<MineRow | TaskRow, unknown>) => {
          const item = row.original as TaskRow;
          return (
            <RecordLink data-testid='task-link' to={linkTo(item.approvalId, item.id)}>
              {item.nodeKey}
            </RecordLink>
          );
        },
      },
      {
        id: 'approvalId',
        header: t('approvals.fields.approvalId'),
        cell: ({ row }) => (row.original as TaskRow).approvalId,
      },
      {
        id: 'status',
        header: t('approvals.fields.status'),
        cell: ({ row }) => {
          const status = row.original.status;
          return (
            <StatusBadge tone={statusTone(status)} size='sm'>
              {recordStatusLabel(t, status)}
            </StatusBadge>
          );
        },
      },
      {
        id: 'seq',
        header: t('approvals.fields.seq'),
        cell: ({ row }) => <span className='tabular-nums'>{(row.original as TaskRow).seq}</span>,
      },
      {
        id: 'dueAt',
        header: t('approvals.fields.dueAt'),
        cell: ({ row }) => formatTime((row.original as TaskRow).dueAt, locale),
      },
    ];
  }, [t, locale, location.search, mine]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t(mine ? 'approvals.mine.title' : 'approvals.tasks.title')}
      description={t(mine ? 'approvals.mine.description' : 'approvals.tasks.description')}
      tabs={
        <ListTabs
          items={scopes.map((scope) => ({
            key: scope,
            label: t(`approvals.scope.${scope}`),
          }))}
          value={list.scope}
          onChange={list.setScope}
        />
      }
    >
      <DataTable<MineRow | TaskRow>
        columns={
          skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), true)
            : columns
        }
        data={skeleton ? skeletonRows<MineRow | TaskRow>(SKELETON_ROW_COUNT) : list.rows}
        getRowId={(row, index) => (skeleton ? `skeleton-${index}` : row.id)}
        manualPagination
        rowCount={list.total}
        paginationState={list.paginationState}
        onPaginationChange={list.onPaginationChange}
        pageSizeOptions={list.pageSizeOptions}
        manualSorting
        sortingState={list.sortingState}
        onSortingChange={list.onSortingChange}
        sortableColumns={list.sortableColumns}
        loading={list.loading}
        loadingIdentity={list.requestPath}
        listState={enabled ? (skeleton ? undefined : list.listState) : 'forbidden'}
        onRetry={list.reload}
        onClearFilters={list.clearFilters}
        filtered={list.filtered}
        emptyMessage={t(mine ? 'approvals.mine.empty' : 'approvals.tasks.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('approvals.searchLabel')}
          />
        }
        summary={<ResultCount count={list.total} />}
      />
    </ListPage>
  );
}
