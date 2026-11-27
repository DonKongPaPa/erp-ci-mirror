import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';

import { ActiveBadge, TypeBadge } from '#components/erp/detail';
import {
  FilterRow,
  FilterToggle,
  IncludeInactiveFilter,
  ListSearch,
  SelectFilter,
  type FilterOption,
} from '#components/erp/list-page';
import { useEntityList } from '#components/erp/list-state';
import { RecordLink } from '#components/record-link';
import { RowActions } from '#components/row-actions';

import { ItemsClient, type Item } from './client.js';
import { categoryName, unitName, useItemDictionaries } from './dictionaries.js';
import { EntityTable } from './entity-table.js';
import { itemTypeLabel } from './model.js';
import { ITEMS_RESOURCE, type ListAccess } from './page-id.js';
import { useStatusChange } from './status-change.js';

const DASH = <span className='text-muted-foreground'>—</span>;
/** 展开行里的两个筛选，都记在地址栏上。 */
const ITEM_FILTER_KEYS = ['itemType', 'categoryCode'] as const;
const detailLink = (item: Item) => `/items/${encodeURIComponent(item.id)}`;
const editLink = (item: Item) => `${detailLink(item)}/edit`;

/**
 * 物料清单这一张表（`/items`，默认标签）：首列点开详情抽屉，行尾「⋮」里是编辑、停用（启用）。
 * 已停用的物料只能先启用再改（契约的不变量 5），所以那一行只有「启用」。
 */
