import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  Link,
  Outlet,
  useLocation,
  useParams,
  useResolvedPath,
} from 'react-router';

import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
  LinesTable,
} from '#components/erp/document';
import { ConfirmDialog } from '#components/erp/confirm';
import { errorText, type Translate } from '#components/erp/messages';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { TableCell } from '#components/ui/table';

import { useAncestorSearch } from '../../routing/route-context.js';
import { OrdersClient, type Order, type OrderLine } from './client.js';
import { useOrder } from './record.js';
import { Dash, ItemCell, OrderStatusBadge } from './fields.js';
import { ORDER_LIST_KEYS, type OrderKindDef } from './kinds.js';
import {
  formatAmount,
  formatDateTime,
  formatNumber,
  lineAmount,
  orderTotal,
} from './model.js';
import { useReferencePage, type Item } from './reference.js';

/** 数量、单价：只管千分位，最多四位小数。 */
function number(value: number, locale: string): ReactNode {
  return <span className='tabular-nums'>{formatNumber(value, locale)}</span>;
}

function money(
  value: number | undefined,
  locale: string,
  t: Translate,
): ReactNode {
  return value === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>
      {t('orderDocs.money', { amount: formatAmount(value, locale) })}
    </span>
  );
}

interface BreadcrumbLevel {
  readonly label: ReactNode;
  readonly to?: { readonly pathname: string; readonly search: string };
}

/** 详情交给它的子页（编辑）的面包屑：列表那一级带着列表的查询串，记录那一级是单号。 */
export interface OrderOutletContext {
  readonly listLevel: BreadcrumbLevel;
  readonly recordLevel: BreadcrumbLevel;
}

/**
 * 一张订单的子页（《基座ERP前端设计》2.4、3.4、3.5）：盖在列表上，页头是单号、状态徽标和这一刻能做的操作，
 * 下面是状态条、表头（往来单位、单据日期、提交时间、备注）、明细与合计金额。
 * 下单（确认）之后明细锁定；生成入库单（出库单）是这里的一个对话框；取消订单先弹确认框。
 * 每个操作按动作判权限，不看角色名（设计 2.7）。
 */
