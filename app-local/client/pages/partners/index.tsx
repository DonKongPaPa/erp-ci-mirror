import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import { ActiveBadge, TypeBadge } from '#components/erp/detail';
import {
  IncludeInactiveFilter,
  ListPage,
  ListSearch,
  ListTabs,
  NewButton,
  ResultCount,
  type ListTab,
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

import { PartnersClient, type Partner, type PartnerKind } from './client.js';
import { kindNoun } from './model.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

/** 换标签就是换一组数据：搜索、页码、「含已停用」都清掉，只留标签。 */
const TAB_RESET_KEYS = ['q', 'page', 'pageSize', 'includeInactive'] as const;
/** 详情、编辑、抽屉里的子页都带着列表的查询串，关掉后回到原来的标签与筛选。 */
const detailLink = (partner: Partner, search = '') =>
  `/partners/${encodeURIComponent(partner.id)}${search}`;

/**
 * 客户与供应商（`/partners`，R-014）：一页两个标签。销售只看得到「客户」，采购只看得到「供应商」，
 * root 两个都有，各靠 customers.view、suppliers.view 显隐；同一家单位既买又卖时两个标签里都有它。
 */
export default function PartnersPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const customerView = useCan({ resource: CUSTOMERS_RESOURCE, action: 'view' });
  const supplierView = useCan({ resource: SUPPLIERS_RESOURCE, action: 'view' });
  const customerCreate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'create',
  });
  const supplierCreate = useCan({
    resource: SUPPLIERS_RESOURCE,
    action: 'create',
  });
  const customerUpdate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'update',
  });
  const supplierUpdate = useCan({
    resource: SUPPLIERS_RESOURCE,
    action: 'update',
  });
  const pending = customerView.isPending || supplierView.isPending;

  const tabs: readonly ListTab[] = [
    ...(customerView.can
      ? [{ key: 'customer', label: t('partners.kind.customer') }]
      : []),
    ...(supplierView.can
      ? [{ key: 'supplier', label: t('partners.kind.supplier') }]
      : []),
  ];
  // 地址栏里的标签是看不了的那一个（例如销售敲了 ?kind=supplier）时，退到看得见的第一个。
  const [params, setParams] = useSearchParams();
  const requested = params.get('kind');
  const kind: PartnerKind | undefined = tabs.some(
    (tab) => tab.key === requested,
  )
    ? (requested as PartnerKind)
    : (tabs[0]?.key as PartnerKind | undefined);
  const view = kind === 'supplier' ? supplierView : customerView;
  const canCreate =
    kind === 'supplier' ? supplierCreate.can : customerCreate.can;
  const canUpdate =
    kind === 'supplier' ? supplierUpdate.can : customerUpdate.can;

  const newLink = (() => {
    const next = new URLSearchParams(location.search);
    if (kind) next.set('kind', kind);
    return `/partners/new?${next.toString()}`;
  })();
  const list = useEntityList<Partner>({
    path: 'partners',
    fixed: kind ? { kind } : {},
    searchable: true,
    inactiveParam: 'status',
    enabled: kind ? view.can : false,
    // 权限没落定前不发请求：那会儿还不知道看得到哪个标签。
    pending,
  });
  const [stopping, setStopping] = useState<Partner>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 行上的启用与停用。停用先过下面的确认框。 */
  const run = async (partner: Partner, action: 'activate' | 'deactivate') => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.update(partner.id, {
        status: action === 'activate' ? 'active' : 'inactive',
      });
      toaster.show({
        type: 'success',
        title:
          action === 'activate'
            ? t('partners.activatedToast', { name: partner.name })
            : t('partners.deactivatedToast', { name: partner.name }),
      });
      setStopping(undefined);
      list.reload();
    } catch (error) {
      // 停用有确认框，错写在框里；启用没有，错用提示说。
      const text = errorText(error, t);
      if (action === 'deactivate') setActionError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
    }
  };
  // 行上的操作调用最新的一份 run；列定义保持是同一个引用，重新取数时不会重装操作格。
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const columns = useMemo<ColumnDef<Partner>[]>(() => {
    const actions: ColumnDef<Partner> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Partner, unknown>) => {
        const partner = row.original;
        // 这一行没有能改的类型时，「⋮」整个不画。
        const editable =
          (partner.isCustomer && customerUpdate.can) ||
          (partner.isSupplier && supplierUpdate.can);
        if (!editable) return null;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: partner.name })}
            actions={
              partner.status === 'active'
                ? [
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: (
                        <Link
                          to={`${detailLink(partner, location.search)}/edit`}
                        />
                      ),
                    },
                    {
                      key: 'deactivate',
                      label: t('erp.actions.deactivate'),
                      destructive: true,
                      onClick: () => setStopping(partner),
                    },
                  ]
                : [
                    {
                      key: 'activate',
                      label: t('erp.actions.activate'),
                      onClick: () => void runRef.current(partner, 'activate'),
                    },
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: (
                        <Link
                          to={`${detailLink(partner, location.search)}/edit`}
                        />
                      ),
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
          <RecordLink to={detailLink(row.original, location.search)}>
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
        id: 'kinds',
        header: t('erp.fields.type'),
        cell: ({ row }) => (
          <span className='flex flex-wrap items-center gap-1'>
            {row.original.isCustomer ? (
              <TypeBadge>{t('partners.kind.customer')}</TypeBadge>
            ) : null}
            {row.original.isSupplier ? (
              <TypeBadge>{t('partners.kind.supplier')}</TypeBadge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'contactName',
        header: t('erp.fields.contact'),
        cell: ({ row }) =>
          row.original.contactName ?? (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <ActiveBadge active={row.original.status === 'active'} />
        ),
      },
      // 没有任何一行的写权限时整列操作都不画。
      ...(canUpdate ? [actions] : []),
    ];
  }, [
    t,
    canUpdate,
    customerUpdate.can,
    supplierUpdate.can,
    setStopping,
    location.search,
  ]);

  const skeleton = list.skeleton;
  return (
    <ListPage
      title={t('partners.title')}
      description={t('partners.description')}
      actions={
        canCreate && kind ? (
          <NewButton
            to={newLink}
            label={t('partners.newKind', { kind: kindNoun(kind, t) })}
          />
        ) : undefined
      }
      tabs={
        <ListTabs
          items={tabs}
          value={kind ?? ''}
          onChange={(key) =>
            setParams(
              (old) => {
                const next = new URLSearchParams(old);
                for (const reset of TAB_RESET_KEYS) next.delete(reset);
                next.set('kind', key);
                return next;
              },
              { replace: true },
            )
          }
        />
      }
    >
      <DataTable<Partner>
        columns={
          skeleton
            ? skeletonColumns(
                columns,
                (row) => t('erp.list.loadingRow', { row }),
                canUpdate,
              )
            : columns
        }
        data={skeleton ? skeletonRows<Partner>(SKELETON_ROW_COUNT) : list.rows}
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
        onClearFilters={list.clearable ? list.clearFilters : undefined}
        filtered={list.filtered}
        pagination={!skeleton}
        showSelectedCount={false}
        emptyMessage={t('partners.empty')}
        search={
          <ListSearch
            value={list.q}
            onSearch={list.setSearch}
            label={t('partners.searchLabel')}
          />
        }
        toolbar={() => (
          <IncludeInactiveFilter
            checked={list.includeInactive}
            onCheckedChange={list.setIncludeInactive}
          />
        )}
        summary={<ResultCount count={list.total} />}
      />
      <ConfirmDialog
        open={stopping !== undefined}
        title={t('partners.deactivateTitle', { name: stopping?.name ?? '' })}
        description={t('partners.deactivateDescription')}
        confirmLabel={t('erp.actions.deactivate')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setStopping(undefined)}
        onConfirm={() => {
          if (stopping) void runRef.current(stopping, 'deactivate');
        }}
      />
      {/* 新建与详情抽屉（及其上的对话框）从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}
