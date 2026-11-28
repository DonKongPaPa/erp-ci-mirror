import { useApiClient, usePageBreadcrumb, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Link,
  Outlet,
  useLocation,
  useResolvedPath,
  useParams,
  type To,
} from 'react-router';

import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
  LinesTable,
} from '#components/erp/document';
import { ConfirmDialog } from '#components/erp/confirm';
import type { DetailField } from '#components/erp/detail';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { errorText, type Translate } from '#components/erp/messages';
import { StatusBadge } from '#components/status-badge';
import { useRecord } from '#components/erp/record';
import { Button } from '#components/ui/button';
import { formatDateTime, formatQty } from '../stock/format.js';
import { ITEMS_RESOURCE, useInventoryLookup } from '../stock/lookup.js';
import { INVENTORY_RESOURCE } from '../warehouses/page-id.js';
import { useAncestorSearch } from '../../routing/route-context.js';
import { DOC_PRINT_PATHS, DOC_PRINT_REASON_PATHS } from '../doc-print/model.js';
import { readPrintTrace } from '../doc-print/trace.js';

import { StockDocsClient, type StockDoc, type StockDocLine } from './client.js';
import type { StockKind } from './kind.js';
import { stockKey, useLineStock } from './line-stock.js';
import { isNotDraft, needsSource, STOCK_DOC_LIST_KEYS } from './model.js';

/** 详情交给盖在它上面的编辑子页的东西：面包屑的层级与重新取数。 */
export interface StockDocDetailContext {
  readonly levels: readonly {
    readonly label: string;
    readonly to?: To;
  }[];
  readonly reload: () => void;
}

const NO_LINES: readonly StockDocLine[] = [];
const DASH = <span className='text-muted-foreground'>—</span>;
const NUMBER = 'flex justify-end tabular-nums';
type Action = 'post' | 'void';

function money(value: number | null | undefined, locale: string, t: Translate): ReactNode {
  return value === null || value === undefined
    ? DASH
    : <span className='tabular-nums'>{t('orderDocs.money', { amount: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value) })}</span>;
}

/**
 * 一张入库单或出库单（`/inbound-orders/:docId`、`/outbound-orders/:docId`，《基座ERP前端设计》2.4）：
 * 盖在列表上的子页。页头是单号与状态徽标加这一刻能做的操作，下面是状态条、表头与明细。
 * 草稿能编辑、过账、作废；已过账、已作废的没有任何操作。
 */
