import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  FilterRow,
  FilterToggle,
  ListPage,
  NewButton,
  ResultCount,
  SelectFilter,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { errorText } from '#components/erp/messages';
import {
  dictChoices,
  useDictEntries,
} from '#components/erp/options';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';

import { DateFilter } from '../orders/fields.js';
import { formatAmount } from '../orders/model.js';
import { FinanceRequestsClient, type RequestSummary } from './client.js';
import { Dash, RequestDocTypeBadge, RequestStatusBadge } from './fields.js';
import {
  FINANCE_REQUESTS_LIST_KEYS,
  FINANCE_REQUESTS_RESOURCE,
} from './page-id.js';

/**
 * 请款单与报销单列表：筛选项只取端点支持的六样（类型、状态、类型码、项目、日期区间），
 * 端点没有关键字参数，所以不画搜索框。行级范围由服务端按授权决定（员工只看自己、财务看全部），
 * 页面只按会话持有的动作显隐入口，不在本地再过滤。
 */
export default function FinanceRequestsPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useMemo(() => new FinanceRequestsClient(api), [api]);
  const view = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'view' });
  const create = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'create' });
  const update = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'update' });
  const submit = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'submit' });
  const voiding = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'void' });
  const convert = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'convert' });
  const bizDict = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const expenseTypes = useDictEntries('expense_type', bizDict.can);
  const projects = useDictEntries('project', bizDict.can);
  const list = useEntityList<RequestSummary>({
    path: 'finance-requests',
    filterKeys: ['docType', 'status', 'expenseTypeCode', 'projectCode', 'from', 'to'],
    searchable: false,
    enabled: view.can,
    pending: view.isPending,
  });
  const writable = update.can || submit.can || voiding.can || convert.can;
  const applied = [
    list.filters.docType,
    list.filters.status,
    list.filters.expenseTypeCode,
    list.filters.projectCode,
    list.filters.from,
    list.filters.to,
  ].filter(Boolean).length;
  const [expanded, setExpanded] = useState(false);
  const filtersOpen = expanded || applied > 0;
  const [busyId, setBusyId] = useState<string>();
  const [voidRow, setVoidRow] = useState<RequestSummary>();
  const [actionError, setActionError] = useState<string>();

  const act = async (
    kind: 'submit' | 'void' | 'convert',
    row: RequestSummary,
  ): Promise<void> => {
    setBusyId(row.id);
    setActionError(undefined);
    try {
      if (kind === 'convert') {
        const result = await client.createExpense(row.id);
        toaster.show({
          type: 'success',
          title: t('financeRequestDocs.toasts.converted', { name: row.docNo }),
        });
        await navigate(`/expenses/${result.expenseRecordId}`);
        return;
      }
      await client[kind](row.id);
      toaster.show({
        type: 'success',
        title: t(
          kind === 'void'
            ? 'financeRequestDocs.toasts.voided'
            : 'financeRequestDocs.toasts.submitted',
          { name: row.docNo },
        ),
      });
      list.reload();
    } catch (next) {
      setActionError(errorText(next, t));
      list.reload();
    } finally {
      setBusyId(undefined);
      setVoidRow(undefined);
    }
  };
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });

  const columns = useMemo<ColumnDef<RequestSummary>[]>(() => {
    const search = location.search;
    const base = (row: RequestSummary) =>
      `/finance-requests/${encodeURIComponent(row.id)}`;
    const to = (row: RequestSummary, segment?: string) => ({
      pathname: segment ? `${base(row)}/${segment}` : base(row),
      search,
    });
    const editable = (row: RequestSummary) =>
      row.status === 'draft' || row.status === 'rejected';
    const actions: ColumnDef<RequestSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<RequestSummary, unknown>) => {
        const one = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: one.docNo })}
            actions={[
              editable(one) && update.can
                ? {
                    key: 'edit',
                    label: t('financeRequestDocs.actions.edit'),
                    render: <Link to={to(one, 'edit')} />,
                  }
                : null,
              editable(one) && submit.can
                ? {
                    key: 'submit',
                    label: t('financeRequestDocs.actions.submit'),
                    disabled: busyId === one.id,
                    onClick: () => void actRef.current('submit', one),
                  }
                : null,
              editable(one) && voiding.can
                ? {
                    key: 'void',
                    label: t('financeRequestDocs.actions.void'),
                    destructive: true,
                    disabled: busyId === one.id,
                    onClick: () => setVoidRow(one),
                  }
                : null,
              one.status === 'approved' && convert.can
                ? {
                    key: 'convert',
                    label: t('financeRequestDocs.actions.convert'),
                    disabled: busyId === one.id,
                    onClick: () => void actRef.current('convert', one),
                  }
                : null,
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'docNo',
        header: t('financeRequestDocs.fields.docNo'),
        cell: ({ row }) => (
          <RecordLink to={to(row.original)}>{row.original.docNo}</RecordLink>
        ),
      },
      {
        id: 'docType',
        header: t('financeRequestDocs.fields.docType'),
        cell: ({ row }) => (
          <RequestDocTypeBadge docType={row.original.docType} />
        ),
      },
      {
        id: 'requestDate',
        header: t('financeRequestDocs.fields.requestDate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.requestDate}</span>
        ),
      },
      {
        id: 'expenseTypeLabel',
        header: t('financeRequestDocs.fields.expenseType'),
        cell: ({ row }) =>
          row.original.expenseTypeLabel ?? row.original.expenseTypeCode ?? <Dash />,
      },
      {
        id: 'handler',
        header: t('financeRequestDocs.fields.handler'),
        cell: ({ row }) => row.original.handler.name || <Dash />,
      },
      {
        id: 'amount',
        header: t('financeRequestDocs.fields.amount'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {t('financeRequestDocs.money', {
              amount: formatAmount(row.original.amount, locale),
            })}
          </span>
        ),
      },
      {
        id: 'projectLabel',
        header: t('financeRequestDocs.fields.project'),
        cell: ({ row }) =>
          row.original.projectLabel ?? row.original.projectCode ?? <Dash />,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <RequestStatusBadge status={row.original.status} />,
      },
      ...(writable ? [actions] : []),
    ];
  }, [
    t,
    locale,
    location.search,
    update.can,
    submit.can,
    voiding.can,
    convert.can,
    writable,
    busyId,
  ]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('financeRequestDocs.title')}
      description={t('financeRequestDocs.description')}
      actions={
        create.can ? (
          <NewButton
            to={`/finance-requests/new${location.search}`}
            label={t('financeRequestDocs.actions.new')}
          />
        ) : undefined
      }
    >
      <DataTable<RequestSummary>
        columns={
          skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), writable)
            : columns
        }
        data={skeleton ? skeletonRows<RequestSummary>(SKELETON_ROW_COUNT) : list.rows}
        getRowId={(row, index) => (skeleton ? `skeleton-${index}` : row.id)}
        manualPagination
        rowCount={list.total}
        paginationState={list.paginationState}
        onPaginationChange={list.onPaginationChange}
        pageSizeOptions={list.pageSizeOptions}
        pageSize={20}
        sortableColumns={list.sortableColumns}
        loading={list.loading}
        loadingIdentity={list.requestPath}
        listState={skeleton ? undefined : list.listState}
        onRetry={list.reload}
        onClearFilters={list.clearFilters}
        filtered={list.filtered}
        pagination={!skeleton}
        showSelectedCount={false}
        emptyMessage={t('financeRequestDocs.empty')}
        toolbar={() => (
          <>
            <FilterToggle
              expanded={filtersOpen}
              applied={applied}
              onClick={() => setExpanded(!filtersOpen)}
            />
            <ResultCount count={list.total} />
          </>
        )}
        filterPanel={
          filtersOpen ? (
            <FilterRow>
              <SelectFilter
                label={t('financeRequestDocs.filters.docType')}
                value={list.filters.docType ?? ''}
                options={[
                  { value: 'payment_request', label: t('financeRequestDocs.docTypes.payment_request') },
                  { value: 'expense_claim', label: t('financeRequestDocs.docTypes.expense_claim') },
                ]}
                onChange={(value) => list.setFilter('docType', value)}
              />
              <SelectFilter
                label={t('financeRequestDocs.filters.status')}
                value={list.filters.status ?? ''}
                options={[
                  'draft',
                  'approving',
                  'approved',
                  'rejected',
                  'void',
                  'converted',
                ].map((status) => ({
                  value: status,
                  label: t(`financeRequestDocs.status.${status}`),
                }))}
                onChange={(value) => list.setFilter('status', value)}
              />
              {bizDict.can ? (
                <SelectFilter
                  label={t('financeRequestDocs.filters.expenseType')}
                  value={list.filters.expenseTypeCode ?? ''}
                  options={dictChoices(expenseTypes.items)}
                  onChange={(value) => list.setFilter('expenseTypeCode', value)}
                />
              ) : null}
              {bizDict.can ? (
                <SelectFilter
                  label={t('financeRequestDocs.filters.project')}
                  value={list.filters.projectCode ?? ''}
                  options={dictChoices(projects.items)}
                  onChange={(value) => list.setFilter('projectCode', value)}
                />
              ) : null}
              <DateFilter
                label={t('financeRequestDocs.filters.from')}
                value={list.filters.from ?? ''}
                onChange={(iso) => list.setFilter('from', iso)}
              />
              <DateFilter
                label={t('financeRequestDocs.filters.to')}
                value={list.filters.to ?? ''}
                end
                onChange={(iso) => list.setFilter('to', iso)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      {actionError ? (
        <p role='alert' className='text-sm text-destructive'>
          {actionError}
        </p>
      ) : null}
      <ConfirmDialog
        open={voidRow !== undefined}
        title={t('financeRequestDocs.voidTitle', { name: voidRow?.docNo ?? '' })}
        description={t('financeRequestDocs.voidDescription')}
        confirmLabel={t('financeRequestDocs.actions.void')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busyId !== undefined}
        onCancel={() => setVoidRow(undefined)}
        onConfirm={() => {
          if (voidRow) void act('void', voidRow);
        }}
      />
      <Outlet />
    </ListPage>
  );
}

/** 搜索、筛选、页码从详情回到列表时原样带回。 */
export { FINANCE_REQUESTS_LIST_KEYS };
