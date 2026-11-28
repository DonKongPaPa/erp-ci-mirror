import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams, useResolvedPath } from 'react-router';

import { ActionGlyph } from '#components/action-glyph';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
} from '#components/erp/document';
import type { DetailField } from '#components/erp/detail';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { errorText, type Translate } from '#components/erp/messages';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatAmount } from '../orders/model.js';
import { FinanceRequestsClient } from './client.js';
import { RequestStatusBadge } from './fields.js';
import {
  FINANCE_REQUESTS_LIST_KEYS,
  FINANCE_REQUESTS_RESOURCE,
} from './page-id.js';
import { useFinanceRequest } from './record.js';

function money(value: number, locale: string, t: Translate): ReactNode {
  return (
    <span className='tabular-nums'>
      {t('financeRequestDocs.money', { amount: formatAmount(value, locale) })}
    </span>
  );
}

/** 一张请款 / 报销单的详情：表头、审批状态、附件与这一刻能做的操作。 */
export default function FinanceRequestDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const id = useParams().financeRequestId ?? '';
  const client = useMemo(() => new FinanceRequestsClient(api), [api]);
  const view = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'view' });
  const update = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'update' });
  const submit = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'submit' });
  const voiding = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'void' });
  const convert = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'convert' });
  const record = useFinanceRequest(id, view.can);
  const request = record.data;
  const editable =
    request?.status === 'draft' || request?.status === 'rejected';

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.financeRequests'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, FINANCE_REQUESTS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: request?.docNo ?? t('financeRequestDocs.detailTitle') },
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
        const result = await client.createExpense(request.id);
        toaster.show({
          type: 'success',
          title: t('financeRequestDocs.toasts.converted', { name: request.docNo }),
        });
        await navigate(`/expenses/${result.expenseRecordId}`);
        return;
      }
      await client[kind](request.id);
      toaster.show({
        type: 'success',
        title: t(
          kind === 'void'
            ? 'financeRequestDocs.toasts.voided'
            : 'financeRequestDocs.toasts.submitted',
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
        {t(`financeRequestDocs.statusBar.${request.status}`)}
      </DocumentStatusBar>
    );

  const base = `/finance-requests/${encodeURIComponent(request?.id ?? id)}`;
  const fields: (DetailField | false)[] = request
    ? [
        {
          label: t('financeRequestDocs.fields.docType'),
          value: t(`financeRequestDocs.docTypes.${request.docType}`),
        },
        { label: t('financeRequestDocs.fields.requestDate'), value: request.requestDate },
        {
          label: t('financeRequestDocs.fields.expenseType'),
          value: request.expenseTypeLabel ?? request.expenseTypeCode,
        },
        { label: t('financeRequestDocs.fields.amount'), value: money(request.amount, locale, t) },
        { label: t('financeRequestDocs.fields.handler'), value: request.handler.name },
        {
          label: t('financeRequestDocs.fields.project'),
          value: request.projectLabel ?? request.projectCode,
        },
        { label: t('financeRequestDocs.fields.reason'), value: request.reason, wide: true },
        request.approvalId
          ? {
              label: t('financeRequestDocs.fields.approval'),
              value: (
                <Link to={`/approvals/${request.approvalId}`}>
                  {t('financeRequestDocs.actions.openApproval')}
                </Link>
              ),
            }
          : false,
        request.expenseRecordId
          ? {
              label: t('financeRequestDocs.fields.convertedRecord'),
              value: (
                <Link to={`/expenses/${request.expenseRecordId}`}>
                  {t('financeRequestDocs.actions.openRecord')}
                </Link>
              ),
            }
          : false,
      ]
    : [];

  return (
    <>
      <DocumentPage
        title={request?.docNo ?? t('financeRequestDocs.detailTitle')}
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
                  {t('financeRequestDocs.actions.edit')}
                </Button>
              ) : null}
              {editable && voiding.can ? (
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  <ActionGlyph action='void' />
                  {t('financeRequestDocs.actions.void')}
                </Button>
              ) : null}
              {editable && submit.can ? (
                <PendingButton busy={busy} action='submit' onClick={() => void act('submit')}>
                  {t('financeRequestDocs.actions.submit')}
                </PendingButton>
              ) : null}
              {request.status === 'approved' && convert.can ? (
                <Button disabled={busy} onClick={() => void act('convert')}>
                  {t('financeRequestDocs.actions.convert')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {request ? (
          <>
            <DocumentSection title={t('financeRequestDocs.form.header')}>
              <DocumentHeaderFields fields={fields} />
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
        title={t('financeRequestDocs.voidTitle', { name: request?.docNo ?? '' })}
        description={t('financeRequestDocs.voidDescription')}
        confirmLabel={t('financeRequestDocs.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void act('void')}
      />
      <Outlet />
    </>
  );
}