export function OrderDetailPage({
  def,
}: {
  readonly def: OrderKindDef;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const orderId = useParams()[def.param] ?? '';
  const client = useMemo(() => new OrdersClient(api, def), [api, def]);
  const view = useCan({ resource: def.resource, action: 'view' });
  const update = useCan({ resource: def.resource, action: 'update' });
  const submit = useCan({ resource: def.resource, action: 'submit' });
  const cancel = useCan({ resource: def.resource, action: 'cancel' });
  const make = useCan({ resource: def.resource, action: def.makeAction });
  const itemsView = useCan({
    resource: { type: 'composite', id: 'items' },
    action: 'view',
  });
  const record = useOrder(def, orderId, view.can);
  // 明细行只有物料 id，名字、规格、单位要拿物料列表来对。
  const items = useReferencePage<Item>('items', itemsView.can);
  const order = record.data;

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t(`navigation.${def.l}`),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, ORDER_LIST_KEYS),
    },
  };
  const recordLevel = {
    label: order?.orderNo ?? t(`${def.l}.detailTitle`),
  };
  // 读不到、读失败时也留着「采购订单 › 这一张单」这两级（navigation.md）。
  usePageBreadcrumb([listLevel, recordLevel]);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  /** 提交（下单 / 确认）与取消订单。取消有确认框，错写在框里；提交被拒用提示说。 */
  const act = async (action: 'submit' | 'cancel'): Promise<void> => {
    if (!order) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await client[action](order.id);
      toaster.show({
        type: 'success',
        title:
          action === 'submit'
            ? t(`${def.l}.submittedToast`, { name: order.orderNo })
            : t(`${def.l}.cancelledToast`, { name: order.orderNo }),
      });
      setConfirming(false);
    } catch (next) {
      const text = errorText(next, t);
      if (action === 'cancel') setActionError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
      // 成功或被拒，这一张单都可能不是加载时的样子了：重新读一次。
      record.reload();
    }
  };

  const itemsById = useMemo(
    () => new Map((items.items ?? []).map((item) => [item.id, item] as const)),
    [items.items],
  );
  const columns = useMemo<ColumnDef<OrderLine>[]>(
    () => [
      {
        id: 'index',
        header: '#',
        cell: ({ row }) => (
          <span className='text-muted-foreground tabular-nums'>
            {row.index + 1}
          </span>
        ),
      },
      {
        id: 'item',
        header: t('orderDocs.fields.item'),
        cell: ({ row }) => (
          <ItemCell item={itemsById.get(row.original.itemId)} />
        ),
      },
      {
        id: 'unit',
        header: t('orderDocs.fields.unit'),
        cell: ({ row }) =>
          itemsById.get(row.original.itemId)?.unitCode ?? <Dash />,
      },
      {
        id: 'price',
        header: t('orderDocs.fields.price'),
        cell: ({ row }) =>
          row.original.price === null ? (
            <Dash />
          ) : (
            number(row.original.price, locale)
          ),
      },
      {
        id: 'qty',
        header: t('orderDocs.fields.qty'),
        cell: ({ row }) => number(row.original.qty, locale),
      },
      {
        id: 'done',
        header: t(`${def.l}.actions.done`),
        cell: ({ row }) => number(row.original.doneQty, locale),
      },
      {
        id: 'remaining',
        header: t(`${def.l}.actions.remaining`),
        cell: ({ row }) => number(row.original.remainingQty, locale),
      },
      {
        id: 'amount',
        header: t('orderDocs.fields.amount'),
        cell: ({ row }) => money(lineAmount(row.original), locale, t),
      },
    ],
    [t, def.l, itemsById, locale],
  );

  const statusBar = (
    tone: 'neutral' | 'info' | 'destructive',
    node: ReactNode,
  ): ReactElement => <DocumentStatusBar tone={tone}>{node}</DocumentStatusBar>;
  let status: ReactNode;
  if (!view.isPending && !view.can)
    status = statusBar('destructive', t('erp.errors.denied'));
  else if (!order)
    status = statusBar(
      'destructive',
      record.error !== undefined ? (
        errorText(record.error, t)
      ) : (
        <p role='status'>{t('status.loading')}</p>
      ),
    );
  else
    status = (
      <DocumentStatusBar
        tone={
          order.status === 'ordered' || order.status === 'partial'
            ? 'info'
            : 'neutral'
        }
      >
        <span className='flex min-w-0 flex-col gap-1'>
          <span>{orderStatusText(order, def, t)}</span>
          {/* 全部数量都生成过入库单（出库单）还没过账：剩余为 0 而已到货为 0。 */}
          {order.status === 'ordered' &&
          order.lines.length > 0 &&
          order.lines.every((line) => line.remainingQty <= 0) ? (
            <span className='text-muted-foreground'>
              {t(`${def.l}.statusBar.issued`)}
            </span>
          ) : null}
        </span>
      </DocumentStatusBar>
    );

  const base = `${def.path}/${encodeURIComponent(order?.id ?? orderId)}`;
  const search = location.search;
  const actions =
    order &&
    (order.status === 'draft' || order.status === 'ordered') &&
    cancel.can ? (
      <Button
        variant='outline'
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {t('orderDocs.actions.cancelOrder')}
      </Button>
    ) : null;

  return (
    <>
      <DocumentPage
        title={recordLevel.label}
        badge={order ? <OrderStatusBadge def={def} order={order} /> : undefined}
        actions={
          order ? (
            <>
              {actions}
              {order.status === 'draft' && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search }} />}
                >
                  {t('erp.actions.edit')}
                </Button>
              ) : null}
              {order.status === 'draft' && submit.can ? (
                <PendingButton busy={busy} onClick={() => void act('submit')}>
                  {t(`${def.l}.actions.submit`)}
                </PendingButton>
              ) : null}
              {(order.status === 'ordered' || order.status === 'partial') &&
              make.can ? (
                <Button
                  nativeButton={false}
                  render={
                    <Link
                      to={{ pathname: `${base}/${def.makeSegment}`, search }}
                    />
                  }
                >
                  {t(`${def.l}.actions.make`)}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
        status={status}
      >
        {order ? (
          <>
            <DocumentSection title={t('orderDocs.form.header')}>
              <DocumentHeaderFields
                fields={[
                  {
                    label: t(`${def.l}.partnerLabel`),
                    value: order.partner?.name,
                  },
                  {
                    label: t('orderDocs.fields.orderDate'),
                    value: order.orderDate,
                  },
                  {
                    label: t('orderDocs.fields.submittedAt'),
                    value: order.submittedAt
                      ? formatDateTime(order.submittedAt, locale)
                      : undefined,
                  },
                  {
                    label: t('erp.fields.note'),
                    value: order.remark,
                    wide: true,
                  },
                ]}
              />
            </DocumentSection>
            <DocumentSection title={t('orderDocs.fields.lines')}>
              <LinesTable<OrderLine>
                columns={columns}
                rows={order.lines}
                getRowId={(line) => line.id}
                totals={
                  orderTotal(order.lines) === undefined ? undefined : (
                    <>
                      <TableCell colSpan={7} className='text-right font-medium'>
                        {t('orderDocs.fields.totalAmount')}
                      </TableCell>
                      <TableCell className='text-right font-medium'>
                        {money(orderTotal(order.lines), locale, t)}
                      </TableCell>
                    </>
                  )
                }
                emptyMessage={t('orderDocs.form.linesEmpty')}
              />
            </DocumentSection>
          </>
        ) : null}
      </DocumentPage>
      <ConfirmDialog
        open={confirming}
        title={t(`${def.l}.cancelTitle`, { name: order?.orderNo ?? '' })}
        description={t(`${def.l}.cancelDescription`)}
        confirmLabel={t('orderDocs.actions.cancelOrder')}
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void act('cancel')}
      />
      {/* 编辑的子页与生成出入库单的对话框从这里出来：放在子页旁边，下一层盖住这一层。 */}
      <Outlet
        context={{ listLevel, recordLevel } satisfies OrderOutletContext}
      />
    </>
  );
}

function orderStatusText(
  order: Order,
  def: OrderKindDef,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const total = order.lines.length;
  switch (order.status) {
    case 'draft':
      return t(`${def.l}.statusBar.draft`);
    case 'ordered':
      return t(`${def.l}.statusBar.ordered`);
    case 'partial': {
      const done = order.lines.filter(
        (line) => line.doneQty >= line.qty,
      ).length;
      return t(`${def.l}.statusBar.partial`, {
        done,
        total,
        remaining: total - done,
      });
    }
    case 'done':
      return t(`${def.l}.statusBar.done`, { total });
    case 'cancelled':
      return t(`${def.l}.statusBar.cancelled`);
    default:
      return order.apiStatus;
  }
}
