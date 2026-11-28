import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Outlet, useParams, useResolvedPath } from 'react-router';

import { ActionGlyph } from '#components/action-glyph';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Textarea } from '#components/ui/textarea';

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatNumber } from '../orders/model.js';
import {
  ReturnsClient,
  type GeneratedDocSummary,
  type ReturnLine,
} from './client.js';
import { Dash, ReturnStatusBadge } from './fields.js';
import { errorHint } from './model.js';
import {
  DOC_BASE,
  PURCHASE_RETURNS,
  RETURN_LIST_KEYS,
  SALES_RETURNS,
  returnResource,
  type ReturnKindDef,
} from './page-id.js';
import { useReturnDoc } from './record.js';

function qty(value: number, locale: string): ReactNode {
  return <span className='tabular-nums'>{formatNumber(value, locale)}</span>;
}

/** 一张退货单的详情：来源、明细、生成的出入库单链接，以及按角色与状态显隐的过账 / 作废。 */
export function ReturnDetailPage({ def }: { readonly def: ReturnKindDef }): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const id = useParams().returnId ?? '';
  const client = useMemo(() => new ReturnsClient(api, def), [api, def]);
  const resource = returnResource(def);
  const view = useCan({ resource, action: 'view' });
  const postView = useCan({ resource, action: 'postView' });
  const posting = useCan({ resource, action: 'post' });
  const voiding = useCan({ resource, action: 'void' });
  const canRead = view.can || postView.can;
  const record = useReturnDoc(client, id, canRead);
  const doc = record.data;
  const [docs, setDocs] = useState<readonly GeneratedDocSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string>();

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t(`navigation.${def.kind === 'purchase' ? 'purchaseReturns' : 'salesReturns'}`),
    to: { pathname: owner, search: useAncestorSearch(owner, RETURN_LIST_KEYS) },
  };
  usePageBreadcrumb([listLevel, { label: doc?.docNo ?? t('returns.detailTitle') }]);

  const docId = doc?.id;
  const status = doc?.status;
  const reloadDocs = useCallback(() => {
    if (!docId || status !== 'posted' || !canRead) return;
    void (async () => {
      try {
        const page = await client.generatedDocs(docId);
        setDocs(page.items);
      } catch {
        // 反查失败就先不放链接，详情照常显示。
      }
    })();
  }, [client, docId, status, canRead]);
  useEffect(() => {
    reloadDocs();
  }, [reloadDocs]);

  const runPost = async (): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.post(id);
      toaster.show({ type: 'success', title: t('returns.toasts.posted', { docNo: doc?.docNo ?? '' }) });
      record.reload();
    } catch (cause) {
      setActionError(errorHint(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const runVoid = async (): Promise<void> => {
    if (!reason.trim()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await client.voidDoc(id, reason.trim());
      toaster.show({ type: 'success', title: t('returns.toasts.voided', { docNo: doc?.docNo ?? '' }) });
      setVoidOpen(false);
      setReason('');
      record.reload();
    } catch (cause) {
      setActionError(errorHint(cause, t));
      setVoidOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<ReturnLine>[]>(
    () => [
      { id: 'index', header: '#', cell: ({ row }) => <span className='text-muted-foreground tabular-nums'>{row.index + 1}</span> },
      {
        id: 'item',
        header: t('returns.fields.item'),
        cell: ({ row }) => (
          <span className='flex min-w-0 flex-col'>
            <span className='font-medium'>{row.original.item.code}</span>
            <span className='wrap-anywhere'>{row.original.item.name}</span>
          </span>
        ),
      },
      { id: 'warehouse', header: t('returns.fields.warehouse'), cell: ({ row }) => row.original.warehouseId },
      { id: 'batchNo', header: t('returns.fields.batchNo'), cell: ({ row }) => row.original.batchNo || <Dash /> },
      { id: 'qty', header: t('returns.fields.qty'), cell: ({ row }) => qty(row.original.qty, locale) },
      { id: 'remainQty', header: t('returns.fields.remainQty'), cell: ({ row }) => qty(row.original.remainQty, locale) },
      { id: 'returnQty', header: t('returns.fields.returnQty'), cell: ({ row }) => qty(row.original.returnQty, locale) },
      { id: 'note', header: t('returns.fields.note'), cell: ({ row }) => row.original.note ?? <Dash /> },
    ],
    [t, locale],
  );

  let statusBar: ReactNode;
  if (!canRead && !view.isPending && !postView.isPending)
    statusBar = <DocumentStatusBar tone='destructive'>{t('erp.errors.denied')}</DocumentStatusBar>;
  else if (!doc)
    statusBar = (
      <DocumentStatusBar tone='destructive'>
        {record.error !== undefined ? errorText(record.error, t) : <p role='status'>{t('status.loading')}</p>}
      </DocumentStatusBar>
    );
  else
    statusBar = (
      <DocumentStatusBar tone={doc.status === 'void' ? 'destructive' : 'neutral'}>
        {t(`returns.statusBar.${doc.status}`)}
      </DocumentStatusBar>
    );

  const fields: (DetailField | false)[] = doc
    ? [
        {
          label: t('returns.fields.source'),
          value: doc.sourceType === 'order'
            ? t('returns.source.modeOrder')
            : t('returns.source.modeDoc'),
        },
        { label: t('returns.fields.sourceId'), value: doc.sourceId },
        {
          label: t(def.kind === 'purchase' ? 'returns.columns.supplier' : 'returns.columns.customer'),
          value: doc.partner?.name ?? <Dash />,
        },
        { label: t('returns.fields.handler'), value: doc.handler?.name ?? <Dash /> },
        { label: t('returns.fields.warehouse'), value: doc.warehouse?.name ?? <Dash /> },
        { label: t('returns.fields.remark'), value: doc.remark, wide: true },
      ]
    : [];

  return (
    <>
      <DocumentPage
        title={doc?.docNo ?? t('returns.detailTitle')}
        badge={doc ? <ReturnStatusBadge status={doc.status} /> : undefined}
        status={statusBar}
        actions={
          doc ? (
            <>
              {doc.status === 'draft' && posting.can ? (
                <PendingButton busy={busy} action='post' onClick={() => void runPost()} data-testid='returns-detail-post'>
                  {t('returns.actions.post')}
                </PendingButton>
              ) : null}
              {doc.status === 'draft' && voiding.can ? (
                <Button
                  variant='outline'
                  disabled={busy}
                  data-testid='returns-detail-void'
                  onClick={() => {
                    setReason('');
                    setVoidOpen(true);
                  }}
                >
                  <ActionGlyph action='void' />
                  {t('returns.actions.void')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {doc ? (
          <>
            <DocumentSection title={t('returns.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('returns.fields.lines')}>
              <LinesTable
                columns={columns}
                rows={doc.lines ?? []}
                getRowId={(line) => line.id}
                emptyMessage={t('returns.form.linesEmpty')}
              />
            </DocumentSection>
            {doc.status === 'posted' ? (
              <DocumentSection title={t('returns.generated.title')}>
                <div className='flex flex-col gap-2'>
                  {docs.length > 0 ? (
                    docs.map((one) => (
                      <Link
                        key={one.id}
                        to={`${DOC_BASE[one.docType]}/${encodeURIComponent(one.id)}`}
                        data-testid='returns-generated-doc'
                      >
                        {one.docNo}
                      </Link>
                    ))
                  ) : (
                    <Dash />
                  )}
                </div>
              </DocumentSection>
            ) : null}
          </>
        ) : null}
      </DocumentPage>
      {actionError ? <p role='alert' className='text-sm text-destructive'>{actionError}</p> : null}
      <Dialog
        open={voidOpen}
        onOpenChange={(open) => {
          if (!open) setVoidOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('returns.voidTitle', { docNo: doc?.docNo ?? '' })}</DialogTitle>
            <DialogDescription>{t('returns.voidDescription')}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t('returns.fields.voidReason')}
            placeholder={t('returns.fields.voidReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className='flex justify-end gap-2'>
            <Button variant='outline' onClick={() => setVoidOpen(false)}>{t('actions.cancel')}</Button>
            <Button
              variant='destructive'
              disabled={busy || reason.trim() === ''}
              data-testid='returns-confirm-void'
              onClick={() => void runVoid()}
            >
              {t('returns.actions.confirmVoid')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Outlet />
    </>
  );
}

export function PurchaseReturnsDetailPage(): ReactElement {
  return <ReturnDetailPage def={PURCHASE_RETURNS} />;
}

export function SalesReturnsDetailPage(): ReactElement {
  return <ReturnDetailPage def={SALES_RETURNS} />;
}
