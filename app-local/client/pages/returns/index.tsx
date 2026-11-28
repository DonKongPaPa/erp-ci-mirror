import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef, Row } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import {
  FilterRow,
  FilterToggle,
  ListPage,
  ListSearch,
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
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Textarea } from '#components/ui/textarea';

import { formatDateTime } from '../stock/format.js';
import {
  ReturnsClient,
  type FinanceOption,
  type ReturnSummary,
} from './client.js';
import { ReturnStatusBadge } from './fields.js';
import { errorHint } from './model.js';
import {
  DOC_BASE,
  PURCHASE_RETURNS,
  RETURN_LIST_KEYS,
  SALES_RETURNS,
  returnResource,
  type ReturnKindDef,
} from './page-id.js';

const detailLink = (def: ReturnKindDef, doc: ReturnSummary): string =>
  `${def.basePath}/${encodeURIComponent(doc.id)}`;

/**
 * 采购退货与销售退货同形。读、发起、过账、作废按业务动作显隐：
 * 采购 / 销售有 view 与自己的写动作；仓管只有 postView，看「待我过账」并过账；
 * 财务只有 financeView，看销售退货的窄形状（没有备注、单价、经办人）。
 */
export function ReturnsListPage({ def }: { readonly def: ReturnKindDef }): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new ReturnsClient(api, def), [api, def]);
  const resource = returnResource(def);
  const view = useCan({ resource, action: 'view' });
  const postView = useCan({ resource, action: 'postView' });
  const create = useCan({ resource, action: 'create' });
  const voiding = useCan({ resource, action: 'void' });
  const posting = useCan({ resource, action: 'post' });
  const financeView = useCan({ resource, action: 'financeView' });

  const pendingOnly = postView.can && !view.can;
  const financeOnly = financeView.can && !view.can && !postView.can;

  const list = useEntityList<ReturnSummary>({
    path: def.api,
    // 仓管的待过账列表固定 status=draft：同时把 status 从可写筛选里拿掉，
    // 否则空筛选值会在拼请求时覆盖掉 fixed 里的 draft。
    filterKeys: pendingOnly ? RETURN_LIST_KEYS.filter((key) => key !== 'status') : RETURN_LIST_KEYS,
    fixed: pendingOnly ? { status: 'draft' } : undefined,
    enabled: view.can || postView.can,
    pending: view.isPending || postView.isPending,
  });
  const financeList = useEntityList<FinanceOption>({
    path: 'sales-returns/finance-options',
    filterKeys: [],
    enabled: financeOnly,
    pending: financeView.isPending,
  });

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<ReturnSummary>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const runVoid = async (doc: ReturnSummary, why: string): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.voidDoc(doc.id, why.trim());
      toaster.show({ type: 'success', title: t('returns.toasts.voided', { docNo: doc.docNo }) });
      setVoidTarget(undefined);
      setReason('');
      list.reload();
    } catch (cause) {
      setActionError(errorHint(cause, t));
    } finally {
      setBusy(false);
    }
  };
  const runRef = useRef(runVoid);
  useEffect(() => {
    runRef.current = runVoid;
  });

  const reloadList = list.reload;
  const runPost = useCallback(async (doc: ReturnSummary): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.post(doc.id);
      toaster.show({ type: 'success', title: t('returns.toasts.posted', { docNo: doc.docNo }) });
      reloadList();
    } catch (cause) {
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  }, [client, toaster, t, reloadList]);

  const columns = useMemo<ColumnDef<ReturnSummary>[]>(() => {
    const actions: ColumnDef<ReturnSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<ReturnSummary, unknown>) => {
        const doc = row.original;
        if (doc.status !== 'draft') return null;
        // 任务书点名列表里要有「过账」「作废」按钮，故把两个动作 exposed 在 ⋮ 菜单之外。
        return (
          <RowActions
            label={t('returns.actions.actionsFor', { docNo: doc.docNo })}
            exposed={['post', 'void']}
            actions={[
              posting.can && {
                key: 'post',
                label: t('returns.actions.post'),
                disabled: busy,
                onClick: () => {
                  void runPost(doc);
                },
              },
              voiding.can && {
                key: 'void',
                label: t('returns.actions.void'),
                disabled: busy,
                onClick: () => {
                  setReason('');
                  setVoidTarget(doc);
                },
              },
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'docNo',
        header: t('returns.columns.docNo'),
        cell: ({ row }) => (
          <RecordLink to={{ pathname: detailLink(def, row.original), search: location.search }}>
            {row.original.docNo}
          </RecordLink>
        ),
      },
      {
        id: 'partner',
        header: t(def.kind === 'purchase' ? 'returns.columns.supplier' : 'returns.columns.customer'),
        cell: ({ row }) => row.original.partner?.name ?? '—',
      },
      // 备注只有发起方拿得到；仓管与财务都不画这一列。
      ...(view.can
        ? [{
            id: 'remark',
            header: t('returns.columns.remark'),
            cell: ({ row }: CellContext<ReturnSummary, unknown>) => row.original.remark,
          } as ColumnDef<ReturnSummary>]
        : []),
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <ReturnStatusBadge status={row.original.status} />,
      },
      {
        id: 'createdAt',
        header: t('returns.columns.createdAt'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{formatDateTime(row.original.createdAt, locale)}</span>
        ),
      },
      ...(posting.can || voiding.can ? [actions] : []),
    ];
  }, [t, locale, def, location.search, view.can, posting.can, voiding.can, busy, runPost]);

  const financeColumns = useMemo<ColumnDef<FinanceOption>[]>(
    () => [
      {
        id: 'docNo',
        header: t('returns.columns.docNo'),
        // financeView 只有窄读，没有详情读权，这里不给详情链接。
        cell: ({ row }) => <span className='tabular-nums'>{row.original.docNo}</span>,
      },
      {
        id: 'returnDate',
        header: t('returns.columns.returnDate'),
        cell: ({ row }) => row.original.returnDate ?? '—',
      },
      { id: 'customerId', header: t('returns.columns.customer'), cell: ({ row }) => row.original.customerId ?? '—' },
      {
        id: 'qty',
        header: t('returns.columns.returnedQty'),
        cell: ({ row }) => row.original.lines.reduce((sum, line) => sum + line.qty, 0),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => <ReturnStatusBadge status={row.original.status} />,
      },
    ],
    [t],
  );

  const statusOptions = useMemo(
    () =>
      (['draft', 'posted', 'void'] as const).map((status) => ({
        value: status,
        label: t(`returns.status.${status}`),
      })),
    [t],
  );

  const title = t(`navigation.${def.kind === 'purchase' ? 'purchaseReturns' : 'salesReturns'}`);
  const showingFinance = financeOnly;
  const returnCard = (row: Row<ReturnSummary>) => {
    const doc = row.original;
    return (
      <article aria-label={doc.docNo} className='flex flex-col gap-1 text-sm'>
        <RecordLink to={{ pathname: detailLink(def, doc), search: location.search }}>
          {doc.docNo}
        </RecordLink>
        <span className='text-muted-foreground'>{doc.partner?.name ?? '—'}</span>
        {view.can ? <span>{doc.remark || '—'}</span> : null}
        <ReturnStatusBadge status={doc.status} />
      </article>
    );
  };
  const financeCard = (row: Row<FinanceOption>) => {
    const doc = row.original;
    return (
      <article aria-label={doc.docNo} className='flex flex-col gap-1 text-sm'>
        <span className='font-medium'>{doc.docNo}</span>
        <span className='text-muted-foreground'>{doc.returnDate ?? '—'}</span>
        <span>{doc.customerId ?? '—'}</span>
        <span className='tabular-nums'>{doc.lines.reduce((sum, line) => sum + line.qty, 0)}</span>
        <ReturnStatusBadge status={doc.status} />
      </article>
    );
  };
  const returnLabels: Readonly<Record<string, string>> = {
    docNo: t('returns.columns.docNo'),
    partner: t(def.kind === 'purchase' ? 'returns.columns.supplier' : 'returns.columns.customer'),
    remark: t('returns.columns.remark'),
    status: t('erp.fields.status'),
    createdAt: t('returns.columns.createdAt'),
  };
  const financeLabels: Readonly<Record<string, string>> = {
    docNo: t('returns.columns.docNo'),
    returnDate: t('returns.columns.returnDate'),
    customerId: t('returns.columns.customer'),
    qty: t('returns.columns.returnedQty'),
    status: t('erp.fields.status'),
  };

  return (
    <ListPage
      title={title}
      description={t('returns.description')}
      actions={
        create.can ? <NewButton to={`${def.basePath}/new`} label={t('returns.actions.new')} /> : undefined
      }
    >
      {showingFinance ? (
        <DataTable<FinanceOption>
          columns={financeColumns}
          data={financeList.rows}
          getRowId={(row) => row.id}
          manualPagination
          rowCount={financeList.total}
          paginationState={financeList.paginationState}
          onPaginationChange={financeList.onPaginationChange}
          pageSizeOptions={financeList.pageSizeOptions}
          pageSize={20}
          sortableColumns={financeList.sortableColumns}
          loading={financeList.loading}
          loadingIdentity={financeList.requestPath}
          listState={financeList.listState}
          onRetry={financeList.reload}
          onClearFilters={financeList.clearFilters}
          filtered={financeList.filtered}
          showSelectedCount={false}
          emptyMessage={`${t('returns.empty')} ${t('returns.emptyHint')}`}
          renderCard={financeCard}
          getColumnLabel={(column) => financeLabels[column.id] ?? column.id}
          search={<ListSearch value={financeList.q} onSearch={financeList.setSearch} label={t('returns.searchLabel')} />}
          summary={<ResultCount count={financeList.total} />}
        />
      ) : (
        <DataTable<ReturnSummary>
          columns={list.skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), posting.can || voiding.can)
            : columns}
          data={list.skeleton ? skeletonRows<ReturnSummary>(SKELETON_ROW_COUNT) : list.rows}
          getRowId={(row, index) => (list.skeleton ? `skeleton-${index}` : row.id)}
          manualPagination
          rowCount={list.total}
          paginationState={list.paginationState}
          onPaginationChange={list.onPaginationChange}
          pageSizeOptions={list.pageSizeOptions}
          pageSize={20}
          sortableColumns={list.sortableColumns}
          loading={list.loading}
          loadingIdentity={list.requestPath}
          listState={list.skeleton ? undefined : list.listState}
          onRetry={list.reload}
          onClearFilters={list.clearFilters}
          filtered={list.filtered}
          pagination={!list.skeleton}
          showSelectedCount={false}
          emptyMessage={`${t('returns.empty')} ${t('returns.emptyHint')}`}
          emptyAction={create.can
            ? <NewButton to={`${def.basePath}/new`} label={t('returns.actions.new')} />
            : undefined}
          renderCard={list.skeleton ? undefined : returnCard}
          getColumnLabel={(column) => returnLabels[column.id] ?? column.id}
          search={<ListSearch value={list.q} onSearch={list.setSearch} label={t('returns.searchLabel')} />}
          toolbar={() =>
            view.can ? (
              <FilterToggle
                expanded={filtersOpen}
                applied={Object.values(list.filters).filter(Boolean).length}
                onClick={() => setFiltersOpen((open) => !open)}
              />
            ) : undefined
          }
          filterPanel={
            view.can && filtersOpen ? (
              <FilterRow>
                <SelectFilter
                  label={t('returns.filters.status')}
                  value={list.filters.status ?? ''}
                  options={statusOptions}
                  onChange={(value) => list.setFilter('status', value)}
                />
                <SelectFilter
                  label={t('returns.filters.partner')}
                  value={list.filters.partnerId ?? ''}
                  options={[]}
                  onChange={(value) => list.setFilter('partnerId', value)}
                />
              </FilterRow>
            ) : undefined
          }
          summary={<ResultCount count={list.total} />}
        />
      )}
      {pendingOnly ? (
        <p role='status' className='text-sm text-muted-foreground' data-testid='returns-pending-hint'>
          {t('returns.pendingHint')}
        </p>
      ) : null}
      {actionError ? <p role='alert' className='text-sm text-destructive'>{actionError}</p> : null}
      <Dialog
        open={voidTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setVoidTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('returns.voidTitle', { docNo: voidTarget?.docNo ?? '' })}</DialogTitle>
            <DialogDescription>{t('returns.voidDescription')}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t('returns.fields.voidReason')}
            placeholder={t('returns.fields.voidReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {actionError ? <p role='alert' className='text-sm text-destructive'>{actionError}</p> : null}
          <div className='flex justify-end gap-2'>
            <Button variant='outline' onClick={() => setVoidTarget(undefined)}>{t('actions.cancel')}</Button>
            <Button
              variant='destructive'
              disabled={busy || reason.trim() === ''}
              data-testid='returns-confirm-void'
              onClick={() => {
                if (voidTarget && reason.trim()) void runRef.current(voidTarget, reason);
              }}
            >
              {t('returns.actions.confirmVoid')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Outlet />
    </ListPage>
  );
}

/** 过账生成的出入库单在详情里按 returnDocId 反查，链接到对应方向的列表。 */
export const RETURN_DOC_BASE = DOC_BASE;

export function PurchaseReturnsListPage(): ReactElement {
  return <ReturnsListPage def={PURCHASE_RETURNS} />;
}

export function SalesReturnsListPage(): ReactElement {
  return <ReturnsListPage def={SALES_RETURNS} />;
}
