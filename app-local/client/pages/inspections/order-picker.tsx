import { useApiClient } from '@nocobase/app-client';
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

import { InspectionsClient, type OrderOption } from './client.js';

/**
 * 质量员在新建检验单时「从采购订单选行」。读的是窄端点：订单里没有单价、金额、
 * 经办人与联系方式，只有单号、日期、供应商摘要与可检明细。
 */
export function InspectionOrderPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (order: OrderOption) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new InspectionsClient(api), [api]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly OrderOption[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    client
      .orderOptions({ q: query, page: 1, pageSize: 100 })
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
  }, [open, client, query]);

  const columns = useMemo<ColumnDef<OrderOption>[]>(
    () => [
      {
        id: 'orderNo',
        header: t('inspections.fields.purchaseOrder'),
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.orderNo}</span>
        ),
      },
      {
        id: 'orderDate',
        header: t('inspections.fields.inspectionDate'),
        cell: ({ row }) => row.original.orderDate,
      },
      {
        id: 'supplier',
        header: t('inspections.fields.supplier'),
        cell: ({ row }) => row.original.supplier?.name ?? '—',
      },
      {
        id: 'lines',
        header: t('inspections.fields.lines'),
        cell: ({ row }) => row.original.lines.length,
      },
      {
        id: 'pick',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <Button
            size='sm'
            variant='outline'
            aria-label={t('inspections.pickOrder', { orderNo: row.original.orderNo })}
            onClick={() => {
              onPick(row.original);
              onOpenChange(false);
            }}
          >
            {t('inspections.pick')}
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
          <DialogTitle>{t('inspections.pickPurchaseOrder')}</DialogTitle>
          <DialogDescription>{t('inspections.pickOrderHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q.trim());
          }}
          className='flex gap-2'
        >
          <Input
            aria-label={t('inspections.pickOrderSearch')}
            placeholder={t('inspections.pickOrderSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>
            {t('erp.list.filters')}
          </Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        <DataTable<OrderOption>
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          pagination={false}
          showSelectedCount={false}
          sortableColumns={[]}
          emptyMessage={t('inspections.noOrdersToPick')}
        />
      </DialogContent>
    </Dialog>
  );
}
