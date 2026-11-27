import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Link } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import { ActiveBadge } from '#components/erp/detail';
import {
  IncludeInactiveFilter,
  ListSearch,
} from '#components/erp/list-page';
import {
  SKELETON_ROW_COUNT,
  skeletonColumns,
  skeletonRows,
} from '#components/erp/list-skeleton';
import { useEntityList } from '#components/erp/list-state';
import { errorText } from '#components/erp/messages';
import { RowActions } from '#components/row-actions';
import { StatusBadge } from '#components/status-badge';

import { BizDictClient, type Entry } from './client.js';
import { usesProjectFields, usesRate } from './model.js';
import type { ListAccess } from './page-id.js';

const DASH = <span className='text-muted-foreground'>—</span>;
const detailLink = (entry: Entry, dictType: string) =>
  `/biz-dict/${encodeURIComponent(entry.id)}/edit?type=${encodeURIComponent(dictType)}`;

/**
 * 当前类型的取值表（R-072）：首列是码，行尾「⋮」里是编辑、上移下移、停用（启用）。
 * 没有删除；停用先过确认框，端点只回在用/停用状态由工具栏的「含已停用」控制。
 */
export function DictList({
  dictType,
  canManage,
  pending,
}: ListAccess): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new BizDictClient(api), [api]);
  const list = useEntityList<Entry>({
    path: 'biz-dict/entries',
    fixed: { dictType },
    searchable: true,
    inactiveParam: 'status',
    pending,
  });
  const [stopping, setStopping] = useState<Entry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (entry: Entry, status: 'active' | 'inactive') => {
    setBusy(true);
    setError(undefined);
    try {
      await client.update(entry.id, { status });
      toaster.show({
        type: 'success',
        title:
          status === 'inactive'
            ? t('bizDict.deactivatedToast', { name: entry.name })
            : t('bizDict.activatedToast', { name: entry.name }),
      });
      setStopping(undefined);
      list.reload();
    } catch (next) {
      const text = errorText(next, t);
      if (status === 'inactive') setError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
    }
  };
  // 列定义要稳：重新取数时操作格不能被卸下重装，所以经 ref 拿最新的一组动作。
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const reorder = async (from: number, to: number) => {
    if (to < 0 || to >= list.rows.length) return;
    const ids = list.rows.map((row) => row.id);
    const [moved] = ids.splice(from, 1);
    if (moved === undefined) return;
    ids.splice(to, 0, moved);
    try {
      await client.reorder(dictType, ids);
      list.reload();
    } catch (next) {
      toaster.show({ type: 'error', title: errorText(next, t) });
    }
  };
  const reorderRef = useRef(reorder);
  useEffect(() => {
    reorderRef.current = reorder;
  });

  const columns = useMemo<ColumnDef<Entry>[]>(() => {
    const actions: ColumnDef<Entry> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row, table }: CellContext<Entry, unknown>) => {
        const entry = row.original;
        const index = table.getRowModel().rows.findIndex(
          (candidate) => candidate.id === row.id,
        );
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: entry.name })}
            actions={[
              {
                key: 'edit',
                label: t('erp.actions.edit'),
                render: <Link to={detailLink(entry, dictType)} />,
              },
              {
                key: 'moveUp',
                label: t('bizDict.actions.moveUp'),
                disabled: index <= 0,
                onClick: () => void reorderRef.current(index, index - 1),
              },
              {
                key: 'moveDown',
                label: t('bizDict.actions.moveDown'),
                disabled: index < 0 || index >= list.rows.length - 1,
                onClick: () => void reorderRef.current(index, index + 1),
              },
              entry.status === 'active'
                ? {
                    key: 'deactivate',
                    label: t('erp.actions.deactivate'),
                    destructive: true,
                    onClick: () => setStopping(entry),
                  }
                : {
                    key: 'activate',
                    label: t('erp.actions.activate'),
                    onClick: () => void runRef.current(entry, 'active'),
                  },
            ]}
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
      ...(usesRate(dictType)
        ? [
            {
              id: 'rate',
              header: t('bizDict.fields.rate'),
              cell: ({ row }: CellContext<Entry, unknown>) =>
                row.original.rate === null ? DASH : row.original.rate,
            },
          ]
        : []),
      ...(usesProjectFields(dictType)
        ? [
            {
              id: 'period',
              header: t('bizDict.fields.startDate'),
              cell: ({ row }: CellContext<Entry, unknown>) =>
                row.original.startDate === null && row.original.endDate === null
                  ? DASH
                  : `${row.original.startDate ?? '—'} – ${row.original.endDate ?? '—'}`,
            },
          ]
        : []),
      {
        id: 'isDefault',
        header: t('bizDict.fields.isDefault'),
        cell: ({ row }) =>
          row.original.isDefault ? (
            <StatusBadge size='sm' tone='info'>
              {t('bizDict.fields.isDefault')}
            </StatusBadge>
          ) : (
            DASH
          ),
      },
      {
        id: 'sort',
        header: t('bizDict.fields.sort'),
        cell: ({ row }) => row.original.sort,
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
  }, [t, dictType, canManage, list.rows.length]);

  const skeleton = list.skeleton;
  return (
    <>
      <DataTable<Entry>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canManage,
              )
            : columns
        }
        data={skeleton ? skeletonRows<Entry>(SKELETON_ROW_COUNT) : list.rows}
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
        onClearFilters={list.clearable ? list.clearFilters : undefined}
        filtered={list.filtered}
        pagination={!skeleton}
        showSelectedCount={false}
        emptyMessage={t('bizDict.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('bizDict.searchLabel')}
          />
        }
        toolbar={() => (
          <IncludeInactiveFilter
            checked={list.includeInactive}
            onCheckedChange={list.setIncludeInactive}
          />
        )}
      />
      <ConfirmDialog
        open={stopping !== undefined}
        title={t('bizDict.actions.deactivateTitle', {
          name: stopping?.name ?? '',
        })}
        description={t('bizDict.actions.deactivateDescription')}
        confirmLabel={t('erp.actions.deactivate')}
        error={error ? <span role='alert'>{error}</span> : undefined}
        busy={busy}
        onCancel={() => setStopping(undefined)}
        onConfirm={() => {
          if (stopping) void runRef.current(stopping, 'inactive');
        }}
      />
    </>
  );
}
