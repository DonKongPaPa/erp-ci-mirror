import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
  type ApiClient,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useParams, useResolvedPath } from 'react-router';

import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { DetailSection } from '#components/erp/detail';
import type { FieldErrors } from '#components/erp/form-dialog';
import type { EntityPage } from '#components/erp/list-state';
import { errorText } from '#components/erp/messages';
import {
  personChoices,
  usePersonOptions,
  type PersonOption,
} from '#components/erp/options';
import { FeedbackForm } from '#components/feedback-form';
import { LinesTable } from '#components/erp/document';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { PendingButton } from '#components/pending-button';
import { RouteChildPage } from '#components/route-child-page';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { FieldGroup } from '#components/ui/field';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Textarea } from '#components/ui/textarea';

import { useAncestorSearch } from '../../routing/route-context.js';
import {
  itemChoices,
  useReferencePage,
  type Item,
  type WarehouseOption,
} from '../orders/reference.js';
import { INVENTORY_RESOURCE } from '../warehouses/page-id.js';
import { StocktakingClient, type Stocktaking } from './client.js';
import { CellField, Dash, NumberInput, PageField, SelectField } from './fields.js';
import {
  emptyStocktakingForm,
  newStocktakingLine,
  stocktakingFormOf,
  stocktakingInputOf,
  validateStocktakingForm,
  type LineDraft,
  type StocktakingFormValues,
} from './model.js';
import { useStocktaking } from './record.js';
import {
  STOCKTAKINGS_LIST_KEYS,
  STOCKTAKINGS_RESOURCE,
} from './page-id.js';

/** 新建时按当前仓库与物料从现存量反查系统数量；服务端加行时仍会重新快照。 */
const NO_QTIES: ReadonlyMap<string, number> = new Map();

function useSystemQties(
  api: ApiClient,
  warehouseId: string,
  itemIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, number> {
  const [qties, setQties] = useState<ReadonlyMap<string, number>>(() => new Map());
  const itemKey = itemIds.join('\u0000');
  const active = enabled && Boolean(warehouseId) && Boolean(itemKey);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const ids = itemKey.split('\u0000');
    void (async () => {
      const next = new Map<string, number>();
      await Promise.all(
        ids.map(async (itemId) => {
          try {
            const query = new URLSearchParams({
              warehouseId,
              itemId,
              pageSize: '100',
            });
            const result = await api.request<EntityPage<{ qty: number }>>({
              path: `stock/balances?${query.toString()}`,
              signal: controller.signal,
            });
            next.set(
              itemId,
              result.items.reduce((total, row) => total + row.qty, 0),
            );
          } catch {
            // 读不到现存量就显示「—」，不把未知当成 0。
          }
        }),
      );
      if (!controller.signal.aborted) setQties(next);
    })();
    return () => controller.abort();
  }, [api, warehouseId, itemKey, active]);
  return active ? qties : NO_QTIES;
}

/** 新建与编辑盘点单：表头选仓库、经办人（默认当前登录人由服务端定），明细录实盘数量。 */
export default function StocktakingFormPage({
  editing,
}: {
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params.stocktakingId ?? '') : '';
  const client = useMemo(() => new StocktakingClient(api), [api]);
  const view = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'view' });
  const create = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'create' });
  const update = useCan({ resource: STOCKTAKINGS_RESOURCE, action: 'update' });
  const itemsView = useCan({ resource: { type: 'composite', id: 'items' }, action: 'view' });
  const warehouseView = useCan({ resource: INVENTORY_RESOURCE, action: 'warehouseView' });
  const stockView = useCan({ resource: INVENTORY_RESOURCE, action: 'stockView' });
  const optionsView = useCan({ resource: { type: 'composite', id: 'bizOptions' }, action: 'view' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const record = useStocktaking(id, editing && view.can);
  const items = useReferencePage<Item>('items', itemsView.can);
  const warehouses = useReferencePage<WarehouseOption>('warehouses', warehouseView.can);
  const people = usePersonOptions(optionsView.can);
  const stock = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.stocktakings'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, STOCKTAKINGS_LIST_KEYS),
    },
  };
  const title = editing
    ? t('stocktaking.editTitle')
    : t('stocktaking.newTitle');
  const description = editing
    ? t('stocktaking.editDescription', { docNo: stock?.docNo ?? '' })
    : t('stocktaking.newDescription');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: stock?.docNo ?? t('stocktaking.detailTitle') }, { label: title }]
      : [listLevel, { label: title }],
  );

  if (pending)
    return (
      <FormShell title={title} description={description}>
        <p role='status' className='text-sm text-muted-foreground'>
          {t('status.loading')}
        </p>
      </FormShell>
    );
  if (!allowed)
    return (
      <FormShell title={title} description={description}>
        <p role='status' className='text-sm text-muted-foreground'>
          {t('erp.form.noWrite')}
        </p>
      </FormShell>
    );
  if (editing && stock === undefined)
    return (
      <FormShell title={title} description={description}>
        {!view.can ? (
          <p role='alert' className='text-sm text-muted-foreground'>
            {t('erp.errors.denied')}
          </p>
        ) : record.error !== undefined ? (
          <Alert variant='destructive'>
            <AlertDescription>{errorText(record.error, t)}</AlertDescription>
          </Alert>
        ) : (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('status.loading')}
          </p>
        )}
      </FormShell>
    );
  if (editing && stock?.status !== 'staging')
    return (
      <FormShell title={title} description={description}>
        <Alert>
          <AlertDescription>{t('stocktaking.form.notEditable')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <StockForm
      key={stock?.updatedAt}
      client={client}
      api={api}
      editing={editing}
      record={stock}
      initial={stock ? stocktakingFormOf(stock) : emptyStocktakingForm()}
      items={items.items}
      warehouses={warehouses.items}
      people={people.items}
      canReadStock={stockView.can}
      onNotEditable={record.reload}
    />
  );
}

