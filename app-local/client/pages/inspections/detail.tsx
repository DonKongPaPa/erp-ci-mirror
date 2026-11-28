import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useParams, useResolvedPath } from 'react-router';

import { ActionGlyph } from '#components/action-glyph';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
  LinesTable,
} from '#components/erp/document';
import type { DetailField } from '#components/erp/detail';
import { errorText } from '#components/erp/messages';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { TableCell } from '#components/ui/table';

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatNumber } from '../orders/model.js';
import {
  InspectionsClient,
  type InspectionLine,
} from './client.js';
import { Dash, InspectionStatusBadge } from './fields.js';
import {
  INSPECTIONS_LIST_KEYS,
  INSPECTIONS_RESOURCE,
} from './page-id.js';
import { useInspection } from './record.js';

/** 数量最多四位小数；服务端没算出来的画「—」，不当成 0。 */
function number(value: number, locale: string): ReactNode {
  return value === undefined || value === null ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>{formatNumber(value, locale)}</span>
  );
}

/**
 * 一张检验单的详情：表头、明细与算列、可入库数量与这一刻能做的操作。
 * 「完成检验」只对质量员显隐，「作废」只对质量主管显隐；采购只看得到数据。
 */
export default function InspectionDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const id = useParams().inspectionId ?? '';
  const client = useMemo(() => new InspectionsClient(api), [api]);
  const view = useCan({ resource: INSPECTIONS_RESOURCE, action: 'view' });
  const update = useCan({ resource: INSPECTIONS_RESOURCE, action: 'update' });
  const complete = useCan({ resource: INSPECTIONS_RESOURCE, action: 'complete' });
  const voiding = useCan({ resource: INSPECTIONS_RESOURCE, action: 'void' });
  const record = useInspection(id, view.can);
  const inspection = record.data;
  const editable = inspection?.status === 'pending';

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.inspections'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, INSPECTIONS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: inspection?.docNo ?? t('inspections.detailTitle') },
  ]);

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const act = async (kind: 'complete' | 'void'): Promise<void> => {
    if (!inspection) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await client[kind](inspection.id);
      toaster.show({
        type: 'success',
        title: t(
          kind === 'void'
            ? 'inspections.toasts.voided'
            : 'inspections.toasts.completed',
          { name: inspection.docNo },
        ),
      });
      setConfirming(false);
    } catch (next) {
      const text = errorText(next, t);
      if (kind === 'void') setActionError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
      record.reload();
    }
  };

  const columns = useMemo<ColumnDef<InspectionLine>[]>(
    () => [
      {
        id: 'index',
        header: '#',
        cell: ({ row }) => (
          <span className='text-muted-foreground tabular-nums'>{row.index + 1}</span>
        ),
      },
      {
        id: 'item',
        header: t('inspections.fields.item'),
        cell: ({ row }) => (
          <span className='flex min-w-0 flex-col'>
            <span className='font-medium tabular-nums'>{row.original.item.code}</span>
            <span className='wrap-anywhere'>{row.original.item.name}</span>
            {row.original.item.spec ? (
              <span className='wrap-anywhere text-muted-foreground'>
                {row.original.item.spec}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'unit',
        header: t('inspections.fields.unit'),
        cell: ({ row }) => row.original.item.unitCode || <Dash />,
      },
      { id: 'purchaseQty', header: t('inspections.fields.purchaseQty'), cell: ({ row }) => number(row.original.purchaseQty, locale) },
      { id: 'receivedQty', header: t('inspections.fields.receivedQty'), cell: ({ row }) => number(row.original.receivedQty, locale) },
      { id: 'inspectionQty', header: t('inspections.fields.inspectionQty'), cell: ({ row }) => number(row.original.inspectionQty, locale) },
      { id: 'qualifiedQty', header: t('inspections.fields.qualifiedQty'), cell: ({ row }) => number(row.original.qualifiedQty, locale) },
      { id: 'unqualifiedQty', header: t('inspections.fields.unqualifiedQty'), cell: ({ row }) => number(row.original.unqualifiedQty, locale) },
      { id: 'returnQty', header: t('inspections.fields.returnQty'), cell: ({ row }) => number(row.original.returnQty, locale) },
      {
        id: 'samplingQty',
        header: t('inspections.fields.samplingQty'),
        cell: ({ row }) => number(row.original.samplingQty, locale),
      },
      {
        id: 'samplingQualifiedQty',
        header: t('inspections.fields.samplingQualifiedQty'),
        cell: ({ row }) => number(row.original.samplingQualifiedQty, locale),
      },
      {
        id: 'releasableQty',
        header: t('inspections.fields.releasableQty'),
        cell: ({ row }) => (
          <span data-testid={`detail-releasable-${row.index}`} className='font-medium tabular-nums'>
            {number(row.original.releasableQty, locale)}
          </span>
        ),
      },
    ],
    [t, locale],
  );

  let status: ReactNode;
  if (!view.isPending && !view.can)
    status = (
      <DocumentStatusBar tone='destructive'>
        {t('erp.errors.denied')}
      </DocumentStatusBar>
    );
  else if (!inspection)
    status = (
      <DocumentStatusBar tone='destructive'>
        {record.error !== undefined ? (
          errorText(record.error, t)
        ) : (
          <p role='status'>{t('status.loading')}</p>
        )}
      </DocumentStatusBar>
    );
  else
    status = (
      <DocumentStatusBar tone={inspection.status === 'void' ? 'destructive' : 'neutral'}>
        {t(`inspections.statusBar.${inspection.status}`)}
      </DocumentStatusBar>
    );

  const base = `/inspections/${encodeURIComponent(inspection?.id ?? id)}`;
  const fields: (DetailField | false)[] = inspection
    ? [
        { label: t('inspections.fields.inspectionDate'), value: inspection.inspectionDate },
        { label: t('inspections.fields.purchaseOrder'), value: inspection.purchaseOrder.orderNo },
        { label: t('inspections.fields.supplier'), value: inspection.supplier?.name ?? '—' },
        { label: t('inspections.fields.inspector'), value: inspection.inspector?.name ?? '—' },
        { label: t('erp.fields.note'), value: inspection.remark, wide: true },
        { label: t('inspections.fields.createdAt'), value: inspection.createdAt },
      ]
    : [];

  return (
    <>
      <DocumentPage
        title={inspection?.docNo ?? t('inspections.detailTitle')}
        badge={inspection ? <InspectionStatusBadge status={inspection.status} /> : undefined}
        status={status}
        actions={
          inspection ? (
            <>
              {editable && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search: location.search }} />}
                >
                  {t('inspections.actions.edit')}
                </Button>
              ) : null}
              {editable && complete.can ? (
                <PendingButton busy={busy} action='post' onClick={() => void act('complete')}>
                  {t('inspections.actions.complete')}
                </PendingButton>
              ) : null}
              {editable && voiding.can ? (
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  <ActionGlyph action='void' />
                  {t('inspections.actions.void')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {inspection ? (
          <>
            <DocumentSection title={t('inspections.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('inspections.fields.lines')}>
              <LinesTable<InspectionLine>
                columns={columns}
                rows={inspection.lines}
                getRowId={(line) => line.id}
                totals={
                  <>
                    <TableCell colSpan={columns.length - 1} className='text-right font-medium'>
                      {t('inspections.fields.totalReleasable')}
                    </TableCell>
                    <TableCell className='text-right font-medium' data-testid='inspection-total-releasable'>
                      {number(
                        inspection.lines.reduce((sum, line) => sum + line.releasableQty, 0),
                        locale,
                      )}
                    </TableCell>
                  </>
                }
                emptyMessage={t('inspections.form.linesEmpty')}
              />
            </DocumentSection>
            {inspection.files.length > 0 ? (
              <DocumentSection title={t('erp.docFiles.title')}>
                <ul className='text-sm'>
                  {inspection.files.map((file) => (
                    <li key={file.id}>{file.name}</li>
                  ))}
                </ul>
              </DocumentSection>
            ) : null}
          </>
        ) : null}
      </DocumentPage>
      <ConfirmDialog
        open={confirming}
        title={t('inspections.voidTitle', { name: inspection?.docNo ?? '' })}
        description={t('inspections.voidDescription')}
        confirmLabel={t('inspections.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void act('void')}
      />
      <Outlet />
    </>
  );
}
