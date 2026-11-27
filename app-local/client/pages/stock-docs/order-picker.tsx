import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { DataTable } from '#components/data-table';
import { FeedbackForm } from '#components/feedback-form';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';

import {
  OrdersClient,
  type NarrowOrder,
} from '../orders/client.js';
import { PURCHASE, SALES } from '../orders/kinds.js';
import type { StockKind } from './kind.js';

/**
 * 仓管在入库单、出库单上「从采购订单选择」「从销售订单选择」（R-020 加片）。
 * 读的是窄形状端点：订单里没有价格、金额、备注、经办人，只有收货/发货要素。
 * 选一张后把仍有剩余的行带进当前草稿，并记下来源单据，保存时由服务端校验行与数量。
 */
export function OrderPickerDialog({
  def,
  open,
  onOpenChange,
  onPick,
}: {
  readonly def: StockKind;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (order: NarrowOrder) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(
    () => new OrdersClient(api, def.kind === 'in' ? PURCHASE : SALES),
    [api, def.kind],
  );
  const resource = def.kind === 'in' ? PURCHASE.resource : SALES.resource;
  const narrowAction = def.kind === 'in' ? 'receive' : 'ship';
  const may = useCan({ resource, action: narrowAction });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly NarrowOrder[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !may.can) return;
    const controller = new AbortController();
    client
      .receivable({ q: query, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) {
          setError(undefined);
          setRows(page.items);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [open, may.can, client, query]);

  const columns = useMemo<ColumnDef<NarrowOrder>[]>(
    () => [
      {
        id: 'orderNo',
        header: t('orderDocs.fields.orderNo'),
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.orderNo}</span>
        ),
      },
      {
        id: 'orderDate',
        header: t('orderDocs.fields.orderDate'),
        cell: ({ row }) => row.original.orderDate,
      },
      {
        id: 'partner',
        header: t(`${def.kind === 'in' ? 'purchaseOrders' : 'salesOrders'}.partnerLabel`),
        cell: ({ row }) =>
          (row.original.supplier ?? row.original.customer)?.name ?? '—',
      },
      {
        id: 'remaining',
        header: t(`${def.kind === 'in' ? 'purchaseOrders' : 'salesOrders'}.actions.remaining`),
        cell: ({ row }) =>
          row.original.lines.reduce(
            (sum, line) => sum + Math.max(0, line.remainingQty),
            0,
          ),
      },
      {
        id: 'pick',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <Button
            size='sm'
            variant='outline'
            aria-label={t('stockDocs.pickOrder', { orderNo: row.original.orderNo })}
            onClick={() => {
              onPick(row.original);
              onOpenChange(false);
            }}
          >
            {t('stockDocs.pick')}
          </Button>
        ),
      },
    ],
    [t, def.kind, onPick, onOpenChange],
  );

  const title = t(
    def.kind === 'in' ? 'stockDocs.pickPurchaseOrder' : 'stockDocs.pickSalesOrder',
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-4xl'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('stockDocs.pickOrderHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q.trim());
          }}
          className='flex gap-2'
        >
          <Input
            aria-label={t('stockDocs.pickOrderSearch')}
            placeholder={t('stockDocs.pickOrderSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>
            {t('erp.list.filters')}
          </Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!may.can ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('erp.errors.denied')}
          </p>
        ) : (
          <DataTable<NarrowOrder>
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            emptyMessage={t('stockDocs.noOrdersToPick')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
