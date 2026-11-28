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
  InspectionsClient,
  type ReceivableInspection,
} from '../inspections/client.js';
import { INSPECTIONS_RESOURCE } from '../inspections/page-id.js';

/**
 * R-070：仓管建采购入库单时「从检验单选择」。只拿 `inspectionOrders.receiveView` 窄读，
 * 响应里没有备注、检验人、单价与联系方式；「已占用」按 remainder 显示，尚可入的数量带入草稿。
 */
export function InspectionPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (inspection: ReceivableInspection) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new InspectionsClient(api), [api]);
  const may = useCan({
    resource: INSPECTIONS_RESOURCE,
    action: 'receiveView',
  });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly ReceivableInspection[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !may.can) return;
    const controller = new AbortController();
    client
      .receivable({ q: query, page: 1, pageSize: 100 })
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

  const columns = useMemo<ColumnDef<ReceivableInspection>[]>(
    () => [
      {
        id: 'docNo',
        header: t('stockDocs.pickInspectionDocNo'),
        cell: ({ row }) => (
          <span className='font-medium tabular-nums'>{row.original.docNo}</span>
        ),
      },
      {
        id: 'inspectionDate',
        header: t('stockDocs.pickInspectionDate'),
        cell: ({ row }) => row.original.inspectionDate,
      },
      {
        id: 'remaining',
        header: t('stockDocs.pickInspectionRemaining'),
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
            aria-label={t('stockDocs.pickInspectionLine', { docNo: row.original.docNo })}
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
    [t, onPick, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-4xl'>
        <DialogHeader>
          <DialogTitle>{t('stockDocs.pickInspectionTitle')}</DialogTitle>
          <DialogDescription>{t('stockDocs.pickInspectionHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(q.trim());
          }}
          className='flex gap-2'
        >
          <Input
            aria-label={t('stockDocs.pickInspectionSearch')}
            placeholder={t('stockDocs.pickInspectionSearch')}
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
          <DataTable<ReceivableInspection>
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            emptyMessage={t('stockDocs.noInspectionsToPick')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
