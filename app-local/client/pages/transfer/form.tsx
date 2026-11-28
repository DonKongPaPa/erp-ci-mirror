import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import {
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
import { LinesTable } from '#components/erp/document';
import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText } from '#components/erp/messages';
import {
  personChoices,
  usePersonOptions,
  type PersonOption,
} from '#components/erp/options';
import { FeedbackForm } from '#components/feedback-form';
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

import { usePageLeave } from '../../routing/route-leave-boundary.js';
import { useAncestorSearch } from '../../routing/route-context.js';
import {
  itemChoices,
  useReferencePage,
  type Item,
  type WarehouseOption,
} from '../orders/reference.js';
import { today } from '../orders/model.js';
import { CellField, NumberInput, PageField, SelectField } from './fields.js';
import {
  emptyTransferForm,
  newTransferLine,
  transferFormOf,
  transferInputOf,
  validateTransferForm,
  type LineDraft,
  type TransferFormValues,
} from './model.js';
import { TRANSFERS_LIST_KEYS, TRANSFERS_RESOURCE } from './page-id.js';
import { useTransfer } from './record.js';
import { TransferClient, type Transfer } from './client.js';

/** 新建与编辑调拨单：表头填调入仓、调出仓与数量，实调默认等于申请数。 */
export default function TransferFormPage({
  editing,
}: {
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params.transferId ?? '') : '';
  const client = useMemo(() => new TransferClient(api), [api]);
  const view = useCan({ resource: TRANSFERS_RESOURCE, action: 'view' });
  const create = useCan({ resource: TRANSFERS_RESOURCE, action: 'create' });
  const update = useCan({ resource: TRANSFERS_RESOURCE, action: 'update' });
  const itemsView = useCan({ resource: { type: 'composite', id: 'items' }, action: 'view' });
  const warehouseView = useCan({ resource: { type: 'composite', id: 'inventory' }, action: 'warehouseView' });
  const optionsView = useCan({ resource: { type: 'composite', id: 'bizOptions' }, action: 'view' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const record = useTransfer(id, editing && view.can);
  const items = useReferencePage<Item>('items', itemsView.can);
  const warehouses = useReferencePage<WarehouseOption>('warehouses', warehouseView.can);
  const people = usePersonOptions(optionsView.can);
  const transfer = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.transfers'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, TRANSFERS_LIST_KEYS),
    },
  };
  const title = editing ? t('transfer.editTitle') : t('transfer.newTitle');
  const description = editing
    ? t('transfer.editDescription', { docNo: transfer?.docNo ?? '' })
    : t('transfer.newDescription');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: transfer?.docNo ?? t('transfer.detailTitle') }, { label: title }]
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
  if (editing && transfer === undefined)
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
  if (editing && transfer?.status !== 'draft')
    return (
      <FormShell title={title} description={description}>
        <Alert>
          <AlertDescription>{t('transfer.form.notEditable')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <TransferForm
      key={transfer?.updatedAt}
      client={client}
      editing={editing}
      record={transfer}
      initial={transfer ? transferFormOf(transfer) : emptyTransferForm(today())}
      items={items.items}
      warehouses={warehouses.items}
      people={people.items}
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

interface TransferFormProps {
  readonly client: TransferClient;
  readonly editing: boolean;
  readonly record: Transfer | undefined;
  readonly initial: TransferFormValues;
  readonly items: readonly Item[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly onNotEditable: () => void;
}

function TransferForm({
  client,
  editing,
  record,
  initial,
  items,
  warehouses,
  people,
  onNotEditable,
}: TransferFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<TransferFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  // 和订单、出入库表单同一套离开守卫：保存成功后先清未保存状态、放行离开，再导航。
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof TransferFormValues>(
    key: K,
    value: TransferFormValues[K],
  ): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => (old[key] === undefined ? old : { ...old, [key]: undefined }));
  };
  const setLine = (key: string, patch: Partial<LineDraft>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch };
        // 实调默认等于申请：只在没单独改过实调时跟着申请数走。
        if (patch.qty !== undefined && (line.transferQty === '' || line.transferQty === line.qty))
          next.transferQty = patch.qty;
        return next;
      }),
    }));
  };
  const addLine = (): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: [...old.lines, newTransferLine()] }));
  };
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((line) => line.key !== key),
    }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateTransferForm(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = transferInputOf(values);
      const saved = editing && record
        ? await client.update(record.id, input)
        : await client.create({
            ...(input as { lines: NonNullable<typeof input.lines> }),
            transferInWarehouseId: values.transferInWarehouseId,
          });
      toaster.show({
        type: 'success',
        title: editing
          ? t('transfer.toasts.saved', { docNo: saved.docNo })
          : t('transfer.toasts.created', { docNo: saved.docNo }),
      });
      setSaved(true);
      // 放行这一次的离开，否则慢请求下「未保存」守卫会把成功后的导航挡住。
      leave.allow();
      await navigate(
        {
          pathname: `/transfers/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      if (
        next instanceof ApiClientError &&
        next.reason === 'TRANSFER_NOT_DRAFT'
      ) {
        setErrors({ lines: errorText(next, t) });
        onNotEditable();
      }
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: editing && record ? `/transfers/${record.id}` : '/transfers',
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
          title={editing ? t('transfer.editTitle') : t('transfer.newTitle')}
          description={
            editing
              ? t('transfer.editDescription', { docNo: record?.docNo ?? '' })
              : t('transfer.newDescription')
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy} action='save'>
                {t('transfer.actions.saveDraft')}
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
          {leave.dialog}
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DetailSection title={t('transfer.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <SelectField
                id={`${formId}-warehouseIn`}
                label={t('transfer.fields.warehouseIn')}
                required
                error={errors.transferInWarehouseId}
                value={values.transferInWarehouseId}
                onChange={(value) => set('transferInWarehouseId', value)}
                options={warehouseOpts}
                placeholder={t('transfer.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-warehouseOut`}
                label={t('transfer.fields.warehouseOut')}
                error={errors.transferOutWarehouseId}
                value={values.transferOutWarehouseId}
                onChange={(value) => set('transferOutWarehouseId', value)}
                options={warehouseOpts}
                placeholder={t('transfer.form.choose')}
                disabled={busy}
              />
              <PageField
                id={`${formId}-docDate`}
                label={t('transfer.fields.docDate')}
                error={errors.docDate}
              >
                {/* ui-component-exception: 项目尚无日期选择器与日历依赖，沿用库存页的原生日期输入 */}
                <Input
                  id={`${formId}-docDate`}
                  type='date'
                  disabled={busy}
                  value={values.docDate}
                  onChange={(event) => set('docDate', event.target.value)}
                />
              </PageField>
              <SelectField
                id={`${formId}-handlerUserId`}
                label={t('transfer.fields.handler')}
                error={errors.handlerUserId}
                value={values.handlerUserId}
                onChange={(value) => set('handlerUserId', value)}
                options={personChoices(people)}
                placeholder={t('transfer.form.choose')}
                disabled={busy}
              />
              <PageField
                id={`${formId}-remark`}
                label={t('transfer.fields.remark')}
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
          <DetailSection title={t('transfer.fields.lines')}>
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
                  header: t('transfer.fields.item'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('transfer.fields.itemLine', { n: row.index + 1 });
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
                            <SelectValue placeholder={t('transfer.form.choose')} />
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
                  id: 'qty',
                  header: t('transfer.fields.qty'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('transfer.fields.qtyLine', { n: row.index + 1 });
                    return (
                      <CellField invalid={Boolean(errors[`qty-${line.key}`])} error={errors[`qty-${line.key}`]}>
                        <NumberInput
                          id={`${formId}-qty-${line.key}`}
                          label={label}
                          value={line.qty}
                          onChange={(value) => setLine(line.key, { qty: value })}
                          disabled={busy}
                        />
                      </CellField>
                    );
                  },
                },
                {
                  id: 'transferQty',
                  header: t('transfer.fields.transferQty'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('transfer.fields.transferQtyLine', { n: row.index + 1 });
                    return (
                      <CellField invalid={Boolean(errors[`transferQty-${line.key}`])} error={errors[`transferQty-${line.key}`]}>
                        <NumberInput
                          id={`${formId}-transferQty-${line.key}`}
                          label={label}
                          value={line.transferQty}
                          onChange={(value) =>
                            setLine(line.key, { transferQty: value })
                          }
                          disabled={busy}
                        />
                      </CellField>
                    );
                  },
                },
                {
                  id: 'note',
                  header: t('transfer.fields.note'),
                  cell: ({ row }) => (
                    <Input
                      aria-label={t('transfer.fields.noteLine', { n: row.index + 1 })}
                      value={row.original.note}
                      disabled={busy}
                      onChange={(event) =>
                        setLine(row.original.key, { note: event.target.value })
                      }
                    />
                  ),
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
                      {t('transfer.actions.removeLine')}
                    </Button>
                  ),
                },
              ] as ColumnDef<LineDraft>[]}
              rows={values.lines}
              getRowId={(line) => line.key}
              emptyMessage={t('transfer.form.linesEmpty')}
            />
            <Button type='button' variant='outline' disabled={busy} onClick={addLine}>
              {t('transfer.actions.addLine')}
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
