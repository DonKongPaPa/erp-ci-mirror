import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';

import { ActiveBadge } from '#components/erp/detail';
import { IncludeInactiveFilter, ListSearch } from '#components/erp/list-page';
import { useEntityList } from '#components/erp/list-state';
import { RowActions } from '#components/row-actions';

import { ItemsClient, type Category } from './client.js';
import { parentName, useItemDictionaries } from './dictionaries.js';
import { EntityTable } from './entity-table.js';
import type { ListAccess } from './page-id.js';
import { useStatusChange } from './status-change.js';

const DASH = <span className='text-muted-foreground'>—</span>;
const editLink = (category: Category) =>
  `/items/categories/${encodeURIComponent(category.id)}/edit`;

/**
 * 物料分类这一张表（`/items?view=categories`）：第一版只有一层，上级分类一列对不出上级时留空。
 * 字段太少，不设详情，编辑在行尾「⋮」里。
 */
export function CategoryList({
  canView,
  canManage,
  pending,
}: ListAccess): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ItemsClient(api), [api]);
  // 上级分类一列只有 id，名字要从字典里对出来。
  const dictionaries = useItemDictionaries(canView, pending);
  const list = useEntityList<Category>({
    path: 'item-categories',
    inactiveParam: 'status',
    enabled: canView,
    pending,
  });
  const { ask, activate, dialog } = useStatusChange<Category>({
    change: (category, status) =>
      client.updateCategory(category.id, { status }),
    nameOf: (category) => category.name,
    noun: t('items.categories.noun'),
    description: t('items.categories.deactivateDescription'),
    reload: list.reload,
  });

  const columns = useMemo<ColumnDef<Category>[]>(() => {
    const actions: ColumnDef<Category> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Category, unknown>) => {
        const category = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: category.name })}
            actions={
              category.status === 'active'
                ? [
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: <Link to={editLink(category)} />,
                    },
                    {
                      key: 'deactivate',
                      label: t('erp.actions.deactivate'),
                      destructive: true,
                      onClick: () => ask(category),
                    },
                  ]
                : [
                    {
                      key: 'activate',
                      label: t('erp.actions.activate'),
                      onClick: () => activate(category),
                    },
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: <Link to={editLink(category)} />,
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
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.code}</span>
        ),
      },
      {
        id: 'name',
        header: t('erp.fields.name'),
        cell: ({ row }) => row.original.name,
      },
      {
        id: 'sort',
        header: t('items.categories.sort'),
        cell: ({ row }) => row.original.sort,
      },
      {
        id: 'parentId',
        header: t('items.columns.parent'),
        cell: ({ row }) =>
          parentName(dictionaries.data, row.original.parentId) ?? DASH,
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <ActiveBadge active={row.original.status === 'active'} />
        ),
      },
      ...(canManage ? [actions] : []),
    ];
  }, [t, canManage, dictionaries.data, ask, activate]);

  return (
    <>
      <EntityTable
        list={list}
        columns={columns}
        canManage={canManage}
        getRowId={(category) => category.id}
        empty={t('items.categories.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('items.categories.searchLabel')}
          />
        }
        toolbar={
          <IncludeInactiveFilter
            checked={list.includeInactive}
            onCheckedChange={list.setIncludeInactive}
          />
        }
      />
      {dialog}
    </>
  );
}
