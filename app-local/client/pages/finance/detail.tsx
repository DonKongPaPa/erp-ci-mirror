import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, Outlet, useLocation, useParams, useResolvedPath } from 'react-router';

import { ConfirmDialog } from '#components/erp/confirm';
import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
  LinesTable,
} from '#components/erp/document';
import type { DetailField } from '#components/erp/detail';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { errorText } from '#components/erp/messages';
import { useRecord } from '#components/erp/record';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';

import { useAncestorSearch } from '../../routing/route-context.js';
import { FinanceClient, type FinanceLine, type FinanceRecord } from './client.js';
import { Dash, FinanceStatusBadge } from './fields.js';
import type { FinanceKind } from './kinds.js';
import { FINANCE_LIST_KEYS } from './list-keys.js';

/**
 * 一张支出记录或到票记录（`/expenses/:id`、`/invoice-receipts/:id`）。
 * 草稿有编辑、登记与作废；已登记只能作废；已作废只读。
 * 登记与作废由服务端重算上游采购订单的已支出、已到票。
 */
export function FinanceDetailPage({
  kind,
}: {
  readonly kind: FinanceKind;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const params = useParams();
  const client = useMemo(() => new FinanceClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const confirm = useCan({ resource: kind.resource, action: 'confirm' });
  const voiding = useCan({ resource: kind.resource, action: 'void' });
  const record = useRecord<FinanceRecord>(
    `${kind.api}/${encodeURIComponent(params[kind.param] ?? '')}`,
    view.can,
  );
  const doc = record.data;

  const owner = useResolvedPath('..').pathname;
  const self = useResolvedPath('.').pathname;
  const listSearch = useAncestorSearch(owner, FINANCE_LIST_KEYS);
  const selfSearch = useAncestorSearch(self, FINANCE_LIST_KEYS);
  usePageBreadcrumb([
    { label: t(`navigation.${kind.l}`), to: { pathname: owner, search: listSearch } },
    { label: doc?.docNo ?? t(`${kind.l}.detailTitle`), to: { pathname: self, search: selfSearch } },
  ]);

  const [confirming, setConfirming] = useState<'confirm' | 'void'>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileError, setFileError] = useState<string>();

  const act = async (action: 'confirm' | 'void'): Promise<void> => {
    if (!doc) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const saved =
        action === 'confirm'
          ? await client.confirm(kind.api, doc.id)
          : await client.void(kind.api, doc.id);
      record.replaceData(saved);
      toaster.show({
        type: 'success',
        title:
          action === 'confirm'
            ? t(`${kind.l}.registeredToast`, { docNo: saved.docNo })
            : t(`${kind.l}.voidedToast`, { docNo: saved.docNo }),
      });
      setConfirming(undefined);
    } catch (next) {
      setActionError(errorText(next, t));
      record.reload();
    } finally {
      setBusy(false);
    }
  };

  const changeFiles = async (ids: readonly string[]): Promise<void> => {
    if (!doc || doc.status !== 'draft') return;
    setFilesBusy(true);
    setFileError(undefined);
    try {
      const saved = await client.update(kind.api, doc.id, {
        fileIds: [...ids],
        bindMode: doc.bindMode,
        ...(doc.bindMode === 'none' ? { amount: doc.totalAmount } : {
          lines: doc.lines.map((line) => ({
            purchaseOrderId: line.purchaseOrderId,
            amount: line.amount,
            note: line.note ?? undefined,
          })),
        }),
      });
      record.replaceData(saved);
    } catch (next) {
      setFileError(errorText(next, t));
    } finally {
      setFilesBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<FinanceLine>[]>(
    () => [
      {
        id: 'orderNo',
        header: t('finance.upstreamOrder'),
        cell: ({ row }) => row.original.orderNo,
      },
      {
        id: 'payable',
        header: t('finance.orderPayable'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.orderPayableAmount}</span>
        ),
      },
      {
        id: 'paidBefore',
        header: t(kind.id === 'expense' ? 'finance.paidBefore' : 'finance.invoicedBefore'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {kind.id === 'expense' ? row.original.paidBefore : row.original.invoicedBefore}
          </span>
        ),
      },
      {
        id: 'amount',
        header: t(kind.id === 'expense' ? 'finance.expenseAmount' : 'finance.invoiceAmount'),
        cell: ({ row }) => <span className='tabular-nums'>{row.original.amount}</span>,
      },
      {
        id: 'note',
        header: t('erp.fields.note'),
        cell: ({ row }) => row.original.note ?? <Dash />,
      },
    ],
    [t, kind.id],
  );

  if (!doc)
    return (
      <DocumentPage
        title={t(`${kind.l}.detailTitle`)}
        status={
          <DocumentStatusBar tone={view.can ? 'destructive' : 'destructive'}>
            {view.can
              ? record.error
                ? errorText(record.error, t)
                : t('status.loading')
              : t('erp.errors.denied')}
          </DocumentStatusBar>
        }
      >
        <Outlet />
      </DocumentPage>
    );

  const fields: (DetailField | false)[] = [
    { label: t(`finance.${kind.docNoLabel}`), value: doc.docNo },
    {
      label: t(kind.id === 'expense' ? 'finance.expenseDate' : 'finance.invoiceDate'),
      value: doc.expenseDate ?? doc.invoiceDate,
    },
    { label: t('erp.fields.status'), value: <FinanceStatusBadge record={doc} /> },
    {
      label: t(kind.id === 'expense' ? 'finance.expenseType' : 'finance.invoiceType'),
      value: doc.expenseTypeLabel ?? doc.invoiceTypeLabel,
    },
    ...(kind.id === 'expense'
      ? [
          { label: t('finance.fundAccount'), value: doc.fundAccountLabel },
          { label: t('finance.payeeName'), value: doc.payeeName },
          {
            label: t('finance.payeeAccountNo'),
            value: doc.payeeAccountNo,
          },
          { label: t('finance.payeeBankName'), value: doc.payeeBankName },
          { label: t('finance.payeeBankCode'), value: doc.payeeBankCode },
        ]
      : [
          { label: t('finance.issuerName'), value: doc.issuerName },
          { label: t('finance.invoiceNo'), value: doc.invoiceNo },
        ]),
    { label: t('finance.supplier'), value: doc.supplier?.name },
    { label: t('finance.project'), value: doc.projectLabel },
    { label: t('finance.handler'), value: doc.handler?.name },
    { label: t('finance.totalAmount'), value: <span className='tabular-nums'>{doc.totalAmount}</span> },
    { label: t('erp.fields.note'), value: doc.remark, wide: true },
  ];

  return (
    <DocumentPage
      title={doc.docNo}
      badge={<FinanceStatusBadge record={doc} />}
      status={
        doc.status === 'draft' ? (
          <DocumentStatusBar>{t('finance.draftStatus')}</DocumentStatusBar>
        ) : doc.status === 'confirmed' ? (
          <DocumentStatusBar tone='info'>
            {t('finance.confirmedStatus', {
              time: doc.confirmedAt
                ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(doc.confirmedAt))
                : '',
            })}
          </DocumentStatusBar>
        ) : (
          <DocumentStatusBar>{t('finance.voidStatus')}</DocumentStatusBar>
        )
      }
      actions={
        <>
          {doc.status === 'draft' && update.can ? (
            <Button
              variant='outline'
              nativeButton={false}
              render={<Link to={{ pathname: `${kind.base}/${encodeURIComponent(doc.id)}/edit`, search: location.search }} />}
            >
              {t('erp.actions.edit')}
            </Button>
          ) : null}
          {doc.status === 'draft' && confirm.can ? (
            <PendingButton busy={busy} onClick={() => setConfirming('confirm')}>
              {t('finance.register')}
            </PendingButton>
          ) : null}
          {doc.status !== 'void' && voiding.can ? (
            <Button variant='outline' disabled={busy} onClick={() => setConfirming('void')}>
              {t('finance.void')}
            </Button>
          ) : null}
        </>
      }
    >
      <DocumentSection title={t('finance.header')}>
        <DocumentHeaderFields fields={fields} />
      </DocumentSection>
      <DocumentSection title={t('finance.lines')}>
        <LinesTable<FinanceLine>
          columns={columns}
          rows={doc.lines}
          getRowId={(line) => line.id}
          emptyMessage={t('finance.noLines')}
        />
      </DocumentSection>
      <DocumentSection title={t('erp.docFiles.title')}>
        <DocFilesPanel
          files={doc.files ?? []}
          ids={(doc.files ?? []).map((file) => file.id)}
          disabled={filesBusy || doc.status !== 'draft'}
          onChange={(ids) => void changeFiles(ids)}
        />
        {fileError ? <p role='alert' className='text-sm text-destructive'>{fileError}</p> : null}
      </DocumentSection>
      <ConfirmDialog
        open={confirming !== undefined}
        title={
          confirming === 'confirm'
            ? t('finance.confirmTitle', { docNo: doc.docNo })
            : t('finance.voidTitle', { docNo: doc.docNo })
        }
        description={t(confirming === 'confirm' ? 'finance.confirmDescription' : 'finance.voidDescription')}
        confirmLabel={t(confirming === 'confirm' ? 'finance.register' : 'finance.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { if (confirming) void act(confirming); }}
      />
      <Outlet />
    </DocumentPage>
  );
}