function FormShell({
  title,
  description,
  children,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader title={title} description={description} />
        {children}
      </PageContainer>
    </RouteChildPage>
  );
}

interface StockFormProps {
  readonly client: StocktakingClient;
  readonly api: ApiClient;
  readonly editing: boolean;
  readonly record: Stocktaking | undefined;
  readonly initial: StocktakingFormValues;
  readonly items: readonly Item[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly canReadStock: boolean;
  readonly onNotEditable: () => void;
}

function StockForm({
  client,
  api,
  editing,
  record,
  initial,
  items,
  warehouses,
  people,
  canReadStock,
  onNotEditable,
}: StockFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<StocktakingFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const set = <K extends keyof StocktakingFormValues>(
    key: K,
    value: StocktakingFormValues[K],
  ): void => {
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => (old[key] === undefined ? old : { ...old, [key]: undefined }));
  };
  const setLine = useCallback((key: string, patch: Partial<LineDraft>): void => {
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  }, []);
  const addLine = (): void => {
    setValues((old) => ({ ...old, lines: [...old.lines, newStocktakingLine()] }));
  };
  const removeLine = (key: string): void => {
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((line) => line.key !== key),
    }));
  };

  const knownSystem = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of record?.lines ?? [])
      map.set(line.itemId, line.systemQty);
    return map;
  }, [record]);
  const fetched = useSystemQties(
    api,
    values.warehouseId,
    values.lines.map((line) => line.itemId).filter(Boolean),
    !editing && canReadStock,
  );
  const systemOf = (itemId: string): number | undefined =>
    knownSystem.get(itemId) ?? fetched.get(itemId);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateStocktakingForm(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = stocktakingInputOf(values);
      const saved = editing && record
        ? await client.update(record.id, input)
        : await client.create({
            ...(input as { lines: NonNullable<typeof input.lines> }),
            warehouseId: values.warehouseId,
          });
      toaster.show({
        type: 'success',
        title: editing
          ? t('stocktaking.toasts.saved', { docNo: saved.docNo })
          : t('stocktaking.toasts.created', { docNo: saved.docNo }),
      });
      await navigate(
        {
          pathname: `/stocktakings/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(
        next instanceof ApiClientError && next.reason === 'STOCKTAKE_NOT_STAGING'
          ? { lines: errorText(next, t) }
          : {},
      );
      if (
        next instanceof ApiClientError &&
        next.reason === 'STOCKTAKE_NOT_STAGING'
      )
        onNotEditable();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname:
          editing && record
            ? `/stocktakings/${record.id}`
            : '/stocktakings',
        search: location.search,
      },
      { replace: true },
    );
  };

  const itemOpts = itemChoices(items ?? [], t('orderDocs.form.inactiveItem'));
  const warehouseOpts: { value: string; label: string; disabled?: boolean }[] =
    (warehouses ?? []).map((one) => ({
      value: one.id,
      label: one.name,
      disabled: one.status !== 'active',
    }));

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={editing ? t('stocktaking.editTitle') : t('stocktaking.newTitle')}
          description={
            editing
              ? t('stocktaking.editDescription', { docNo: record?.docNo ?? '' })
              : t('stocktaking.newDescription')
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy}>
                {t('stocktaking.actions.stage')}
              </PendingButton>
            </>
          }
        />
        <FeedbackForm
          id={formId}
          onSubmit={(event) => void onSubmit(event)}
          values={() => values}
          savedValues={initial}
          className='flex flex-col gap-6'
        >
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DetailSection title={t('stocktaking.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <PageField id={`${formId}-docDate`} label={t('stocktaking.fields.docDate')} hint={t('stocktaking.form.docDateHint')}>
                {/* ui-component-exception: 沿用库存页的原生日期输入；盘点日期由服务端填，这里禁用回显 */}
                <Input
                  id={`${formId}-docDate`}
                  type='date'
                  disabled
                  value={values.docDate}
                />
              </PageField>
              <SelectField
                id={`${formId}-warehouseId`}
                label={t('stocktaking.fields.warehouse')}
                required
                error={errors.warehouseId}
                value={values.warehouseId}
                onChange={(value) => set('warehouseId', value)}
                options={warehouseOpts}
                placeholder={t('stocktaking.form.choose')}
                disabled={busy || editing}
              />
              <SelectField
                id={`${formId}-handlerUserId`}
                label={t('stocktaking.fields.handler')}
                error={errors.handlerUserId}
                value={values.handlerUserId}
                onChange={(value) => set('handlerUserId', value)}
                options={personChoices(people)}
                placeholder={t('stocktaking.form.choose')}
                disabled={busy}
              />
              <PageField
                id={`${formId}-remark`}
                label={t('stocktaking.fields.remark')}
                className='sm:col-span-2'
              >
                <Textarea
                  id={`${formId}-remark`}
                  autoComplete='off'
                  disabled={busy}
                  value={values.remark}
                  onChange={(event) => set('remark', event.target.value)}
                />
              </PageField>
            </FieldGroup>
          </DetailSection>
          <DetailSection title={t('stocktaking.fields.lines')}>
            {errors.lines ? (
              <p role='alert' className='text-sm text-destructive'>
                {errors.lines}
              </p>
            ) : null}
            <LinesTable
              columns={[
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
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('stocktaking.fields.itemLine', { n: row.index + 1 });
                    return (
                      <CellField
                        invalid={Boolean(errors[`item-${line.key}`])}
                        error={errors[`item-${line.key}`]}
                      >
                        <Select
                          items={itemOpts}
                          value={line.itemId || undefined}
                          onValueChange={(value) =>
                            setLine(line.key, { itemId: value ?? '' })
                          }
                          disabled={busy}
                        >
                          <SelectTrigger aria-label={label}>
                            <SelectValue placeholder={t('stocktaking.form.choose')} />
                          </SelectTrigger>
                          <SelectContent>
                            {itemOpts.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                                disabled={option.disabled}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </CellField>
                    );
                  },
                },
                {
                  id: 'systemQty',
                  header: t('stocktaking.fields.systemQty'),
                  // 系统数量是服务端快照：新建时按仓库与物料从现存量读，保存后由服务端重取。
                  cell: ({ row }) => {
                    const qty = systemOf(row.original.itemId);
                    return qty === undefined ? <Dash /> : (
                      <span className='tabular-nums'>{qty}</span>
                    );
                  },
                },
                {
                  id: 'actualQty',
                  header: t('stocktaking.fields.actualQty'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('stocktaking.fields.actualQtyLine', { n: row.index + 1 });
                    return (
                      <CellField
                        invalid={Boolean(errors[`actual-${line.key}`])}
                        error={errors[`actual-${line.key}`]}
                      >
                        <NumberInput
                          id={`${formId}-actual-${line.key}`}
                          label={label}
                          value={line.actualQty}
                          onChange={(value) =>
                            setLine(line.key, { actualQty: value })
                          }
                          disabled={busy}
                        />
                      </CellField>
                    );
                  },
                },
                {
                  id: 'note',
                  header: t('stocktaking.fields.note'),
                  cell: ({ row }) => {
                    const line = row.original;
                    return (
                      <Input
                        aria-label={t('stocktaking.fields.noteLine', { n: row.index + 1 })}
                        value={line.note}
                        disabled={busy}
                        onChange={(event) =>
                          setLine(line.key, { note: event.target.value })
                        }
                      />
                    );
                  },
                },
                {
                  id: 'remove',
                  header: <span className='sr-only'>{t('erp.fields.actions')}</span>,
                  cell: ({ row }) => (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      disabled={busy}
                      onClick={() => removeLine(row.original.key)}
                    >
                      {t('stocktaking.actions.removeLine')}
                    </Button>
                  ),
                },
              ] as ColumnDef<LineDraft>[]}
              rows={values.lines}
              getRowId={(line) => line.key}
              emptyMessage={t('stocktaking.form.linesEmpty')}
            />
            <Button type='button' variant='outline' disabled={busy} onClick={addLine}>
              {t('stocktaking.actions.addLine')}
            </Button>
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={record?.files ?? []}
              ids={values.fileIds}
              disabled={busy}
              onChange={(ids) => set('fileIds', [...ids])}
            />
            {errors.fileIds ? (
              <p role='alert' className='text-sm text-destructive'>
                {errors.fileIds}
              </p>
            ) : null}
          </DetailSection>
        </FeedbackForm>
      </PageContainer>
    </RouteChildPage>
  );
}
