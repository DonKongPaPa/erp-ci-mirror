import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams, useResolvedPath } from 'react-router';

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
import { errorText, type Translate } from '#components/erp/messages';
import { useRecord } from '#components/erp/record';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';

import { useAncestorSearch } from '../../routing/route-context.js';
import { QuotationsClient, type Quotation, type QuotationLine } from './client.js';
import { Dash, ExpiredBadge, QuotationStatusBadge, QuotationTotals } from './fields.js';
import { formatAmount, formatDateTime, formatNumber } from './model.js';
import { QUOTATIONS_LIST_KEYS, QUOTATIONS_RESOURCE } from './page-id.js';

/** 数量最多四位小数、金额至少两位；服务端没算出来的画「—」，不当成 0。 */
function number(value: number | null, locale: string): ReactElement {
  return value === null || value === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>{formatNumber(value, locale)}</span>
  );
}

function money(value: number | null, locale: string, t: Translate): ReactElement {
  return value === null || value === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>
      {t('quotations.money', { amount: formatAmount(value, locale) })}
    </span>
  );
}

/**
 * 一张报价单的详情：状态与有效期标记、表头、明细、六个只读合计、附件，
 * 以及这一刻能做的操作。写动作按会话实际持有的动作显隐，不按角色名猜。
 */
