import {
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
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

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatNumber } from '../orders/model.js';
import {
  DOC_BASE,
  TransferClient,
  type GeneratedDocSummary,
  type TransferLine,
} from './client.js';
import { Dash, TransferStatusBadge } from './fields.js';
import { TRANSFERS_LIST_KEYS, TRANSFERS_RESOURCE } from './page-id.js';
import { useTransfer } from './record.js';

function qty(value: number, locale: string): ReactNode {
  return <span className='tabular-nums'>{formatNumber(value, locale)}</span>;
}

/** 一张调拨单的详情：逐行申请数与实调数、生成的两张单据链接与过账动作。 */
export default function TransferDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const id = useParams().transferId ?? '';
  const client = useMemo(() => new TransferClient(api), [api]);
  const view = useCan({ resource: TRANSFERS_RESOURCE, action: 'view' });
  const update = useCan({ resource: TRANSFERS_RESOURCE, action: 'update' });
  const post = useCan({ resource: TRANSFERS_RESOURCE, action: 'post' });
  const voiding = useCan({ resource: TRANSFERS_RESOURCE, action: 'void' });
  const record = useTransfer(id, view.can);
  const transfer = record.data;
  const [docs, setDocs] = useState<readonly GeneratedDocSummary[]>([]);
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.transfers'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, TRANSFERS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: transfer?.docNo ?? t('transfer.detailTitle') },
  ]);

  /** 生成的单据不在调拨单响应里，按端点提供的 transferDocId 反查出入库单。 */
  const transferId = transfer?.id;
  const transferStatus = transfer?.status;
  const canView = view.can;
  const reloadDocs = useCallback(() => {
    if (!transferId || transferStatus !== 'posted' || !canView) return;
    void (async () => {
      try {
        const result = await client.generatedDocs(transferId);
        setDocs(result.items);
      } catch {
        // 反查失败就先不放链接，详情本身照常显示。
      }
    })();
  }, [client, transferId, transferStatus, canView]);
  useEffect(() => {
    reloadDocs();
  }, [reloadDocs]);

  const runPost = async (): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.post(id);
      toaster.show({
        type: 'success',
        title: t('transfer.toasts.posted', { docNo: transfer?.docNo ?? '' }),
      });
      setPosting(false);
      record.reload();
    } catch (error) {
      setActionError(errorText(error, t));
      setPosting(false);
    } finally {
      setBusy(false);
    }
  };

  const runVoid = async (): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.void(id);
      toaster.show({
        type: 'success',
        title: t('transfer.toasts.voided', { docNo: transfer?.docNo ?? '' }),
      });
    } catch (error) {
      setActionError(errorText(error, t));
    } finally {
      setBusy(false);
      // 作废后这张单可能已不是草稿，重新读一次让按钮消失。
      record.reload();
    }
  };

  const columns = useMemo<ColumnDef<TransferLine>[]>(
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
        header: t('transfer.fields.item'),
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
        header: t('transfer.fields.unit'),
        cell: ({ row }) => row.original.item.unitCode || <Dash />,
      },
      {
        id: 'qty',
        header: t('transfer.fields.qty'),
        cell: ({ row }) => qty(row.original.qty, locale),
      },
      {
        id: 'transferQty',
        header: t('transfer.fields.transferQty'),
        cell: ({ row }) =>
          row.original.transferQty === null ? (
            <Dash />
          ) : (
            qty(row.original.transferQty, locale)
          ),
      },
      {
        id: 'note',
        header: t('transfer.fields.note'),
        cell: ({ row }) => row.original.note ?? <Dash />,
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
  else if (!transfer)
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
      <DocumentStatusBar tone={transfer.status === 'void' ? 'destructive' : 'neutral'}>
        {t(`transfer.statusBar.${transfer.status}`)}
      </DocumentStatusBar>
    );

  const base = `/transfers/${encodeURIComponent(transfer?.id ?? id)}`;
  const fields: (DetailField | false)[] = transfer
    ? [
        { label: t('transfer.fields.docDate'), value: transfer.docDate ?? <Dash /> },
        {
          label: t('transfer.fields.warehouseOut'),
          value: transfer.warehouseOut?.name ?? <Dash />,
        },
        { label: t('transfer.fields.warehouseIn'), value: transfer.warehouseIn.name },
        {
          label: t('transfer.fields.handler'),
          value: transfer.handler?.name ?? <Dash />,
        },
        { label: t('transfer.fields.remark'), value: transfer.remark, wide: true },
      ]
    : [];

  const posted = transfer?.status === 'posted';

  return (
    <>
      <DocumentPage
        title={transfer?.docNo ?? t('transfer.detailTitle')}
        badge={transfer ? <TransferStatusBadge status={transfer.status} /> : undefined}
        status={status}
        actions={
          transfer ? (
            <>
              {transfer.status === 'draft' && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search: location.search }} />}
                >
                  {t('erp.actions.edit')}
                </Button>
              ) : null}
              {transfer.status === 'draft' && voiding.can ? (
                <Button variant='outline' disabled={busy} onClick={() => void runVoid()}>
                  <ActionGlyph action='void' />
                  {t('transfer.actions.void')}
                </Button>
              ) : null}
              {/* 过账才改库存，先按会话实际持有的 post 动作显隐，再明确确认。 */}
              {transfer.status === 'draft' && post.can ? (
                <PendingButton busy={busy} action='post' onClick={() => setPosting(true)}>
                  {t('transfer.actions.post')}
                </PendingButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {transfer ? (
          <>
            <DocumentSection title={t('transfer.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('transfer.fields.lines')}>
              <LinesTable<TransferLine>
                columns={columns}
                rows={transfer.lines ?? []}
                getRowId={(line) => line.id}
                emptyMessage={t('transfer.form.linesEmpty')}
              />
            </DocumentSection>
            {posted ? (
              <DocumentSection title={t('transfer.generated.title')}>
                <div className='flex flex-col gap-2'>
                  <div>
                    <span className='text-sm text-muted-foreground'>
                      {t('transfer.generated.out')}
                    </span>{' '}
                    {docs.filter((doc) => doc.docType === 'out').length > 0 ? (
                      docs
                        .filter((doc) => doc.docType === 'out')
                        .map((doc) => (
                          <Link
                            key={doc.id}
                            to={`${DOC_BASE.out}/${encodeURIComponent(doc.id)}`}
                            data-testid='transfer-out-doc'
                          >
                            {doc.docNo}
                          </Link>
                        ))
                    ) : (
                      <Dash />
                    )}
                  </div>
                  <div>
                    <span className='text-sm text-muted-foreground'>
                      {t('transfer.generated.in')}
                    </span>{' '}
                    {docs.filter((doc) => doc.docType === 'in').length > 0 ? (
                      docs
                        .filter((doc) => doc.docType === 'in')
                        .map((doc) => (
                          <Link
                            key={doc.id}
                            to={`${DOC_BASE.in}/${encodeURIComponent(doc.id)}`}
                            data-testid='transfer-in-doc'
                          >
                            {doc.docNo}
                          </Link>
                        ))
                    ) : (
                      <Dash />
                    )}
                  </div>
                </div>
              </DocumentSection>
            ) : null}
          </>
        ) : null}
      </DocumentPage>
      <ConfirmDialog
        open={posting}
        title={t('transfer.postTitle', { docNo: transfer?.docNo ?? '' })}
        description={t('transfer.postDescription')}
        confirmLabel={t('transfer.actions.post')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setPosting(false)}
        onConfirm={() => void runPost()}
      />
      <Outlet />
    </>
  );
}
