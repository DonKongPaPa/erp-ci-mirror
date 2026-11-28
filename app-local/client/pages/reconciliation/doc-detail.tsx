import {
  useApiClient, usePageBreadcrumb, useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation, useParams, useResolvedPath } from 'react-router';

import { ActionGlyph } from '#components/action-glyph';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  DocumentHeaderFields, DocumentPage, DocumentSection, DocumentStatusBar, LinesTable,
} from '#components/erp/document';
import type { DetailField } from '#components/erp/detail';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { useRecord } from '#components/erp/record';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';

import { useAncestorSearch } from '../../routing/route-context.js';
import { ReconciliationClient, type DocRecord, type ReconciliationLine } from './client.js';
import { Dash, DocStatusBadge } from './fields.js';
import type { DocKind } from './kinds.js';
import { financeErrorText } from './model.js';
import { RECON_LIST_KEYS } from './page-id.js';

/** 一张收入或开票记录：草稿可编辑、登记、作废；已登记只可作废；作废后只读。 */
export function DocDetailPage({ kind }: { readonly kind: DocKind }): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const params = useParams();
  const client = useMemo(() => new ReconciliationClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const confirm = useCan({ resource: kind.resource, action: 'confirm' });
  const voiding = useCan({ resource: kind.resource, action: 'void' });
  const record = useRecord<DocRecord>(
    `${kind.api}/${encodeURIComponent(params[kind.param] ?? '')}`, view.can,
  );
  const doc = record.data;

  const owner = useResolvedPath('..').pathname;
  const self = useResolvedPath('.').pathname;
  usePageBreadcrumb([
    { label: t(`navigation.${kind.l}`), to: { pathname: owner, search: useAncestorSearch(owner, RECON_LIST_KEYS) } },
    { label: doc?.docNo ?? t(`${kind.l}.detailTitle`), to: { pathname: self, search: useAncestorSearch(self, RECON_LIST_KEYS) } },
  ]);

  const [confirming, setConfirming] = useState<'confirm' | 'void'>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const act = async (action: 'confirm' | 'void'): Promise<void> => {
    if (!doc) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const saved = action === 'confirm'
        ? await client.confirm(kind.api, doc.id)
        : await client.void(kind.api, doc.id);
      record.replaceData(saved as DocRecord);
      toaster.show({
        type: 'success',
        title: action === 'confirm'
          ? t('reconciliation.registeredToast', { docNo: saved.docNo })
          : t('reconciliation.voidedToast', { docNo: saved.docNo }),
      });
      setConfirming(undefined);
    } catch (next) {
      setActionError(financeErrorText(next, t));
      record.reload();
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<ReconciliationLine>[]>(() => [
    {
      id: 'upstream', header: t('reconciliation.upstream'),
      cell: ({ row }) => row.original.salesOrderId ?? row.original.receivableReconId ?? <Dash />,
    },
    {
      id: 'payable', header: t('reconciliation.orderPayable'),
      cell: ({ row }) => <span className='tabular-nums'>{row.original.orderPayableAmount}</span>,
    },
    {
      id: 'before', header: t(kind.id === 'income' ? 'reconciliation.receivedBefore' : 'reconciliation.invoicedBefore'),
      cell: ({ row }) => (
        <span className='tabular-nums'>
          {kind.id === 'income' ? row.original.receivedBefore ?? 0 : row.original.invoicedBefore ?? 0}
        </span>
      ),
    },
    {
      id: 'amount', header: t(kind.id === 'income' ? 'reconciliation.incomeAmount' : 'reconciliation.invoiceAmount'),
      cell: ({ row }) => <span className='tabular-nums'>{row.original.amount}</span>,
    },
    { id: 'note', header: t('erp.fields.note'), cell: ({ row }) => row.original.note ?? <Dash /> },
  ], [t, kind.id]);

  if (!doc)
    return (
      <DocumentPage
        title={t(`${kind.l}.detailTitle`)}
        status={<DocumentStatusBar tone='destructive'>
          {!view.can ? t('erp.errors.denied') : record.error ? financeErrorText(record.error, t) : t('status.loading')}
        </DocumentStatusBar>}
      ><Outlet /></DocumentPage>
    );

  const fields: (DetailField | false)[] = [
    { label: t(kind.id === 'income' ? 'reconciliation.incomeDocNo' : 'reconciliation.invoiceDocNo'), value: doc.docNo },
    { label: t(kind.id === 'income' ? 'reconciliation.incomeDate' : 'reconciliation.invoiceDate'), value: doc.date },
    { label: t('erp.fields.status'), value: <DocStatusBadge status={doc.status} /> },
    { label: t(kind.id === 'income' ? 'reconciliation.incomeType' : 'reconciliation.invoiceType'), value: doc.incomeTypeLabel ?? doc.invoiceTypeLabel },
    { label: t('reconciliation.customer'), value: doc.customer?.name },
    { label: t('reconciliation.payerName'), value: doc.payerName },
    { label: t('reconciliation.invoiceToName'), value: doc.invoiceToName },
    { label: t('reconciliation.invoiceNo'), value: doc.invoiceNo },
    { label: t('reconciliation.project'), value: doc.projectLabel },
    { label: t('reconciliation.handler'), value: doc.handler?.name },
    { label: t('reconciliation.totalAmount'), value: <span className='tabular-nums'>{doc.totalAmount}</span> },
    { label: t('erp.fields.note'), value: doc.remark, wide: true },
  ];

  return (
    <DocumentPage
      title={doc.docNo}
      badge={<DocStatusBadge status={doc.status} />}
      status={
        doc.status === 'draft' ? <DocumentStatusBar>{t('reconciliation.draftStatus')}</DocumentStatusBar>
          : doc.status === 'confirmed' ? <DocumentStatusBar tone='info'>
            {t('reconciliation.confirmedStatus', {
              time: doc.confirmedAt
                ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(doc.confirmedAt))
                : '',
            })}
          </DocumentStatusBar>
            : <DocumentStatusBar>{t('reconciliation.voidStatus')}</DocumentStatusBar>
      }
      actions={
        <>
          {doc.status === 'draft' && update.can ? (
            <Button variant='outline' nativeButton={false}
              render={<Link to={{ pathname: `${kind.base}/${encodeURIComponent(doc.id)}/edit`, search: location.search }} />}>
              {t('erp.actions.edit')}
            </Button>
          ) : null}
          {doc.status === 'draft' && confirm.can ? (
            <PendingButton busy={busy} action='review' onClick={() => setConfirming('confirm')}>{t('reconciliation.register')}</PendingButton>
          ) : null}
          {doc.status !== 'void' && voiding.can ? (
            <Button variant='outline' disabled={busy} onClick={() => setConfirming('void')}><ActionGlyph action='void' />{t('reconciliation.void')}</Button>
          ) : null}
        </>
      }
    >
      <DocumentSection title={t('reconciliation.header')}><DocumentHeaderFields fields={fields} /></DocumentSection>
      <DocumentSection title={t('reconciliation.lines')}>
        <LinesTable<ReconciliationLine>
          columns={columns} rows={doc.lines}
          getRowId={(line) => line.id} emptyMessage={t('reconciliation.noLines')}
        />
      </DocumentSection>
      <DocumentSection title={t('erp.docFiles.title')}>
        <DocFilesPanel
          files={doc.files ?? []} ids={(doc.files ?? []).map((file) => file.id)}
          disabled={doc.status !== 'draft'} onChange={() => undefined}
        />
      </DocumentSection>
      <ConfirmDialog
        open={confirming !== undefined}
        title={t(confirming === 'confirm' ? 'reconciliation.confirmTitle' : 'reconciliation.voidTitle', { docNo: doc.docNo })}
        description={t(confirming === 'confirm' ? 'reconciliation.confirmDescription' : 'reconciliation.voidDescription')}
        confirmLabel={t(confirming === 'confirm' ? 'reconciliation.register' : 'reconciliation.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { if (confirming) void act(confirming); }}
      />
      <Outlet />
    </DocumentPage>
  );
}
