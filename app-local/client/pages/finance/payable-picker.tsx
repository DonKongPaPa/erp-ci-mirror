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

import { FinanceClient, type PayableOrder } from './client.js';
import { PURCHASE_ORDERS_RESOURCE } from '../purchase-orders/page-id.js';

/** 选一张待付款的采购订单：窄形状，没有明细、单价、备注、经办人。 */
export function PayablePicker({
  open,
  onOpenChange,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (order: PayableOrder) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new FinanceClient(api), [api]);
  const financeView = useCan({
    resource: PURCHASE_ORDERS_RESOURCE,
    action: 'financeView',
  });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly PayableOrder[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !financeView.can) return;
    const controller = new AbortController();
    // 端点用 financeView 授权；没有这个动作时 useCan 已拦住，不发请求。
    client
      .payable({ q: query, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) {
          setError(undefined);
          setRows(page.items);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRows([]);
        }
      });
    return () => controller.abort();
  }, [open, financeView.can, client, query]);

  const columns = useMemo<ColumnDef<PayableOrder>[]>(
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
        id: 'supplier',
        header: t('finance.supplier'),
        cell: ({ row }) => row.original.supplier?.name ?? '—',
      },
      {
        id: 'unpaid',
        header: t('finance.unpaidAmount'),
        cell: ({ row }) => row.original.unpaidAmount ?? '—',
      },
      {
        id: 'pick',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <Button
            size='sm'
            variant='outline'
            aria-label={t('finance.pickOrder', { orderNo: row.original.orderNo })}
            onClick={() => {
              onPick(row.original);
              onOpenChange(false);
            }}
          >
            {t('finance.pick')}
          </Button>
        ),
      },
    ],
    [t, onPick, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-4xl'>
        <DialogHeader>
          <DialogTitle>{t('finance.pickOrderTitle')}</DialogTitle>
          <DialogDescription>{t('finance.pickOrderHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          className='flex gap-2'
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q.trim());
          }}
        >
          <Input
            aria-label={t('finance.pickOrderSearch')}
            placeholder={t('finance.pickOrderSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>
            {t('erp.list.filters')}
          </Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!financeView.can ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('erp.errors.denied')}
          </p>
        ) : (
          <DataTable<PayableOrder>
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            emptyMessage={t('finance.noPayableOrders')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
