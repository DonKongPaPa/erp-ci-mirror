import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import { TypeBadge } from '#components/erp/detail';
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
import { StatusBadge } from '#components/status-badge';
import { dateInputValue, endOfDay, formatDateTime, startOfDay } from '../stock/format.js';
import { Input } from '#components/ui/input';

import { StockDocsClient, type StockDocSummary } from './client.js';
import type { StockKind } from './kind.js';
import { isNotDraft } from './model.js';
import { INVENTORY_RESOURCE } from '../warehouses/page-id.js';

const detailLink = (def: StockKind, doc: StockDocSummary): string =>
  `${def.base}/${encodeURIComponent(doc.id)}`;

/**
 * 入库单、出库单的列表（`/inbound-orders`、`/outbound-orders`，R-020）：搜索（单号或备注），
 * 展开的筛选里是状态与创建时间（端点没有按类型筛的参数）。默认是全部状态。
 * 读要 inventory.stockView；编辑要 stockWrite，作废要 stockVoid。已过账、已作废的行没有操作。
 */
export function StockDocsPage({ def }: { readonly def: StockKind }): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new StockDocsClient(api), [api]);
  const view = useCan({ resource: INVENTORY_RESOURCE, action: 'stockView' });
  const write = useCan({ resource: INVENTORY_RESOURCE, action: 'stockWrite' });
  const voiding = useCan({ resource: INVENTORY_RESOURCE, action: 'stockVoid' });
  const canWrite = write.can;
  const canVoid = voiding.can;
  const list = useEntityList<StockDocSummary>({
    path: 'stock-docs',
    fixed: { docType: def.kind },
    filterKeys: ['status', 'from', 'to'],
    enabled: view.can,
    pending: view.isPending,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<StockDocSummary>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 行上的作废。先过下面的确认框。 */
  const runVoid = async (doc: StockDocSummary) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.voidDoc(doc.id);
      toaster.show({
        type: 'success',
        title: t(`stockDocs.${def.words}.voidedToast`, { docNo: doc.docNo }),
      });
      setVoidTarget(undefined);
      list.reload();
    } catch (error) {
      // 单据已不是草稿（别处刚过账或作废）：关掉确认框，按最新的一页重画。
      if (isNotDraft(error)) {
        setVoidTarget(undefined);
        list.reload();
        toaster.show({ type: 'error', title: errorText(error, t) });
      } else {
        setActionError(errorText(error, t));
      }
    } finally {
      setBusy(false);
    }
  };
  // 行上的操作调用最新的一份 runVoid；列定义保持是同一个引用，重新取数时不会重装操作格。
  const runRef = useRef(runVoid);
  useEffect(() => {
    runRef.current = runVoid;
  });

  const columns = useMemo<ColumnDef<StockDocSummary>[]>(() => {
    const actions: ColumnDef<StockDocSummary> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<StockDocSummary, unknown>) => {
        const doc = row.original;
        // 只有草稿有操作；其余的行「⋮」不画。
        if (doc.status !== 'draft') return null;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: doc.docNo })}
            actions={[
              canWrite && {
                key: 'edit',
                label: t('erp.actions.edit'),
                render: (
                  <Link
                    to={{
                      pathname: `${detailLink(def, doc)}/edit`,
                      search: location.search,
                    }}
                  />
                ),
              },
              canVoid && {
                key: 'void',
                label: t('stockDocs.void'),
                destructive: true,
                onClick: () => setVoidTarget(doc),
              },
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'docNo',
        header: t('stockDocs.columns.docNo'),
        // 首列是单号，点开单据；地址栏里的搜索与筛选带过去，回到列表时还在。
        cell: ({ row }) => (
          <RecordLink
            to={{
              pathname: detailLink(def, row.original),
              search: location.search,
            }}
          >
            {row.original.docNo}
          </RecordLink>
        ),
      },
      {
        id: 'reason',
        header: t('stockDocs.columns.typeAndSource'),
        cell: ({ row }) => (
          <span className='flex flex-wrap items-center gap-1'>
            <TypeBadge>{t(`stockDocs.reasons.${row.original.reason}`)}</TypeBadge>
            {/* 契约的来源只有一个标识，显示不出订单号，所以不给链接。 */}
            <span className='text-muted-foreground'>
              {row.original.sourceType
                ? t(`stockDocs.source.${row.original.sourceType}`)
                : t('stockDocs.source.manual')}
            </span>
          </span>
        ),
      },
      {
        id: 'createdAt',
        header: t('stockDocs.columns.createdAt'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {formatDateTime(row.original.createdAt, locale)}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <StatusBadge
            size='sm'
            tone={row.original.status === 'posted' ? 'success' : 'neutral'}
          >
            {t(`stockDocs.status.${row.original.status}`)}
          </StatusBadge>
        ),
      },
      // 没有任何写权限的人整列操作都不画。
      ...(canWrite || canVoid ? [actions] : []),
    ];
  }, [t, locale, def, canWrite, canVoid, location.search]);

  const statusOptions = useMemo(
    () =>
      (['draft', 'posted', 'void'] as const).map((status) => ({
        value: status,
        label: t(`stockDocs.status.${status}`),
      })),
    [t],
  );
  const applied = Object.values(list.filters).filter(Boolean).length;
  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t(`stockDocs.${def.words}.title`)}
      description={t(`stockDocs.${def.words}.description`)}
      actions={
        canWrite ? (
          <NewButton
            to={`${def.base}/new`}
            label={t(`stockDocs.${def.words}.new`)}
          />
        ) : undefined
      }
    >
      <DataTable<StockDocSummary>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canWrite || canVoid,
              )
            : columns
        }
        data={
          skeleton
            ? skeletonRows<StockDocSummary>(SKELETON_ROW_COUNT)
            : list.rows
        }
        getRowId={(row, index) =>
          skeleton ? `skeleton-${index}` : row.id
        }
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
        emptyMessage={t('stockDocs.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('stockDocs.searchLabel')}
          />
        }
        toolbar={() => (
          <FilterToggle
            expanded={filtersOpen}
            applied={applied}
            onClick={() => setFiltersOpen((open) => !open)}
          />
        )}
        filterPanel={
          filtersOpen ? (
            <FilterRow>
              <SelectFilter
                label={t('stockDocs.filters.status')}
                value={list.filters.status ?? ''}
                options={statusOptions}
                onChange={(value) => list.setFilter('status', value)}
              />
              <DateFilter
                label={t('stockDocs.filters.from')}
                value={dateInputValue(list.filters.from ?? '')}
                onChange={(text) => list.setFilter('from', startOfDay(text))}
              />
              <DateFilter
                label={t('stockDocs.filters.to')}
                value={dateInputValue(list.filters.to ?? '')}
                onChange={(text) => list.setFilter('to', endOfDay(text))}
              />
            </FilterRow>
          ) : undefined
        }
        summary={<ResultCount count={list.total} />}
      />
      <ConfirmDialog
        open={voidTarget !== undefined}
        title={t(`stockDocs.${def.words}.voidTitle`, {
          docNo: voidTarget?.docNo ?? '',
        })}
        description={t('stockDocs.voidDescription')}
        confirmLabel={t('stockDocs.void')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setVoidTarget(undefined)}
        onConfirm={() => {
          if (voidTarget) void runRef.current(voidTarget);
        }}
      />
      {/* 新建、详情（及其上的编辑）从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}

/** 展开行里的一个日期：按本地时间的一天算，换成带时区的 ISO 串给端点。 */
function DateFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
}): ReactElement {
  return (
    <div className='flex w-44 flex-col gap-1.5'>
      <span className='text-sm font-medium'>{label}</span>
      {/* ui-component-exception: 项目尚无日期选择器与日历依赖，本片按设计偏差保留两个原生日期输入；补 DatePicker 要先引入依赖，超出本片范围 */}
      <Input
        type='date'
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
