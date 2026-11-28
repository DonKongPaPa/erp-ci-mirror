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
import { ReconciliationClient, type ReconRecord, type SnapshotLine } from './client.js';
import { Dash, DocStatusBadge, ReconStatusBadge } from './fields.js';
import type { ReconKind } from './kinds.js';
import { financeErrorText } from './model.js';
import { RECON_LIST_KEYS } from './page-id.js';

/** 一张对账单：表头、只读快照、两列核销金额与核销状态、确认与作废。 */
export function ReconDetailPage({ kind }: { readonly kind: ReconKind }): ReactElement {
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
  const record = useRecord<ReconRecord>(
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
      record.replaceData(saved as ReconRecord);
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

  const columns = useMemo<ColumnDef<SnapshotLine>[]>(() => [
    { id: 'source', header: t('reconciliation.sourceDoc'), cell: ({ row }) => row.original.sourceDocId },
    { id: 'item', header: t('reconciliation.item'), cell: ({ row }) => `${row.original.item.code} ${row.original.item.name}` },
    { id: 'qty', header: t('reconciliation.qty'), cell: ({ row }) => <span className='tabular-nums'>{row.original.qty}</span> },
    { id: 'price', header: t('reconciliation.taxIncludedPrice'), cell: ({ row }) => <span className='tabular-nums'>{row.original.taxIncludedPrice ?? <Dash />}</span> },
    { id: 'amount', header: t('reconciliation.taxIncludedAmount'), cell: ({ row }) => <span className='tabular-nums'>{row.original.taxIncludedAmount ?? <Dash />}</span> },
  ], [t]);

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
    { label: t('reconciliation.reconDocNo'), value: doc.docNo },
    { label: t('reconciliation.reconDate'), value: doc.reconDate },
    { label: t('erp.fields.status'), value: <DocStatusBadge status={doc.status} /> },
    { label: t('reconciliation.expectedPayDate'), value: doc.expectedPayDate },
    { label: t(kind.partnerKind === 'customer' ? 'reconciliation.customer' : 'reconciliation.supplier'), value: (kind.partnerKind === 'customer' ? doc.customer : doc.supplier)?.name },
    { label: t('reconciliation.contactName'), value: doc.contactName },
    { label: t('reconciliation.phone'), value: doc.phone },
    { label: t('reconciliation.periodAmount'), value: <span className='tabular-nums'>{doc.periodAmount}</span> },
    { label: t('reconciliation.project'), value: doc.projectCode },
    { label: t('reconciliation.handler'), value: doc.handler?.name },
    { label: t('erp.fields.note'), value: doc.remark, wide: true },
  ];

  const reconFields: (DetailField | false)[] = [
    { label: t(kind.amountOneLabel), value: <span className='tabular-nums'>{doc[kind.amountOneKey] ?? 0}</span> },
    { label: t(kind.amountTwoLabel), value: <span className='tabular-nums'>{doc[kind.amountTwoKey] ?? 0}</span> },
    { label: t('reconciliation.reconStatus'), value: <ReconStatusBadge status={doc.reconStatus} /> },
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
            <PendingButton busy={busy} action='review' onClick={() => setConfirming('confirm')}>{t('reconciliation.confirmRecon')}</PendingButton>
          ) : null}
          {doc.status !== 'void' && voiding.can ? (
            <Button variant='outline' disabled={busy} onClick={() => setConfirming('void')}><ActionGlyph action='void' />{t('reconciliation.void')}</Button>
          ) : null}
        </>
      }
    >
      <DocumentSection title={t('reconciliation.header')}><DocumentHeaderFields fields={fields} /></DocumentSection>
      <DocumentSection title={t('reconciliation.reconSection')}>
        <section aria-label={t('reconciliation.reconSection')}>
          <DocumentHeaderFields fields={reconFields} />
        </section>
      </DocumentSection>
      <DocumentSection title={t('reconciliation.snapshotLines')}>
        <LinesTable<SnapshotLine>
          columns={columns} rows={doc.snapshotLines}
          getRowId={(line) => line.id} emptyMessage={t('reconciliation.noSnapshotLines')}
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
        title={t(confirming === 'confirm' ? 'reconciliation.confirmReconTitle' : 'reconciliation.voidTitle', { docNo: doc.docNo })}
        description={t(confirming === 'confirm' ? 'reconciliation.confirmDescription' : 'reconciliation.voidDescription')}
        confirmLabel={t(confirming === 'confirm' ? 'reconciliation.confirmRecon' : 'reconciliation.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { if (confirming) void act(confirming); }}
      />
      <Outlet />
    </DocumentPage>
  );
}
