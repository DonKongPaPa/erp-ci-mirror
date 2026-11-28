import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams, useResolvedPath } from 'react-router';

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
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { TableCell } from '#components/ui/table';

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatAmount, formatNumber } from '../orders/model.js';
import {
  PurchaseRequestsClient,
  type RequestLine,
} from './client.js';
import { Dash, RequestStatusBadge } from './fields.js';
import {
  PURCHASE_REQUESTS_LIST_KEYS,
  PURCHASE_REQUESTS_RESOURCE,
} from './page-id.js';
import { usePurchaseRequest } from './record.js';

/** 数量最多四位小数、金额至少两位；服务端没算出来的合计画「—」，不当成 0。 */
function number(value: number | null, locale: string): ReactNode {
  return value === null || value === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>{formatNumber(value, locale)}</span>
  );
}

function money(value: number | null, locale: string, t: Translate): ReactNode {
  return value === null || value === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>
      {t('purchaseRequests.money', { amount: formatAmount(value, locale) })}
    </span>
  );
}

/** 一张请购单的详情：表头、明细、表尾合计、审批状态与这一刻能做的操作。 */
export default function PurchaseRequestDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const id = useParams().purchaseRequestId ?? '';
  const client = useMemo(() => new PurchaseRequestsClient(api), [api]);
  const view = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'view' });
  const update = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'update' });
  const submit = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'submit' });
  const voiding = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'void' });
  const convert = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'convert' });
  const record = usePurchaseRequest(id, view.can);
  const request = record.data;
  const editable =
    request?.status === 'draft' || request?.status === 'rejected';

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.purchaseRequests'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, PURCHASE_REQUESTS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: request?.docNo ?? t('purchaseRequests.detailTitle') },
  ]);

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileError, setFileError] = useState<string>();

  const act = async (kind: 'submit' | 'void' | 'convert'): Promise<void> => {
    if (!request) return;
    setBusy(true);
    setActionError(undefined);
    try {
      if (kind === 'convert') {
        const result = await client.createOrder(request.id);
        toaster.show({
          type: 'success',
          title: t('purchaseRequests.toasts.converted', { name: request.docNo }),
        });
        await navigate(`/purchase-orders/${result.purchaseOrderId}`);
        return;
      }
      await client[kind](request.id);
      toaster.show({
        type: 'success',
        title: t(
          kind === 'void'
            ? 'purchaseRequests.toasts.voided'
            : 'purchaseRequests.toasts.submitted',
          { name: request.docNo },
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
      record.reload();
    }
  };

  const changeFiles = async (ids: readonly string[]): Promise<void> => {
    if (!request || !editable || !update.can) return;
    setFilesBusy(true);
    setFileError(undefined);
    try {
      await client.update(request.id, { fileIds: [...ids] });
      record.reload();
    } catch (next) {
      setFileError(errorText(next, t));
    } finally {
      setFilesBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<RequestLine>[]>(
    () => [
      {
        id: 'index',
        header: '#',
        cell: ({ row }) => (
          <span className='text-muted-foreground tabular-nums'>
            {row.index + 1}
          </span>
        ),
      },
      {
        id: 'item',
        header: t('purchaseRequests.fields.item'),
        cell: ({ row }) => (
          <span className='flex min-w-0 flex-col'>
            <span className='font-medium tabular-nums'>
              {row.original.item.code}
            </span>
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
        header: t('purchaseRequests.fields.unit'),
        cell: ({ row }) => row.original.item.unitCode || <Dash />,
      },
      {
        id: 'qty',
        header: t('purchaseRequests.fields.qty'),
        cell: ({ row }) => number(row.original.qty, locale),
      },
      {
        id: 'expectedPrice',
        header: t('purchaseRequests.fields.expectedPrice'),
        cell: ({ row }) => money(row.original.expectedPrice, locale, t),
      },
      {
        id: 'expectedAmount',
        header: t('purchaseRequests.fields.expectedAmount'),
        cell: ({ row }) => money(row.original.expectedAmount, locale, t),
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
  else if (!request)
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
      <DocumentStatusBar tone={request.status === 'rejected' ? 'destructive' : 'neutral'}>
        {t(`purchaseRequests.statusBar.${request.status}`)}
      </DocumentStatusBar>
    );

  const base = `/purchase-requests/${encodeURIComponent(request?.id ?? id)}`;
  const fields: (DetailField | false)[] = request
    ? [
        { label: t('purchaseRequests.fields.requestDate'), value: request.requestDate },
        { label: t('purchaseRequests.fields.department'), value: request.department.name },
        { label: t('purchaseRequests.fields.requester'), value: request.requester.name },
        {
          label: t('purchaseRequests.fields.project'),
          value: request.projectLabel ?? request.projectCode,
        },
        { label: t('purchaseRequests.fields.customText1'), value: request.customText1 },
        { label: t('purchaseRequests.fields.customText2'), value: request.customText2 },
        { label: t('purchaseRequests.fields.description'), value: request.description, wide: true },
        request.approvalId
          ? {
              label: t('purchaseRequests.fields.approval'),
              value: (
                <Link to={`/approvals/${request.approvalId}`}>
                  {t('purchaseRequests.actions.openApproval')}
                </Link>
              ),
            }
          : false,
        request.convertedOrderId
          ? {
              label: t('purchaseRequests.fields.convertedOrder'),
              value: (
                <Link to={`/purchase-orders/${request.convertedOrderId}`}>
                  {t('purchaseRequests.actions.openOrder')}
                </Link>
              ),
            }
          : false,
      ]
    : [];

  return (
    <>
      <DocumentPage
        title={request?.docNo ?? t('purchaseRequests.detailTitle')}
        badge={request ? <RequestStatusBadge status={request.status} /> : undefined}
        status={status}
        actions={
          request ? (
            <>
              {editable && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search: location.search }} />}
                >
                  {t('purchaseRequests.actions.edit')}
                </Button>
              ) : null}
              {editable && voiding.can ? (
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  {t('purchaseRequests.actions.void')}
                </Button>
              ) : null}
              {editable && submit.can ? (
                <PendingButton busy={busy} onClick={() => void act('submit')}>
                  {t('purchaseRequests.actions.submit')}
                </PendingButton>
              ) : null}
              {request.status === 'approved' && convert.can ? (
                <Button disabled={busy} onClick={() => void act('convert')}>
                  {t('purchaseRequests.actions.convert')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {request ? (
          <>
            <DocumentSection title={t('purchaseRequests.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('purchaseRequests.fields.lines')}>
              <LinesTable<RequestLine>
                columns={columns}
                rows={request.lines}
                getRowId={(line) => line.id}
                totals={
                  <>
                    <TableCell colSpan={columns.length - 3} className='text-right font-medium'>
                      {t('purchaseRequests.fields.totalQty')}
                    </TableCell>
                    <TableCell className='text-right font-medium' data-testid='request-total-qty'>
                      {number(request.totalQty, locale)}
                    </TableCell>
                    <TableCell className='text-right font-medium'>
                      {t('purchaseRequests.fields.estimatedTotal')}
                    </TableCell>
                    <TableCell className='text-right font-medium' data-testid='request-estimated-total'>
                      {money(request.estimatedTotal, locale, t)}
                    </TableCell>
                  </>
                }
                emptyMessage={t('purchaseRequests.form.linesEmpty')}
              />
            </DocumentSection>
            <DocumentSection title={t('erp.docFiles.title')}>
              <DocFilesPanel
                files={request.files}
                ids={request.files.map((file) => file.id)}
                disabled={filesBusy || !editable || !update.can}
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
        title={t('purchaseRequests.voidTitle', { name: request?.docNo ?? '' })}
        description={t('purchaseRequests.voidDescription')}
        confirmLabel={t('purchaseRequests.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void act('void')}
      />
      <Outlet />
    </>
  );
}