export default function QuotationDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const quotationId = useParams().quotationId ?? '';
  const client = useMemo(() => new QuotationsClient(api), [api]);
  const view = useCan({ resource: QUOTATIONS_RESOURCE, action: 'view' });
  const update = useCan({ resource: QUOTATIONS_RESOURCE, action: 'update' });
  const confirm = useCan({ resource: QUOTATIONS_RESOURCE, action: 'confirm' });
  const convert = useCan({ resource: QUOTATIONS_RESOURCE, action: 'convert' });
  const voiding = useCan({ resource: QUOTATIONS_RESOURCE, action: 'void' });
  const request = useRecord<Quotation>(
    quotationId ? `quotations/${encodeURIComponent(quotationId)}` : '',
    view.can,
  );
  const quotation = request.data;

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.quotations'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, QUOTATIONS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: quotation?.docNo ?? t('quotations.detailTitle') },
  ]);

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileError, setFileError] = useState<string>();

  const act = async (kind: 'confirm' | 'void' | 'convert'): Promise<void> => {
    if (!quotation) return;
    setBusy(true);
    setActionError(undefined);
    try {
      if (kind === 'convert') {
        const result = await client.createSalesOrder(quotation.id);
        toaster.show({
          type: 'success',
          title: t('quotations.toasts.converted', { name: quotation.docNo }),
        });
        await navigate(`/sales-orders/${encodeURIComponent(result.salesOrderId)}`);
        return;
      }
      await client[kind](quotation.id);
      toaster.show({
        type: 'success',
        title: t(
          kind === 'void' ? 'quotations.toasts.voided' : 'quotations.toasts.confirmed',
          { name: quotation.docNo },
        ),
      });
      setConfirming(false);
    } catch (next) {
      const text = errorText(next, t);
      if (kind === 'void') setActionError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
      // 动作之后这一张单可能已经不是加载时的状态：重新读一次。
      request.reload();
    }
  };

  const changeFiles = async (ids: readonly string[]): Promise<void> => {
    if (!quotation || quotation.status !== 'draft' || !update.can) return;
    setFilesBusy(true);
    setFileError(undefined);
    try {
      await client.update(quotation.id, { fileIds: [...ids] });
      request.reload();
    } catch (next) {
      setFileError(errorText(next, t));
    } finally {
      setFilesBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<QuotationLine>[]>(
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
        header: t('quotations.fields.item'),
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
        header: t('quotations.fields.unit'),
        cell: ({ row }) => row.original.item.unitCode || <Dash />,
      },
      {
        id: 'qty',
        header: t('quotations.fields.qty'),
        cell: ({ row }) => number(row.original.qty, locale),
      },
      {
        id: 'price',
        header: t('quotations.fields.price'),
        cell: ({ row }) => number(row.original.price, locale),
      },
      {
        id: 'taxExcludedPrice',
        header: t('quotations.fields.taxExcludedPrice'),
        cell: ({ row }) => number(row.original.taxExcludedPrice, locale),
      },
      {
        id: 'taxRate',
        header: t('quotations.fields.taxRate'),
        cell: ({ row }) => number(row.original.taxRate, locale),
      },
      {
        id: 'deliveryDate',
        header: t('quotations.fields.deliveryDate'),
        cell: ({ row }) => row.original.deliveryDate ?? <Dash />,
      },
      {
        id: 'taxIncludedAmount',
        header: t('quotations.fields.taxIncludedAmount'),
        cell: ({ row }) => money(row.original.taxIncludedAmount, locale, t),
      },
      {
        id: 'note',
        header: t('erp.fields.note'),
        cell: ({ row }) => row.original.note || <Dash />,
      },
    ],
    [t, locale],
  );

  let status: ReactElement;
  if (!view.isPending && !view.can)
    status = (
      <DocumentStatusBar tone='destructive'>{t('erp.errors.denied')}</DocumentStatusBar>
    );
  else if (!quotation)
    status = (
      <DocumentStatusBar tone='destructive'>
        {request.error !== undefined ? (
          errorText(request.error, t)
        ) : (
          <p role='status'>{t('status.loading')}</p>
        )}
      </DocumentStatusBar>
    );
  else
    status = (
      <DocumentStatusBar tone={quotation.status === 'void' ? 'destructive' : 'neutral'}>
        <span className='flex flex-wrap items-center gap-2'>
          <span>{t(`quotations.statusBar.${quotation.status}`)}</span>
          {quotation.expired ? <ExpiredBadge /> : null}
        </span>
      </DocumentStatusBar>
    );

  const base = `/quotations/${encodeURIComponent(quotation?.id ?? quotationId)}`;
  const fields: (DetailField | false)[] = quotation
    ? [
        {
          label: t('quotations.fields.customer'),
          value: quotation.customer
            ? `${quotation.customer.code} ${quotation.customer.name}`
            : undefined,
        },
        { label: t('quotations.fields.quoteDate'), value: quotation.quoteDate },
        { label: t('quotations.fields.validUntil'), value: quotation.validUntil },
        {
          label: t('quotations.fields.warehouse'),
          value: quotation.warehouse?.name,
        },
        { label: t('quotations.fields.contactName'), value: quotation.contactName },
        { label: t('quotations.fields.contactPhone'), value: quotation.contactPhone },
        { label: t('quotations.fields.deliveryAddress'), value: quotation.deliveryAddress, wide: true },
        {
          label: t('quotations.fields.settlement'),
          value: quotation.settlementLabel ?? quotation.settlementCode,
        },
        {
          label: t('quotations.fields.project'),
          value: quotation.projectLabel ?? quotation.projectCode,
        },
        { label: t('quotations.fields.customerOrderNo'), value: quotation.customerOrderNo },
        { label: t('quotations.fields.handler'), value: quotation.handler?.name },
        {
          label: t('quotations.fields.createdAt'),
          value: formatDateTime(quotation.createdAt, locale),
        },
        quotation.convertedOrderId
          ? {
              label: t('quotations.fields.convertedOrder'),
              value: (
                <Link to={`/sales-orders/${quotation.convertedOrderId}`}>
                  {t('quotations.actions.openOrder')}
                </Link>
              ),
            }
          : false,
      ]
    : [];

  return (
    <>
      <DocumentPage
        title={quotation?.docNo ?? t('quotations.detailTitle')}
        badge={quotation ? <QuotationStatusBadge status={quotation.status} /> : undefined}
        status={status}
        actions={
          quotation ? (
            <>
              {quotation.status === 'draft' && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search: location.search }} />}
                >
                  {t('quotations.actions.edit')}
                </Button>
              ) : null}
              {quotation.status === 'draft' && confirm.can ? (
                <PendingButton busy={busy} onClick={() => void act('confirm')}>
                  {t('quotations.actions.confirm')}
                </PendingButton>
              ) : null}
              {(quotation.status === 'draft' || quotation.status === 'confirmed') &&
              voiding.can ? (
                <Button variant='outline' disabled={busy} onClick={() => setConfirming(true)}>
                  {t('quotations.actions.void')}
                </Button>
              ) : null}
              {quotation.status === 'confirmed' && convert.can ? (
                <Button disabled={busy} onClick={() => void act('convert')}>
                  {t('quotations.actions.convert')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {quotation ? (
          <>
            <DocumentSection title={t('quotations.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('quotations.fields.lines')}>
              <LinesTable<QuotationLine>
                columns={columns}
                rows={quotation.lines}
                getRowId={(line) => line.id}
                emptyMessage={t('quotations.form.linesEmpty')}
              />
            </DocumentSection>
            <DocumentSection title={t('quotations.totals')}>
              <QuotationTotals quotation={quotation} />
            </DocumentSection>
            <DocumentSection title={t('erp.docFiles.title')}>
              <DocFilesPanel
                files={quotation.files ?? []}
                ids={(quotation.files ?? []).map((file) => file.id)}
                disabled={filesBusy || !update.can || quotation.status !== 'draft'}
                onChange={(ids) => void changeFiles(ids)}
              />
              {fileError ? (
                <p role='alert' className='text-sm text-destructive'>
                  {fileError}
                </p>
              ) : null}
            </DocumentSection>
          </>
        ) : null}
      </DocumentPage>
      <ConfirmDialog
        open={confirming}
        title={t('quotations.voidTitle', { name: quotation?.docNo ?? '' })}
        description={t('quotations.voidDescription')}
        confirmLabel={t('quotations.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void act('void')}
      />
    </>
  );
}