export function StockDocDetailPage({ def }: { readonly def: StockKind }): ReactElement {
  const { docId = '' } = useParams();
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const location = useLocation();
  const client = useMemo(() => new StockDocsClient(api), [api]);
  const view = useCan({ resource: INVENTORY_RESOURCE, action: 'stockView' });
  const write = useCan({ resource: INVENTORY_RESOURCE, action: 'stockWrite' });
  const posting = useCan({ resource: INVENTORY_RESOURCE, action: 'stockPost' });
  const voiding = useCan({ resource: INVENTORY_RESOURCE, action: 'stockVoid' });
  const priceView = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'stockPriceView',
  });
  const itemView = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const warehouseView = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseView',
  });
  // R-076：只有持有对应单据类型 print 动作的人才看到「打印」按钮。
  const printInternal = useCan({
    resource: { type: 'composite', id: DOC_PRINT_PATHS['internal-use'].resource },
    action: 'print',
  });
  const printSales = useCan({
    resource: { type: 'composite', id: DOC_PRINT_PATHS['sales-issue'].resource },
    action: 'print',
  });
  const printPurchase = useCan({
    resource: { type: 'composite', id: DOC_PRINT_PATHS['purchase-receipt'].resource },
    action: 'print',
  });
  const record = useRecord<StockDoc>(
    `stock-docs/${encodeURIComponent(docId)}`,
    view.can,
  );
  // 另一个方向的单据（拿入库单的地址打开一张出库单）当作不存在。
  const doc = record.data?.docType === def.kind ? record.data : undefined;
  // 打印视图点过「打印」之后，痕迹在本次标签页里留着；回到详情要看得到并重新取详情。
  const trace = readPrintTrace(doc?.docNo);
  const traceKey = trace === undefined ? '' : `${doc?.docNo}:${trace.printCount}`;
  const reloadedForRef = useRef('');
  useEffect(() => {
    if (traceKey === '' || reloadedForRef.current === traceKey) return;
    reloadedForRef.current = traceKey;
    record.reload();
  }, [traceKey, record]);
  // 出库草稿每一行旁边带现存量；入库单与其余状态不带。
  const showHand = doc?.status === 'draft' && def.kind === 'out';
  const hand = useLineStock(
    doc?.lines ?? NO_LINES,
    Boolean(showHand) && view.can,
  );
  const lookup = useInventoryLookup({
    items: view.can && itemView.can,
    warehouses: view.can && warehouseView.can,
  });

  // 面包屑：列表 › 单号。回列表的地址带着离开时的搜索、筛选与页码。
  const owner = useResolvedPath('..').pathname;
  const self = useResolvedPath('.').pathname;
  const listSearch = useAncestorSearch(owner, STOCK_DOC_LIST_KEYS);
  const selfSearch = useAncestorSearch(self, STOCK_DOC_LIST_KEYS);
  const listLabel = t(`stockDocs.${def.words}.title`);
  const docNo = doc?.docNo;
  const fallback = t('stockDocs.detail');
  const levels = useMemo(
    () => [
      { label: listLabel, to: { pathname: owner, search: listSearch } },
      { label: docNo ?? fallback, to: { pathname: self, search: selfSearch } },
    ],
    [listLabel, owner, listSearch, docNo, fallback, self, selfSearch],
  );
  usePageBreadcrumb(levels);

  const [confirm, setConfirm] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileError, setFileError] = useState<string>();

  /** 附件随整组 fileIds 存草稿；已过账、已作废的单据只读。 */
  const changeFiles = async (ids: readonly string[]): Promise<void> => {
    if (!doc || doc.status !== 'draft') return;
    setFilesBusy(true);
    setFileError(undefined);
    try {
      await client.update(doc.id, { fileIds: [...ids], lines: doc.lines });
      record.reload();
    } catch (next) {
      setFileError(errorText(next, t));
    } finally {
      setFilesBusy(false);
    }
  };

  /** 过账与作废。都先过下面的确认框。 */
  const run = async (action: Action, target: StockDoc) => {
    setBusy(true);
    setActionError(undefined);
    try {
      const saved =
        action === 'post' ? await client.post(target.id) : await client.voidDoc(target.id);
      record.replaceData(saved);
      toaster.show({
        type: 'success',
        title:
          action === 'post'
            ? t(`stockDocs.${def.words}.postedToast`, { docNo: saved.docNo })
            : t(`stockDocs.${def.words}.voidedToast`, { docNo: saved.docNo }),
      });
      setConfirm(undefined);
    } catch (error) {
      if (isNotDraft(error)) {
        // 单据已不是草稿（别处刚过账或作废）：按最新的一张重画，确认框关掉。
        setConfirm(undefined);
        record.reload();
        toaster.show({ type: 'error', title: errorText(error, t) });
      } else {
        setActionError(errorText(error, t));
      }
    } finally {
      setBusy(false);
    }
  };
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const stockOf = (line: StockDocLine): number =>
    hand.stock?.[stockKey(line)] ?? 0;
  // 超过现存量的行：标红，过账按钮不能用。现存量没读出来之前先不下结论。
  const over = doc?.lines.filter((line) => line.qty > stockOf(line)) ?? [];
  // R1：销售出库过账必须有来源销售订单；R3：内部领用必须有领用部门与领用人。
  const needsTaker = doc?.reason === 'internal_use' && !(doc.takerDepartmentId && doc.takerUserId);
  const blocked =
    (Boolean(showHand) && hand.stock !== undefined && over.length > 0) ||
    Boolean(doc && needsSource(doc)) ||
    needsTaker;

  const lineColumns = useMemo<ColumnDef<StockDocLine>[]>(() => {
    const columns: ColumnDef<StockDocLine>[] = [
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
        header: t('stockDocs.columns.item'),
        cell: ({ row }) => {
          const item = lookup.item(row.original.itemId);
          return (
            <span className='flex flex-wrap items-center gap-2'>
              <span className='font-medium tabular-nums'>
                {item?.code ?? row.original.itemId}
              </span>
              {item ? <span>{item.name}</span> : null}
            </span>
          );
        },
      },
      {
        id: 'warehouse',
        header: t('stockDocs.columns.warehouse'),
        cell: ({ row }) =>
          lookup.warehouse(row.original.warehouseId)?.name ??
          row.original.warehouseId,
      },
      {
        id: 'batchNo',
        header: t('stockDocs.columns.batch'),
        cell: ({ row }) => row.original.batchNo || DASH,
      },
      {
        id: 'qty',
        header: t('stockDocs.columns.qty'),
        cell: ({ row }) => (
          <span className={NUMBER}>
            {formatQty(row.original.qty, locale)}
          </span>
        ),
      },
    ];
    if (priceView.can) {
      columns.push(
        {
          id: 'taxRate',
          header: t('stockDocs.columns.taxRate'),
          cell: ({ row }) => row.original.taxRate ?? DASH,
        },
        {
          id: 'taxIncludedPrice',
          header: t('stockDocs.columns.taxIncludedPrice'),
          cell: ({ row }) => row.original.taxIncludedPrice ?? DASH,
        },
        {
          id: 'taxExcludedPrice',
          header: t('stockDocs.columns.taxExcludedPrice'),
          cell: ({ row }) => row.original.taxExcludedPrice ?? DASH,
        },
        {
          id: 'taxExcludedAmount',
          header: t('stockDocs.columns.taxExcludedAmount'),
          cell: ({ row }) => money(row.original.taxExcludedAmount, locale, t),
        },
        {
          id: 'taxAmount',
          header: t('stockDocs.columns.taxAmount'),
          cell: ({ row }) => money(row.original.taxAmount, locale, t),
        },
        {
          id: 'taxIncludedAmount',
          header: t('stockDocs.columns.taxIncludedAmount'),
          cell: ({ row }) => money(row.original.taxIncludedAmount, locale, t),
        },
        {
          id: 'productionDate',
          header: t('stockDocs.columns.productionDate'),
          cell: ({ row }) => row.original.productionDate ?? DASH,
        },
        {
          id: 'expiryDate',
          header: t('stockDocs.columns.expiryDate'),
          cell: ({ row }) => row.original.expiryDate ?? DASH,
        },
        {
          id: 'note',
          header: t('erp.fields.note'),
          cell: ({ row }) => row.original.note ?? DASH,
        },
      );
    }
    if (!showHand) return columns;
    return [
      ...columns,
      {
        id: 'onHand',
        header: t('stockDocs.columns.onHand'),
        cell: ({ row }) => {
          if (hand.stock === undefined)
            return (
              <span className='text-muted-foreground'>
                {t('stockDocs.loadingStock')}
              </span>
            );
          const stock = hand.stock?.[stockKey(row.original)] ?? 0;
          return (
            <span
              className={
                row.original.qty > stock
                  ? `${NUMBER} text-destructive`
                  : NUMBER
              }
            >
              {row.original.qty > stock
                ? t('stockDocs.overBy', {
                    onHand: formatQty(stock, locale),
                    over: formatQty(row.original.qty - stock, locale),
                  })
                : formatQty(stock, locale)}
            </span>
          );
        },
      },
    ];
    // stockOf 只读 hand.stock；lookup 的两个查找函数引用是稳定的。
  }, [t, locale, lookup, showHand, hand.stock, priceView.can]);

  // 权限没落定、单据还没读到：先画页头与一句「加载中」。没有读的权限、读不到时各自说明。
  if (!doc)
    return (
      <DocumentPage
        title={fallback}
        status={
          <DocumentStatusBar
            tone={
              !view.isPending && (!view.can || record.error !== undefined)
                ? 'destructive'
                : undefined
            }
          >
            <span>
              {view.isPending || (view.can && record.error === undefined)
                ? t('status.loading')
                : view.can
                  ? errorText(record.error, t)
                  : t('erp.errors.denied')}
            </span>
            {!view.isPending && view.can && record.error !== undefined ? (
              <Button size='sm' variant='outline' onClick={record.reload}>
                {t('status.retry')}
              </Button>
            ) : null}
          </DocumentStatusBar>
        }
      >
        {/* 编辑子页自己读单据；父页还没读到时也必须挂上，否则子页不会渲染，两边都停在「加载中」。 */}
        <Outlet
          context={{ levels, reload: record.reload } satisfies StockDocDetailContext}
        />
      </DocumentPage>
    );

  const draft = doc.status === 'draft';
  const editing = draft && write.can;
  const search = location.search;
  const fields: (DetailField | false)[] = [
    {
      label: t('stockDocs.fields.reason'),
      value: t(`stockDocs.reasons.${doc.reason}`),
    },
    {
      label: t('stockDocs.fields.source'),
      value: doc.sourceType
        ? t(`stockDocs.source.${doc.sourceType}`)
        : t('stockDocs.source.manual'),
    },
    {
      label: t(`stockDocs.${def.words}.docDate`),
      value: doc.docDate ?? formatDateTime(doc.createdAt, locale),
    },
    {
      label: t(`stockDocs.${def.words}.partner`),
      value: doc.partner?.name ?? doc.partnerId,
    },
    { label: t('stockDocs.fields.contactName'), value: doc.contactName },
    { label: t('stockDocs.fields.contactPhone'), value: doc.contactPhone },
    {
      label: t('stockDocs.fields.deliveryAddress'),
      value: doc.deliveryAddress,
      wide: true,
    },
    ...(def.kind === 'out'
      ? [{ label: t('stockDocs.fields.customerOrderNo'), value: doc.customerOrderNo }]
      : []),
    {
      label: t('stockDocs.fields.project'),
      value: doc.projectLabel ?? doc.projectCode,
    },
    { label: t('stockDocs.fields.handler'), value: doc.handler?.name },
    {
      label: t('stockDocs.fields.takerDepartment'),
      value: doc.takerDepartment?.name,
    },
    { label: t('stockDocs.fields.taker'), value: doc.taker?.name },
    ...(priceView.can
      ? [
          {
            label: t('orderDocs.fields.totalQty'),
            value: doc.totalQty ?? DASH,
          },
          {
            label: t('orderDocs.fields.taxIncludedTotal'),
            value: money(doc.taxIncludedTotal, locale, t),
          },
          {
            label: t('orderDocs.fields.taxExcludedTotal'),
            value: money(doc.taxExcludedTotal, locale, t),
          },
          {
            label: t('orderDocs.fields.taxTotal'),
            value: money(doc.taxTotal, locale, t),
          },
          {
            label: t('orderDocs.fields.discountAmount'),
            value: money(doc.discountAmount, locale, t),
          },
          {
            label: t(`${def.kind === 'in' ? 'purchaseOrders' : 'salesOrders'}.payableLabel`),
            value: money(doc.payableTotal, locale, t),
          },
        ]
      : []),
    {
      label: t('stockDocs.fields.createdAt'),
      value: formatDateTime(doc.createdAt, locale),
    },
    {
      label: t('stockDocs.fields.postedAt'),
      value: doc.postedAt ? formatDateTime(doc.postedAt, locale) : null,
    },
    {
      label: t('docPrint.printCount'),
      value: trace === undefined ? DASH : String(trace.printCount),
    },
    {
      label: t('docPrint.lastPrintedBy'),
      value: trace?.lastPrintedByName || DASH,
    },
    { label: t('erp.fields.note'), value: doc.remark },
  ];
  const printPath = DOC_PRINT_REASON_PATHS[doc.reason as keyof typeof DOC_PRINT_REASON_PATHS];
  const canPrint =
    printPath !== undefined &&
    (printPath === 'internal-use'
      ? printInternal.can
      : printPath === 'sales-issue'
        ? printSales.can
        : printPurchase.can);
  const printButton =
    printPath === undefined || !canPrint ? null : (
      <Button
        variant='outline'
        nativeButton={false}
        render={
          <Link to={`/main/doc-print/${printPath}/${encodeURIComponent(doc.docNo)}`} />
        }
      >
        {t('docPrint.print')}
      </Button>
    );
  const actions =
    draft && (editing || posting.can || voiding.can) ? (
      <span className='flex flex-wrap items-center gap-2'>
        {voiding.can ? (
          <Button variant='outline' disabled={busy} onClick={() => setConfirm('void')}>
            {t('stockDocs.void')}
          </Button>
        ) : null}
        {editing ? (
          <Button
            variant='outline'
            nativeButton={false}
            render={
              <Link
                to={{
                  pathname: `${def.base}/${encodeURIComponent(doc.id)}/edit`,
                  search,
                }}
              />
            }
          >
            {t('erp.actions.edit')}
          </Button>
        ) : null}
        {posting.can ? (
          <Button
            disabled={busy || blocked}
            onClick={() => setConfirm('post')}
            title={blocked ? t('stockDocs.shortage', { lines: over.length }) : undefined}
          >
            {t('stockDocs.post')}
          </Button>
        ) : null}
        {printButton}
      </span>
    ) : printButton ? (
      <span className='flex flex-wrap items-center gap-2'>{printButton}</span>
    ) : undefined;

  return (
    <DocumentPage
      title={doc.docNo}
      badge={<StatusBadgeOf status={doc.status} />}
      actions={actions}
      status={
        doc.status === 'posted' ? (
          <DocumentStatusBar tone='info'>
            <span>{t(`stockDocs.${def.words}.postedStatus`)}</span>
            {doc.postedAt ? (
              <span className='text-muted-foreground'>
                {t('stockDocs.postedWith', {
                  time: formatDateTime(doc.postedAt, locale),
                })}
              </span>
            ) : null}
            <Link
              to='/stock'
              className='font-medium underline-offset-4 hover:underline'
            >
              {t('stockDocs.viewStock')}
            </Link>
          </DocumentStatusBar>
        ) : doc.status === 'void' ? (
          <DocumentStatusBar>{t('stockDocs.voidStatus')}</DocumentStatusBar>
        ) : blocked ? (
          <DocumentStatusBar tone='destructive'>
            <span>
              {doc && needsSource(doc)
                ? t('stockDocs.sourceRequired')
                : needsTaker
                  ? t('stockDocs.takerRequired')
                  : t('stockDocs.shortage', { lines: over.length })}
            </span>
            {editing ? (
              <Link
                to={{
                  pathname: `${def.base}/${encodeURIComponent(doc.id)}/edit`,
                  search,
                }}
                className='font-medium underline-offset-4 hover:underline'
              >
                {t('erp.actions.edit')}
              </Link>
            ) : null}
          </DocumentStatusBar>
        ) : (
          <DocumentStatusBar>{t(`stockDocs.${def.words}.draftStatus`)}</DocumentStatusBar>
        )
      }
    >
      <DocumentSection title={t('stockDocs.header')}>
        <DocumentHeaderFields fields={fields} />
      </DocumentSection>
      <DocumentSection title={t('stockDocs.lines')}>
        <LinesTable<StockDocLine>
          columns={lineColumns}
          rows={doc.lines}
          getRowId={(line) => line.id}
          emptyMessage={t('stockDocs.noLines')}
        />
      </DocumentSection>
      <DocumentSection title={t('erp.docFiles.title')}>
        <DocFilesPanel
          files={doc.files ?? []}
          ids={(doc.files ?? []).map((file) => file.id)}
          disabled={filesBusy || doc.status !== 'draft'}
          onChange={(ids) => void changeFiles(ids)}
        />
        {fileError ? (
          <p role='alert' className='text-sm text-destructive'>
            {fileError}
          </p>
        ) : null}
      </DocumentSection>
      <ConfirmDialog
        open={confirm !== undefined}
        title={
          confirm === 'post'
            ? t(`stockDocs.${def.words}.postTitle`, { docNo: doc.docNo })
            : t(`stockDocs.${def.words}.voidTitle`, { docNo: doc.docNo })
        }
        description={
          confirm === 'post'
            ? t(`stockDocs.${def.words}.postDescription`)
            : t('stockDocs.voidDescription')
        }
        confirmLabel={
          confirm === 'post' ? t('stockDocs.post') : t('stockDocs.void')
        }
        error={
          actionError ? <span role='alert'>{actionError}</span> : undefined
        }
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (confirm) void runRef.current(confirm, doc);
        }}
      />
      {/* 编辑这一张单的子页从这里出来。 */}
      <Outlet context={{ levels, reload: record.reload } satisfies StockDocDetailContext} />
    </DocumentPage>
  );
}

/** 单据的状态徽标：草稿、已作废是灰的，已过账是绿的。颜色只是辅助，字里已经写明。 */
function StatusBadgeOf({ status }: { readonly status: StockDoc['status'] }): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={status === 'posted' ? 'success' : 'neutral'}>
      {t(`stockDocs.status.${status}`)}
    </StatusBadge>
  );
}
