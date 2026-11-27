import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { ActiveBadge } from '#components/erp/detail';
import { IncludeInactiveFilter, ListSearch } from '#components/erp/list-page';
import { useEntityList } from '#components/erp/list-state';
import { RowActions } from '#components/row-actions';

import { ItemsClient, type Unit } from './client.js';
import { EntityTable } from './entity-table.js';
import type { ListAccess } from './page-id.js';
import { useStatusChange } from './status-change.js';

const editLink = (unit: Unit, search = '') =>
  `/items/units/${encodeURIComponent(unit.code)}/edit${search}`;

/**
 * 计量单位这一张表（`/items?view=units`）：编码、名称、小数位、状态。字段太少，不设详情，
 * 编辑在行尾「⋮」里。停用被物料引用的单位时服务端会拒绝，那句话写在确认框里。
 */
export function UnitList({
  canView,
  canManage,
  pending,
}: ListAccess): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const api = useApiClient();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const list = useEntityList<Unit>({
    path: 'units',
    inactiveParam: 'status',
    enabled: canView,
    pending,
  });
  const { ask, activate, dialog } = useStatusChange<Unit>({
    change: (unit, status) => client.updateUnit(unit.code, { status }),
    nameOf: (unit) => unit.name,
    noun: t('items.units.noun'),
    description: t('items.units.deactivateDescription'),
    reload: list.reload,
  });

  const columns = useMemo<ColumnDef<Unit>[]>(() => {
    const actions: ColumnDef<Unit> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Unit, unknown>) => {
        const unit = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: unit.name })}
            actions={
              unit.status === 'active'
                ? [
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: <Link to={editLink(unit, location.search)} />,
                    },
                    {
                      key: 'deactivate',
                      label: t('erp.actions.deactivate'),
                      destructive: true,
                      onClick: () => ask(unit),
                    },
                  ]
                : [
                    {
                      key: 'activate',
                      label: t('erp.actions.activate'),
                      onClick: () => activate(unit),
                    },
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: <Link to={editLink(unit, location.search)} />,
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
        id: 'decimals',
        header: t('items.columns.decimals'),
        // 数量右对齐。
        cell: ({ row }) => (
          <span className='block text-right tabular-nums'>
            {row.original.decimals}
          </span>
        ),
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
  }, [t, canManage, ask, activate, location.search]);

  return (
    <>
      <EntityTable
        list={list}
        columns={columns}
        canManage={canManage}
        getRowId={(unit) => unit.code}
        empty={t('items.units.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('items.units.searchLabel')}
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
