import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, Outlet, useParams } from 'react-router';

import { ConfirmDialog } from '#components/erp/confirm';
import {
  DocumentHeaderFields,
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
  LinesTable,
} from '#components/erp/document';
import { errorText } from '#components/erp/messages';
import { useRecord } from '#components/erp/record';
import { RecordLink } from '#components/record-link';
import { Button } from '#components/ui/button';

import { useAncestorSearch } from '../../routing/route-context.js';
import { BomsClient, type Bom, type BomLine } from './client.js';
import { ExplodeDialog } from './explode-dialog.js';
import { BomStatusBadge } from './fields.js';
import { qtyText } from './format.js';
import { BOMS_LIST_KEYS, BOMS_RESOURCE } from './page-id.js';

/** 一张 BOM 的详情：表头 + 配件行 + 创建子 BOM + 展开结构；维护入口按业务动作显隐。 */
export default function BomDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const id = useParams().bomId ?? '';
  const client = useMemo(() => new BomsClient(api), [api]);
  const view = useCan({ resource: BOMS_RESOURCE, action: 'view' });
  const record = useRecord<Bom>(id ? `boms/${encodeURIComponent(id)}` : '', view.can);
  const bom = record.data;
  const error = record.error;
  const create = useCan({ resource: BOMS_RESOURCE, action: 'create' });
  const update = useCan({ resource: BOMS_RESOURCE, action: 'update' });
  const voiding = useCan({ resource: BOMS_RESOURCE, action: 'void' });
  const explode = useCan({ resource: BOMS_RESOURCE, action: 'explode' });

  const [voidOpen, setVoidOpen] = useState(false);
  const [explodeOpen, setExplodeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const owner = '/boms';
  const search = useAncestorSearch(owner, BOMS_LIST_KEYS);

  const runVoid = async (): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.void(id);
      toaster.show({
        type: 'success',
        title: t('boms.toasts.voided', { name: bom?.docNo ?? '' }),
      });
      setVoidOpen(false);
      record.reload();
    } catch (cause) {
      setVoidOpen(false);
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo<ColumnDef<BomLine>[]>(
    () => [
      {
        id: 'lineNo',
        header: t('boms.fields.lineNo'),
        cell: ({ row }: CellContext<BomLine, unknown>) => row.original.lineNo,
      },
      {
        id: 'item',
        header: t('boms.fields.item'),
        cell: ({ row }) => `${row.original.item.code} ${row.original.item.name}`,
      },
      {
        id: 'qty',
        header: t('boms.fields.qty'),
        cell: ({ row }) => (
          <span className='tabular-nums'>{qtyText(row.original.qty, locale)}</span>
        ),
      },
      {
        id: 'lossRate',
        header: t('boms.fields.lossRate'),
        cell: ({ row }) => (
          <span className='tabular-nums'>
            {qtyText(row.original.lossRate * 100, locale)}%
          </span>
        ),
      },
      {
        id: 'childBomId',
        header: t('boms.fields.childBomId'),
        cell: ({ row }) => row.original.childBomId ?? t('boms.fields.none'),
      },
      {
        id: 'note',
        header: t('boms.fields.note'),
        cell: ({ row }) => row.original.note ?? '',
      },
      ...(create.can
        ? [
            {
              id: 'child',
              header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
              cell: ({ row }: CellContext<BomLine, unknown>) => (
                <Button
                  nativeButton={false}
                  size='sm'
                  variant='outline'
                  render={
                    <Link
                      to={{
                        pathname: '/boms/new',
                        search: `?productId=${encodeURIComponent(row.original.itemId)}`,
                      }}
                    />
                  }
                >
                  {t('boms.actions.createChild')}
                </Button>
              ),
            } as ColumnDef<BomLine>,
          ]
        : []),
    ],
    [t, locale, create.can],
  );

  const headerFields = useMemo(
    () =>
      bom
        ? [
            { label: t('boms.fields.version'), value: bom.version },
            {
              label: t('boms.fields.product'),
              value: `${bom.product.code} ${bom.product.name}`,
            },
            {
              label: t('boms.fields.isDefault'),
              value: bom.isDefault ? t('boms.yes') : t('boms.no'),
            },
            { label: t('boms.fields.effectiveFrom'), value: bom.effectiveFrom },
            {
              label: t('boms.fields.effectiveTo'),
              value: bom.effectiveTo ?? t('boms.fields.longTerm'),
            },
            {
              label: t('boms.fields.dailyOutput'),
              value: bom.dailyOutput === null
                ? t('boms.fields.none')
                : qtyText(bom.dailyOutput, locale),
            },
            { label: t('boms.fields.remark'), value: bom.remark },
            { label: t('boms.fields.createdAt'), value: bom.createdAt },
          ]
        : [],
    [bom, t, locale],
  );

  let content: ReactNode;
  if (error !== undefined) {
    content = (
      <DocumentStatusBar tone='destructive'>
        {errorText(error, t)}
      </DocumentStatusBar>
    );
  } else if (!bom) {
    content = (
      <DocumentStatusBar>
        <span role='status'>{t('status.loading')}</span>
      </DocumentStatusBar>
    );
  } else {
    content = (
      <>
        <DocumentStatusBar>
          {bom.status === 'active'
            ? t('boms.statusBar.active')
            : t('boms.statusBar.inactive')}
        </DocumentStatusBar>
        <DocumentSection title={t('boms.sections.header')}>
          <DocumentHeaderFields fields={headerFields} />
        </DocumentSection>
        <DocumentSection title={t('boms.sections.lines')}>
          <LinesTable
            columns={columns}
            rows={bom.lines}
            getRowId={(line) => line.id}
            emptyMessage={t('boms.linesEmpty')}
          />
        </DocumentSection>
      </>
    );
  }

  return (
    <DocumentPage
      title={
        bom ? (
          <RecordLink to={{ pathname: owner, search }}>
            {bom.docNo}
          </RecordLink>
        ) : (
          t('boms.detailTitle')
        )
      }
      badge={bom ? <BomStatusBadge status={bom.status} /> : undefined}
      actions={
        <>
          {explode.can && bom ? (
            <Button
              type='button'
              variant='outline'
              onClick={() => setExplodeOpen(true)}
            >
              {t('boms.actions.explode')}
            </Button>
          ) : null}
          {update.can && bom ? (
            <Button
              nativeButton={false}
              render={
                <Link
                  to={{ pathname: `${owner}/${encodeURIComponent(id)}/edit`, search }}
                />
              }
            >
              {t('boms.actions.edit')}
            </Button>
          ) : null}
          {voiding.can && bom?.status === 'active' ? (
            <Button
              type='button'
              variant='destructive'
              onClick={() => setVoidOpen(true)}
            >
              {t('boms.actions.void')}
            </Button>
          ) : null}
          {actionError ? (
            <span role='alert' className='text-sm text-destructive'>
              {actionError}
            </span>
          ) : null}
        </>
      }
    >
      {content}
      <ConfirmDialog
        open={voidOpen}
        title={t('boms.voidTitle', { name: bom?.docNo ?? '' })}
        description={t('boms.voidDescription')}
        confirmLabel={t('boms.actions.void')}
        error={actionError ? <span role='alert'>{actionError}</span> : undefined}
        busy={busy}
        onCancel={() => setVoidOpen(false)}
        onConfirm={() => {
          void runVoid();
        }}
      />
      {explodeOpen && bom ? (
        <ExplodeDialog
          productId={bom.product.id}
          defaultAsOf={bom.effectiveFrom}
          onClose={() => setExplodeOpen(false)}
        />
      ) : null}
      <Outlet />
    </DocumentPage>
  );
}
