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
import { usePersonOptions } from '#components/erp/options';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { TableCell } from '#components/ui/table';

import { useAncestorSearch } from '../../routing/route-context.js';
import { formatNumber } from '../orders/model.js';
import {
  StocktakingClient,
  DOC_BASE,
  type GeneratedDocSummary,
  type StocktakingLine,
} from './client.js';
import { Dash, StocktakingStatusBadge } from './fields.js';
import { FinishDialog } from './FinishDialog.js';
import {
  STOCKTAKINGS_LIST_KEYS,
  STOCKTAKINGS_RESOURCE,
} from './page-id.js';
import { useStocktaking } from './record.js';

function qty(value: number, locale: string): ReactNode {
  return <span className='tabular-nums'>{formatNumber(value, locale)}</span>;
}

/** 一张盘点单的详情：逐行盈亏与合计、生成的盘盈盘亏单链接，以及按动作显隐的操作。 */
export default function StocktakingDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const id = useParams().stocktakingId ?? '';
  const client = useMemo(() => new StocktakingClient(api), [api]);
  const view = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'view' });
  const update = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'update' });
  const finish = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'finish' });
  const voiding = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'void' });
  const people = usePersonOptions(view.can);
  const record = useStocktaking(id, view.can);
  const stock = record.data;
  const [profitDocs, setProfitDocs] = useState<readonly GeneratedDocSummary[]>([]);
  const [lossDocs, setLossDocs] = useState<readonly GeneratedDocSummary[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [voidingOpen, setVoidingOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const owner = useResolvedPath('..').pathname;
  const listLevel = {
    label: t('navigation.stocktakings'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, STOCKTAKINGS_LIST_KEYS),
    },
  };
  usePageBreadcrumb([
    listLevel,
    { label: stock?.docNo ?? t('stocktaking.detailTitle') },
  ]);

  /** 生成的单据不在盘点单响应里，按端点提供的 stocktakingId 反查出入库单，拿到可跳转的单号。 */
  const stockId = stock?.id;
  const stockStatus = stock?.status;
  const canView = view.can;
  const reloadDocs = useCallback(() => {
    if (!stockId || stockStatus !== 'finished' || !canView) return;
    void (async () => {
      try {
        const [profit, loss] = await Promise.all([
          client.generatedDocs(stockId, 'in'),
          client.generatedDocs(stockId, 'out'),
        ]);
        setProfitDocs(profit.items);
        setLossDocs(loss.items);
      } catch {
        // 反查失败就先不放链接，详情本身照常显示。
      }
    })();
  }, [client, stockId, stockStatus, canView]);
  useEffect(() => {
    reloadDocs();
    // 仅在单据 id 与状态落定后反查一次；手动动作之后由 reloadDocs 再取。
  }, [reloadDocs]);

  const runFinish = async (supervisorUserId: string): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.finish(id, { supervisorUserId });
      toaster.show({
        type: 'success',
        title: t('stocktaking.toasts.finished', { docNo: stock?.docNo ?? '' }),
      });
      setFinishing(false);
      record.reload();
    } catch (error) {
      setActionError(errorText(error, t));
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
        title: t('stocktaking.toasts.voided', { docNo: stock?.docNo ?? '' }),
      });
      setVoidingOpen(false);
      record.reload();
    } catch (error) {
      setActionError(errorText(error, t));
      setVoidingOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<StocktakingLine>[]>(
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
        header: t('stocktaking.fields.item'),
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
        header: t('stocktaking.fields.unit'),
        cell: ({ row }) => row.original.item.unitCode || <Dash />,
      },
      {
        id: 'systemQty',
        header: t('stocktaking.fields.systemQty'),
        cell: ({ row }) => qty(row.original.systemQty, locale),
      },
      {
        id: 'actualQty',
        header: t('stocktaking.fields.actualQty'),
        cell: ({ row }) =>
          row.original.actualQty === null ? (
            <Dash />
          ) : (
            qty(row.original.actualQty, locale)
          ),
      },
      {
        id: 'deltaQty',
        header: t('stocktaking.fields.deltaQty'),
        cell: ({ row }) =>
          row.original.deltaQty === null ? (
            <Dash />
          ) : (
            qty(row.original.deltaQty, locale)
          ),
      },
      {
        id: 'result',
        header: t('stocktaking.fields.result'),
        cell: ({ row }) =>
          row.original.result === null ? (
            <Dash />
          ) : (
            t(`stocktaking.results.${row.original.result}`)
          ),
      },
      {
        id: 'note',
        header: t('stocktaking.fields.note'),
        cell: ({ row }) => row.original.note ?? <Dash />,
      },
    ],
    [t, locale],
  );

  // 盈亏合计按服务端写好的逐行 deltaQty 加总；没结束的单据不画合计。
  const profitTotal = (stock?.lines ?? []).reduce(
    (sum, line) => sum + (line.deltaQty !== null && line.deltaQty > 0 ? line.deltaQty : 0),
    0,
  );
  const lossTotal = (stock?.lines ?? []).reduce(
    (sum, line) => sum + (line.deltaQty !== null && line.deltaQty < 0 ? -line.deltaQty : 0),
    0,
  );
  const ended = stock?.status === 'finished';

  let status: ReactNode;
  if (!view.isPending && !view.can)
    status = (
      <DocumentStatusBar tone='destructive'>
        {t('erp.errors.denied')}
      </DocumentStatusBar>
    );
  else if (!stock)
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
      <DocumentStatusBar tone={stock.status === 'void' ? 'destructive' : 'neutral'}>
        {t(`stocktaking.statusBar.${stock.status}`)}
      </DocumentStatusBar>
    );

  const base = `/stocktakings/${encodeURIComponent(stock?.id ?? id)}`;
  const fields: (DetailField | false)[] = stock
    ? [
        { label: t('stocktaking.fields.docDate'), value: stock.docDate },
        { label: t('stocktaking.fields.warehouse'), value: stock.warehouse.name },
        {
          label: t('stocktaking.fields.handler'),
          value: stock.handler?.name ?? <Dash />,
        },
        {
          label: t('stocktaking.fields.supervisor'),
          value: stock.supervisor?.name ?? <Dash />,
        },
        { label: t('stocktaking.fields.remark'), value: stock.remark, wide: true },
      ]
    : [];

  const docLink = (doc: GeneratedDocSummary): ReactElement => (
    <Link
      to={`${DOC_BASE[doc.docType]}/${encodeURIComponent(doc.id)}`}
      data-testid={`stocktaking-${doc.docType === 'in' ? 'profit' : 'loss'}-doc`}
    >
      {doc.docNo}
    </Link>
  );

  return (
    <>
      <DocumentPage
        title={stock?.docNo ?? t('stocktaking.detailTitle')}
        badge={stock ? <StocktakingStatusBadge status={stock.status} /> : undefined}
        status={status}
        actions={
          stock ? (
            <>
              {stock.status === 'staging' && update.can ? (
                <Button
                  variant='outline'
                  nativeButton={false}
                  render={<Link to={{ pathname: `${base}/edit`, search: location.search }} />}
                >
                  {t('erp.actions.edit')}
                </Button>
              ) : null}
              {stock.status === 'staging' && voiding.can ? (
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setVoidingOpen(true)}
                >
                  <ActionGlyph action='void' />
                  {t('stocktaking.actions.void')}
                </Button>
              ) : null}
              {/* 结束盘点只按会话实际持有的 finish 动作显隐，不按角色名猜。 */}
              {stock.status === 'staging' && finish.can ? (
                <PendingButton busy={busy} action='post' onClick={() => setFinishing(true)}>
                  {t('stocktaking.actions.finish')}
                </PendingButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {stock ? (
          <>
            <DocumentSection title={t('stocktaking.form.header')}>
              <DocumentHeaderFields fields={fields} />
            </DocumentSection>
            <DocumentSection title={t('stocktaking.fields.lines')}>
              <LinesTable<StocktakingLine>
                columns={columns}
                rows={stock.lines ?? []}
                getRowId={(line) => line.id}
                totals={
                  ended ? (
                    <>
                      <TableCell colSpan={columns.length - 2} className='text-right font-medium'>
                        {t('stocktaking.fields.totals')}
                      </TableCell>
                      <TableCell className='text-right font-medium' data-testid='stocktaking-profit-total'>
                        {t('stocktaking.fields.profitTotal')}: {qty(profitTotal, locale)}
                      </TableCell>
                      <TableCell className='text-right font-medium' data-testid='stocktaking-loss-total'>
                        {t('stocktaking.fields.lossTotal')}: {qty(lossTotal, locale)}
                      </TableCell>
                    </>
                  ) : undefined
                }
                emptyMessage={t('stocktaking.form.linesEmpty')}
              />
            </DocumentSection>
            {ended ? (
              <DocumentSection title={t('stocktaking.generated.title')}>
                <div className='flex flex-col gap-2'>
                  <div>
                    <span className='text-sm text-muted-foreground'>
                      {t('stocktaking.generated.profit')}
                    </span>{' '}
                    {profitDocs.length > 0 ? (
                      profitDocs.map((doc) => (
                        <span key={doc.id}>{docLink(doc)}</span>
                      ))
                    ) : (
                      <Dash />
                    )}
                  </div>
                  <div>
                    <span className='text-sm text-muted-foreground'>
                      {t('stocktaking.generated.loss')}
                    </span>{' '}
                    {lossDocs.length > 0 ? (
                      lossDocs.map((doc) => (
                        <span key={doc.id}>{docLink(doc)}</span>
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
        open={voidingOpen}
        title={t('stocktaking.voidTitle', { docNo: stock?.docNo ?? '' })}
        description={t('stocktaking.voidDescription')}
        confirmLabel={t('stocktaking.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setVoidingOpen(false)}
        onConfirm={() => void runVoid()}
      />
      {finishing ? (
        <FinishDialog
          people={people.items ?? []}
          busy={busy}
          error={actionError}
          onClose={() => setFinishing(false)}
          onConfirm={(supervisorUserId) => void runFinish(supervisorUserId)}
        />
      ) : null}
      <Outlet />
    </>
  );
}