export function ItemList({
  canView,
  canManage,
  pending,
}: ListAccess): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const purchasePrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewPurchasePrice',
  });
  const salesPrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewSalesPrice',
  });
  const dictionaries = useItemDictionaries(canView, pending);
  const list = useEntityList<Item>({
    path: 'items',
    filterKeys: ITEM_FILTER_KEYS,
    inactiveParam: 'status',
    enabled: canView,
    pending,
  });
  const { ask, activate, dialog } = useStatusChange<Item>({
    change: (item, status) => client.update(item.id, { status }),
    nameOf: (item) => item.name,
    noun: t('items.noun.item'),
    description: t('items.deactivateDescription'),
    reload: list.reload,
  });
  // 带着筛选进来（地址栏里有类型或分类）时展开行先打开，让人看得见当前值。
  const [expanded, setExpanded] = useState(() =>
    Boolean(list.filters.itemType || list.filters.categoryCode),
  );

  const columns = useMemo<ColumnDef<Item>[]>(() => {
    const actions: ColumnDef<Item> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Item, unknown>) => {
        const item = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: item.name })}
            actions={
              item.status === 'active'
                ? [
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: <Link to={editLink(item)} />,
                    },
                    {
                      key: 'deactivate',
                      label: t('erp.actions.deactivate'),
                      destructive: true,
                      onClick: () => ask(item),
                    },
                  ]
                : [
                    {
                      key: 'activate',
                      label: t('erp.actions.activate'),
                      onClick: () => activate(item),
                    },
                  ]
            }
          />
        );
      },
    };
    return [
      {
        id: 'code',
        header: t('erp.fields.code'),
        // 首列点开详情抽屉，列表还在后面。
        cell: ({ row }) => (
          <RecordLink to={detailLink(row.original)}>
            {row.original.code}
          </RecordLink>
        ),
      },
      {
        id: 'name',
        header: t('erp.fields.name'),
        cell: ({ row }) => row.original.name,
      },
      {
        id: 'spec',
        header: t('items.columns.spec'),
        cell: ({ row }) => row.original.spec ?? DASH,
      },
      {
        id: 'itemType',
        header: t('erp.fields.type'),
        cell: ({ row }) => (
          <TypeBadge>{itemTypeLabel(row.original.itemType, t)}</TypeBadge>
        ),
      },
      {
        id: 'categoryCode',
        header: t('items.columns.category'),
        cell: ({ row }) =>
          categoryName(dictionaries.data, row.original.categoryCode) ?? DASH,
      },
      {
        id: 'unitCode',
        header: t('items.columns.unit'),
        cell: ({ row }) => unitName(dictionaries.data, row.original.unitCode),
      },
      {
        id: 'englishName',
        header: t('items.columns.englishName'),
        cell: ({ row }) => row.original.englishName ?? DASH,
      },
      {
        id: 'stockMin',
        header: t('items.columns.stockMin'),
        cell: ({ row }) => row.original.stockMin ?? DASH,
      },
      {
        id: 'stockMax',
        header: t('items.columns.stockMax'),
        cell: ({ row }) => row.original.stockMax ?? DASH,
      },
      ...(purchasePrice.can
        ? [
            {
              id: 'basePurchasePrice',
              header: t('items.columns.basePurchasePrice'),
              cell: ({ row }: CellContext<Item, unknown>) =>
                row.original.basePurchasePrice ?? DASH,
            },
          ]
        : []),
      ...(salesPrice.can
        ? [
            {
              id: 'baseSalesPrice',
              header: t('items.columns.baseSalesPrice'),
              cell: ({ row }: CellContext<Item, unknown>) =>
                row.original.baseSalesPrice ?? DASH,
            },
          ]
        : []),
      {
        id: 'barcode',
        header: t('items.columns.barcode'),
        cell: ({ row }) => row.original.barcode ?? DASH,
      },
      {
        id: 'brand',
        header: t('items.columns.brand'),
        cell: ({ row }) => row.original.brand ?? DASH,
      },
      {
        id: 'manufacturerModel',
        header: t('items.columns.manufacturerModel'),
        cell: ({ row }) => row.original.manufacturerModel ?? DASH,
      },
      {
        id: 'auxUnitCode',
        header: t('items.columns.auxUnit'),
        cell: ({ row }) =>
          row.original.auxUnitCode === null
            ? DASH
            : unitName(dictionaries.data, row.original.auxUnitCode),
      },
      {
        id: 'unitRatio',
        header: t('items.columns.unitRatio'),
        cell: ({ row }) => row.original.unitRatio ?? DASH,
      },
      {
        id: 'purchaseLeadDays',
        header: t('items.columns.purchaseLeadDays'),
        cell: ({ row }) => row.original.purchaseLeadDays ?? DASH,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <ActiveBadge active={row.original.status === 'active'} />
        ),
      },
      // 没有写权限的人整列操作都不画。
      ...(canManage ? [actions] : []),
    ];
  }, [
    t,
    canManage,
    dictionaries.data,
    ask,
    activate,
    purchasePrice.can,
    salesPrice.can,
  ]);

  const typeOptions: readonly FilterOption[] = [
    { value: 'material', label: itemTypeLabel('material', t) },
    { value: 'product', label: itemTypeLabel('product', t) },
  ];
  const categoryFilter = list.filters.categoryCode ?? '';
  const categoryOptions = useMemo<FilterOption[]>(() => {
    const options = (dictionaries.data?.categories ?? []).map((category) => ({
      value: category.code,
      label: `${category.code} ${category.name}`,
    }));
    // 地址栏里的分类不在字典里（超过第一页）时也列出来，看得见当前值。
    if (
      categoryFilter &&
      !options.some((option) => option.value === categoryFilter)
    )
      options.push({ value: categoryFilter, label: categoryFilter });
    return options;
  }, [dictionaries.data, categoryFilter]);
  const applied = [list.filters.itemType, list.filters.categoryCode].filter(
    Boolean,
  ).length;

  return (
    <>
      <EntityTable
        list={list}
        columns={columns}
        canManage={canManage}
        getRowId={(item) => item.id}
        empty={t('items.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('items.searchLabel')}
          />
        }
        toolbar={
          <>
            <FilterToggle
              expanded={expanded}
              applied={applied}
              onClick={() => setExpanded((old) => !old)}
            />
            <IncludeInactiveFilter
              checked={list.includeInactive}
              onCheckedChange={list.setIncludeInactive}
            />
          </>
        }
        filterPanel={
          expanded ? (
            <FilterRow>
              <SelectFilter
                label={t('items.filters.itemType')}
                value={list.filters.itemType ?? ''}
                options={typeOptions}
                onChange={(value) => list.setFilter('itemType', value)}
              />
              <SelectFilter
                label={t('items.filters.category')}
                value={categoryFilter}
                options={categoryOptions}
                onChange={(value) => list.setFilter('categoryCode', value)}
              />
            </FilterRow>
          ) : undefined
        }
      />
      {dialog}
    </>
  );
}
