import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';

import { DataTable } from '#components/data-table';
import { TypeBadge } from '#components/erp/detail';
import {
  FilterRow,
  FilterToggle,
  ListPage,
  ListSearch,
  ListTabs,
  ResultCount,
  SelectFilter,
  type FilterOption,
  type ListTab,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { RecordLink } from '#components/record-link';
import { Input } from '#components/ui/input';

import type { Balance, Transaction } from './client.js';
import { dateInputValue, endOfDay, formatDateTime, formatQty, startOfDay } from './format.js';
import {
  ITEMS_RESOURCE,
  itemLabel,
  useInventoryLookup,
} from './lookup.js';
import { INVENTORY_RESOURCE } from '../warehouses/page-id.js';

type StockView = 'balance' | 'ledger';
/** 换标签就是换一组数据：搜索、筛选、页码都清掉，只留标签。 */
const TAB_RESET_KEYS = [
  'view',
  'q',
  'page',
  'pageSize',
  'itemId',
  'warehouseId',
  'from',
  'to',
] as const;
const NUMBER = 'flex justify-end tabular-nums';
const DASH = <span className='text-muted-foreground'>—</span>;
const docPath = (entry: Transaction): string =>
  `${entry.qtyDelta >= 0 ? '/inbound-orders' : '/outbound-orders'}/${encodeURIComponent(entry.docId)}`;

/**
 * 库存查询（`/stock`，R-020）：现存量、流水两个标签，只读 —— 库存只随入库单、出库单过账而变动。
 * 读要 inventory.stockView。现存量按物料、仓库筛，搜索框只搜批次号；流水按物料、仓库、时间范围筛。
 */
export default function StockPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const stockView = useCan({ resource: INVENTORY_RESOURCE, action: 'stockView' });
  const itemView = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const warehouseView = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseView',
  });
  const [params, setParams] = useSearchParams();
  const view: StockView = params.get('view') === 'ledger' ? 'ledger' : 'balance';
  const canRead = stockView.can;
  const lookup = useInventoryLookup({
    items: canRead && itemView.can,
    warehouses: canRead && warehouseView.can,
  });
  // 权限没落定、名字还没对上之前先不发请求。
  const waiting = stockView.isPending || lookup.pending;
  const balances = useEntityList<Balance>({
    path: 'stock/balances',
    filterKeys: ['itemId', 'warehouseId'],
    enabled: canRead,
    pending: waiting,
  });
  const ledger = useEntityList<Transaction>({
    path: 'stock/transactions',
    searchable: false,
    filterKeys: ['itemId', 'warehouseId', 'from', 'to'],
    enabled: canRead,
    pending: waiting,
  });
  const list = view === 'ledger' ? ledger : balances;
  const [filtersOpen, setFiltersOpen] = useState(false);

  const itemOptions = useMemo<readonly FilterOption[]>(() => {
    const active = lookup.items.filter((item) => item.status === 'active');
    const chosen = lookup.item(list.filters.itemId ?? '');
    // 选中的那一项已停用时也留在清单里，下拉才显示得出它的名字。
    return (chosen && chosen.status !== 'active' ? [chosen, ...active] : active).map(
      (item) => ({ value: item.id, label: itemLabel(item) }),
    );
  }, [lookup, list.filters.itemId]);
  const warehouseOptions = useMemo<readonly FilterOption[]>(
    () =>
      lookup.warehouses.map((warehouse) => ({
        value: warehouse.id,
        label: warehouse.name,
      })),
    [lookup],
  );

  const nameOf = useCallback(
    (row: { readonly itemId: string }) => {
      const found = lookup.item(row.itemId);
      return found
        ? { code: found.code, name: found.name, spec: found.spec, unit: found.unitCode }
        : { code: row.itemId, name: '', spec: null, unit: '' };
    },
    [lookup],
  );
  const warehouseOf = useCallback(
    (row: { readonly warehouseId: string }): string =>
      lookup.warehouse(row.warehouseId)?.name ?? row.warehouseId,
    [lookup],
  );
  const balanceColumns = useMemo<ColumnDef<Balance>[]>(
    () => [
      {
        id: 'itemCode',
        header: t('stock.columns.itemCode'),
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>
            {nameOf(row.original).code}
          </span>
        ),
      },
      {
        id: 'itemName',
        header: t('stock.columns.itemName'),
        cell: ({ row }) => nameOf(row.original).name || DASH,
      },
      {
        id: 'spec',
        header: t('stock.columns.spec'),
        cell: ({ row }) => nameOf(row.original).spec || DASH,
      },
      {
        id: 'unit',
        header: t('stock.columns.unit'),
        cell: ({ row }) => nameOf(row.original).unit || DASH,
      },
      {
        id: 'warehouse',
        header: t('stock.columns.warehouse'),
        cell: ({ row }) => warehouseOf(row.original),
      },
      {
        id: 'batchNo',
        header: t('stock.columns.batch'),
        cell: ({ row }) => row.original.batchNo || DASH,
      },
      {
        id: 'qty',
        header: t('stock.columns.qty'),
        cell: ({ row }) => (
          <span className={NUMBER}>
            {formatQty(row.original.qty, locale)}
          </span>
        ),
      },
    ],
    // nameOf / warehouseOf 是 useCallback，随 lookup 变化。
    [t, locale, nameOf, warehouseOf],
  );
  const ledgerColumns = useMemo<ColumnDef<Transaction>[]>(
    () => [
      {
        id: 'at',
        header: t('stock.columns.time'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {formatDateTime(row.original.at, locale)}
          </span>
        ),
      },
      {
        id: 'docType',
        header: t('stock.columns.docType'),
        cell: ({ row }) => (
          // 入库为正、出库为负；类型只是分类值，不带颜色含义。
          <TypeBadge>
            {t(
              row.original.qtyDelta >= 0
                ? 'stock.docType.in'
                : 'stock.docType.out',
            )}
          </TypeBadge>
        ),
      },
      {
        id: 'docNo',
        header: t('stock.columns.docNo'),
        // 点单号回到那张入库单或出库单。
        cell: ({ row }) => (
          <RecordLink to={docPath(row.original)}>
            {row.original.docNo}
          </RecordLink>
        ),
      },
      {
        id: 'item',
        header: t('stock.columns.item'),
        cell: ({ row }) => {
          const item = nameOf(row.original);
          return (
            <span className='flex flex-wrap items-center gap-2'>
              <span className='font-medium tabular-nums'>{item.code}</span>
              {item.name ? <span>{item.name}</span> : null}
            </span>
          );
        },
      },
      {
        id: 'warehouse',
        header: t('stock.columns.warehouse'),
        cell: ({ row }) => warehouseOf(row.original),
      },
      {
        id: 'batchNo',
        header: t('stock.columns.batch'),
        cell: ({ row }) => row.original.batchNo || DASH,
      },
      {
        id: 'in',
        header: t('stock.columns.in'),
        cell: ({ row }) => (
          <span className={NUMBER}>
            {row.original.qtyDelta > 0
              ? `+${formatQty(row.original.qtyDelta, locale)}`
              : DASH}
          </span>
        ),
      },
      {
        id: 'out',
        header: t('stock.columns.out'),
        cell: ({ row }) => (
          <span className={NUMBER}>
            {row.original.qtyDelta < 0
              ? `−${formatQty(-row.original.qtyDelta, locale)}`
              : DASH}
          </span>
        ),
      },
      {
        id: 'balanceAfter',
        header: t('stock.columns.balance'),
        cell: ({ row }) => (
          <span className={NUMBER}>
            {formatQty(row.original.balanceAfter, locale)}
          </span>
        ),
      },
    ],
    [t, locale, nameOf, warehouseOf],
  );
  // 同一张表格按标签换一组列；两组列各自对着自己的行类型写。
  const columns = (view === 'ledger' ? ledgerColumns : balanceColumns) as unknown as ColumnDef<Balance | Transaction>[];

  const tabs: readonly ListTab[] = [
    { key: 'balance', label: t('stock.tabs.balance') },
    { key: 'ledger', label: t('stock.tabs.ledger') },
  ];
  const applied = Object.values(list.filters).filter(Boolean).length;
  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('stock.title')}
      description={t('stock.description')}
      tabs={
        <ListTabs
          items={tabs}
          value={view}
          onChange={(key) =>
            setParams(
              (old) => {
                const next = new URLSearchParams(old);
                for (const reset of TAB_RESET_KEYS) next.delete(reset);
                next.set('view', key);
                return next;
              },
              { replace: true },
            )
          }
        />
      }
    >
      {stockView.can && !lookup.pending && (!itemView.can || !warehouseView.can) ? (
        <p role='status' className='mb-3 text-sm text-muted-foreground'>
          {t('stock.lookupDenied')}
        </p>
      ) : null}
      <DataTable<Balance | Transaction>
        columns={
          skeleton
            ? skeletonColumns(columns, (row) => t('erp.list.loadingRow', { row }), false)
            : columns
        }
        data={
          skeleton
            ? skeletonRows<Balance | Transaction>(SKELETON_ROW_COUNT)
            : list.rows
        }
        getRowId={(row, index) =>
          skeleton
            ? `skeleton-${index}`
            : 'id' in row
              ? row.id
              : `${row.itemId}|${row.warehouseId}|${row.batchNo}`
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
        onClearFilters={list.clearable ? list.clearFilters : undefined}
        filtered={list.filtered}
        pagination={!skeleton}
        showSelectedCount={false}
        emptyMessage={t(view === 'ledger' ? 'stock.empty.ledger' : 'stock.empty.balance')}
        search={
          view === 'balance' ? (
            <ListSearch
              value={list.q}
              onSearch={list.setSearch}
              label={t('stock.searchLabel')}
            />
          ) : undefined
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
                label={t('stock.filters.item')}
                value={list.filters.itemId ?? ''}
                options={itemOptions}
                onChange={(value) => list.setFilter('itemId', value)}
              />
              <SelectFilter
                label={t('stock.filters.warehouse')}
                value={list.filters.warehouseId ?? ''}
                options={warehouseOptions}
                onChange={(value) => list.setFilter('warehouseId', value)}
              />
              {view === 'ledger' ? (
                <>
                  <DateInput
                    label={t('stock.filters.from')}
                    value={dateInputValue(list.filters.from ?? '')}
                    onChange={(text) => list.setFilter('from', startOfDay(text))}
                  />
                  <DateInput
                    label={t('stock.filters.to')}
                    value={dateInputValue(list.filters.to ?? '')}
                    onChange={(text) => list.setFilter('to', endOfDay(text))}
                  />
                </>
              ) : null}
            </FilterRow>
          ) : undefined
        }
        summary={<ResultCount count={list.total} />}
      />
    </ListPage>
  );
}

/** 展开行里的一个日期：按本地时间的一天算，换成带时区的 ISO 串给端点。 */
function DateInput({
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
