import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

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

import { OrdersClient, type Order } from '../orders/client.js';
import { PURCHASE, SALES } from '../orders/kinds.js';
import type { SourceOption } from './client.js';
import { ReturnsClient } from './client.js';
import type { LineDraft } from './model.js';
import { returnResource, type ReturnKindDef } from './page-id.js';

export interface PickedSource {
  readonly sourceType: 'stock_doc' | 'order';
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly lines: readonly LineDraft[];
}

function key(): string {
  return `picked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 退货新建的来源选择：默认从已过账的出入库单选（有仓库与批次），
 * 也可以从订单发起（把已收 / 已发数量当快照，仓库取订单头，批次留空）。
 * 两个清单都是窄读：没有价格、备注、经办人。
 */
export function SourcePickerDialog({
  def,
  open,
  onOpenChange,
  onPick,
}: {
  readonly def: ReturnKindDef;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (source: PickedSource) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ReturnsClient(api, def), [api, def]);
  const orderDef = def.kind === 'purchase' ? PURCHASE : SALES;
  const orders = useMemo(() => new OrdersClient(api, orderDef), [api, orderDef]);
  const canViewReturn = useCan({ resource: returnResource(def), action: 'view' });
  const canViewOrder = useCan({ resource: orderDef.resource, action: 'view' });

  const [mode, setMode] = useState<'stock_doc' | 'order'>('stock_doc');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<readonly SourceOption[]>([]);
  const [orderRows, setOrderRows] = useState<readonly Order[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      try {
        if (mode === 'stock_doc') {
          if (!canViewReturn.can) return;
          const page = await client.sourceOptions({ q: query, pageSize: 100 });
          if (!controller.signal.aborted) {
            setSources(page.items);
            setError(undefined);
          }
        } else {
          if (!canViewOrder.can) return;
          const page = await orders.list({ q: query, pageSize: 100 });
          if (!controller.signal.aborted) {
            setOrderRows(page.items);
            setError(undefined);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => controller.abort();
  }, [open, mode, query, client, orders, canViewReturn.can, canViewOrder.can]);

  const pickSource = useCallback((source: SourceOption): void => {
    const lines: LineDraft[] = source.lines
      .filter((line) => line.remainQty > 0)
      .map((line) => ({
        key: key(),
        sourceLineId: line.sourceLineId,
        itemId: line.itemId,
        itemLabel: line.itemId,
        warehouseId: line.warehouseId,
        batchNo: line.batchNo,
        qty: line.remainQty,
        remainQty: line.remainQty,
        returnQty: '',
        note: '',
      }));
    onPick({ sourceType: 'stock_doc', sourceId: source.id, sourceLabel: source.docNo, lines });
    onOpenChange(false);
  }, [onPick, onOpenChange]);

  const pickOrder = useCallback((order: Order): void => {
    const lines: LineDraft[] = order.lines
      .filter((line) => line.doneQty > 0)
      .map((line) => ({
        key: key(),
        sourceLineId: line.id,
        itemId: line.itemId,
        itemLabel: line.itemId,
        warehouseId: order.warehouseId ?? '',
        batchNo: '',
        qty: line.doneQty,
        remainQty: line.doneQty,
        returnQty: '',
        note: '',
      }));
    onPick({ sourceType: 'order', sourceId: order.id, sourceLabel: order.orderNo, lines });
    onOpenChange(false);
  }, [onPick, onOpenChange]);

  const sourceColumns = useMemo<ColumnDef<SourceOption>[]>(
    () => [
      {
        id: 'docNo',
        header: t('returns.source.docNo'),
        cell: ({ row }) => <span className='font-medium tabular-nums'>{row.original.docNo}</span>,
      },
      {
        id: 'docDate',
        header: t('returns.source.docDate'),
        cell: ({ row }) => row.original.docDate ?? '—',
      },
      {
        id: 'partner',
        header: t('returns.source.partner'),
        cell: ({ row }) => row.original.partner?.name ?? '—',
      },
      {
        id: 'remain',
        header: t('returns.source.remain'),
        cell: ({ row }) =>
          row.original.lines.reduce((sum, line) => sum + Math.max(0, line.remainQty), 0),
      },
      {
        id: 'pick',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <Button
            size='sm'
            variant='outline'
            aria-label={t('returns.source.pick', { docNo: row.original.docNo })}
            onClick={() => pickSource(row.original)}
          >
            {t('returns.source.pickShort')}
          </Button>
        ),
      },
    ],
    [t, pickSource],
  );

  const orderColumns = useMemo<ColumnDef<Order>[]>(
    () => [
      {
        id: 'orderNo',
        header: t('returns.source.orderNo'),
        cell: ({ row }) => <span className='font-medium tabular-nums'>{row.original.orderNo}</span>,
      },
      {
        id: 'orderDate',
        header: t('returns.source.orderDate'),
        cell: ({ row }) => row.original.orderDate,
      },
      {
        id: 'done',
        header: t('returns.source.done'),
        cell: ({ row }) =>
          row.original.lines.reduce((sum, line) => sum + Math.max(0, line.doneQty), 0),
      },
      {
        id: 'pick',
        header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
        cell: ({ row }) => (
          <Button
            size='sm'
            variant='outline'
            aria-label={t('returns.source.pickOrder', { orderNo: row.original.orderNo })}
            onClick={() => pickOrder(row.original)}
          >
            {t('returns.source.pickShort')}
          </Button>
        ),
      },
    ],
    [t, pickOrder],
  );

  const denied = mode === 'stock_doc' ? !canViewReturn.can : !canViewOrder.can;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-4xl'>
        <DialogHeader>
          <DialogTitle>{t('returns.source.title')}</DialogTitle>
          <DialogDescription>{t('returns.source.hint')}</DialogDescription>
        </DialogHeader>
        <div className='flex gap-2'>
          <Button
            type='button'
            size='sm'
            variant={mode === 'stock_doc' ? 'default' : 'outline'}
            aria-pressed={mode === 'stock_doc'}
            onClick={() => setMode('stock_doc')}
          >
            {t('returns.source.modeDoc')}
          </Button>
          <Button
            type='button'
            size='sm'
            variant={mode === 'order' ? 'default' : 'outline'}
            aria-pressed={mode === 'order'}
            onClick={() => setMode('order')}
          >
            {t('returns.source.modeOrder')}
          </Button>
        </div>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q.trim());
          }}
          className='flex gap-2'
        >
          <Input
            aria-label={t('returns.source.search')}
            placeholder={t('returns.source.search')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>
            {t('erp.list.filters')}
          </Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {denied ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('erp.errors.denied')}
          </p>
        ) : mode === 'stock_doc' ? (
          <DataTable<SourceOption>
            columns={sourceColumns}
            data={sources}
            getRowId={(row) => row.id}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            emptyMessage={t('returns.source.empty')}
          />
        ) : (
          <DataTable<Order>
            columns={orderColumns}
            data={orderRows}
            getRowId={(row) => row.id}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            emptyMessage={t('returns.source.emptyOrders')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
