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
  useCallback,
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
import { LinesTable } from '#components/erp/document';
import { errorText } from '#components/erp/messages';
import { personChoices, usePersonOptions, type PersonOption } from '#components/erp/options';
import { FeedbackForm } from '#components/feedback-form';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { PendingButton } from '#components/pending-button';
import { RouteChildPage } from '#components/route-child-page';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { FieldGroup } from '#components/ui/field';
import { Input } from '#components/ui/input';
import { Textarea } from '#components/ui/textarea';

import { useAncestorSearch } from '../../routing/route-context.js';
import { usePageLeave } from '../../routing/route-leave-boundary.js';
import { useReferencePage, type WarehouseOption } from '../orders/reference.js';
import { ReturnsClient, type ReturnDoc } from './client.js';
import { CellField, Dash, NumberInput, PageField, SelectField } from './fields.js';
import {
  createInputOf,
  emptyReturnForm,
  errorHint,
  isNotDraft,
  returnFormOf,
  returnInputOf,
  validateReturnForm,
  type LineDraft,
  type ReturnFormValues,
} from './model.js';
import { RETURN_LIST_KEYS, returnResource, type ReturnKindDef } from './page-id.js';
import { useReturnDoc } from './record.js';
import { SourcePickerDialog, type PickedSource } from './SourcePickerDialog.js';

/** 新建与编辑退货单：先选来源（出入库单或订单），带出仓库与批次，只填退货数量。 */
export default function ReturnFormPage({
  def,
  editing,
}: {
  readonly def: ReturnKindDef;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params.returnId ?? '') : '';
  const client = useMemo(() => new ReturnsClient(api, def), [api, def]);
  const resource = returnResource(def);
  const view = useCan({ resource, action: 'view' });
  const postView = useCan({ resource, action: 'postView' });
  const create = useCan({ resource, action: 'create' });
  const update = useCan({ resource, action: 'update' });
  const optionsView = useCan({ resource: { type: 'composite', id: 'bizOptions' }, action: 'view' });
  const warehouseView = useCan({ resource: { type: 'composite', id: 'inventory' }, action: 'warehouseView' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending || postView.isPending
    : create.isPending;
  const record = useReturnDoc(client, id, editing && (view.can || postView.can));
  const people = usePersonOptions(optionsView.can);
  // 仓库只在选来源后填明细行时才用得到；新建时不放在首屏的关键路径上。
  const [needWarehouses, setNeedWarehouses] = useState(false);
  const warehouses = useReferencePage<WarehouseOption>(
    'warehouses', warehouseView.can && (editing || needWarehouses),
  );
  const doc = record.data;
  const [pickerOpen, setPickerOpen] = useState(false);
  const openPicker = (): void => { setNeedWarehouses(true); setPickerOpen(true); };

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t(`navigation.${def.kind === 'purchase' ? 'purchaseReturns' : 'salesReturns'}`),
    to: { pathname: owner, search: useAncestorSearch(owner, RETURN_LIST_KEYS) },
  };
  const title = editing ? t('returns.editTitle') : t('returns.newTitle');
  const description = editing
    ? t('returns.editDescription', { docNo: doc?.docNo ?? '' })
    : t('returns.newDescription');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: doc?.docNo ?? t('returns.detailTitle') }, { label: title }]
      : [listLevel, { label: title }],
  );

  if (pending)
    return <FormShell title={title} description={description}>{t('status.loading')}</FormShell>;
  if (!allowed)
    return <FormShell title={title} description={description}>{t('erp.form.noWrite')}</FormShell>;
  if (editing && doc === undefined)
    return (
      <FormShell title={title} description={description}>
        {!view.can && !postView.can ? (
          <p role='alert'>{t('erp.errors.denied')}</p>
        ) : record.error !== undefined ? (
          <Alert variant='destructive'><AlertDescription>{errorText(record.error, t)}</AlertDescription></Alert>
        ) : (
          t('status.loading')
        )}
      </FormShell>
    );
  if (editing && doc?.status !== 'draft')
    return (
      <FormShell title={title} description={description}>
        <Alert><AlertDescription>{t('returns.form.notEditable')}</AlertDescription></Alert>
      </FormShell>
    );

  return (
    <ReturnForm
      key={doc?.updatedAt}
      client={client}
      def={def}
      editing={editing}
      record={doc}
      initial={doc ? returnFormOf(doc) : emptyReturnForm()}
      people={people.items ?? []}
      warehouses={warehouses.items ?? []}
      pickerOpen={pickerOpen}
      setPickerOpen={setPickerOpen}
      openPicker={openPicker}
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

interface ReturnFormProps {
  readonly client: ReturnsClient;
  readonly def: ReturnKindDef;
  readonly editing: boolean;
  readonly record: ReturnDoc | undefined;
  readonly initial: ReturnFormValues;
  readonly people: readonly PersonOption[];
  readonly warehouses: readonly WarehouseOption[];
  readonly pickerOpen: boolean;
  readonly setPickerOpen: (open: boolean) => void;
  readonly openPicker: () => void;
  readonly onNotEditable: () => void;
}

function ReturnForm({
  client,
  def,
  editing,
  record,
  initial,
  people,
  warehouses,
  pickerOpen,
  setPickerOpen,
  openPicker,
  onNotEditable,
}: ReturnFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<ReturnFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof ReturnFormValues>(key: K, value: ReturnFormValues[K]): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => (old[key] === undefined ? old : { ...old, [key]: undefined }));
  };
  const setLine = useCallback((key: string, patch: Partial<LineDraft>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  }, []);
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: old.lines.filter((line) => line.key !== key) }));
  };

  const onPick = (picked: PickedSource): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      sourceType: picked.sourceType,
      sourceId: picked.sourceId,
      sourceLabel: picked.sourceLabel,
      lines: [...old.lines, ...picked.lines],
    }));
    setErrors({});
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateReturnForm(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = editing && record
        ? await (async () => {
            const { sourceType: _type, sourceId: _id, ...rest } = returnInputOf(values);
            return await client.update(record.id, rest);
          })()
        : await client.create(createInputOf(values));
      toaster.show({
        type: 'success',
        title: editing
          ? t('returns.toasts.saved', { docNo: saved.docNo })
          : t('returns.toasts.created', { docNo: saved.docNo }),
      });
      setSaved(true);
      leave.allow();
      await navigate(
        {
          pathname: `${def.basePath}/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (cause) {
      setError(errorHint(cause, t));
      setErrors(
        cause instanceof ApiClientError && cause.reason === 'RETURN_NOT_DRAFT'
          ? { lines: errorHint(cause, t) }
          : {},
      );
      if (isNotDraft(cause)) onNotEditable();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: editing && record ? `${def.basePath}/${record.id}` : def.basePath,
        search: location.search,
      },
      { replace: true },
    );
  };

  const warehouseOpts: { value: string; label: string; disabled?: boolean }[] =
    warehouses.map((one) => ({ value: one.id, label: one.name, disabled: one.status !== 'active' }));

  const columns: ColumnDef<LineDraft>[] = [
    {
      id: 'index',
      header: '#',
      cell: ({ row }) => <span className='text-muted-foreground tabular-nums'>{row.index + 1}</span>,
    },
    {
      id: 'item',
      header: t('returns.fields.item'),
      cell: ({ row }) => <span className='font-medium'>{row.original.itemLabel}</span>,
    },
    {
      id: 'warehouse',
      header: t('returns.fields.warehouse'),
      cell: ({ row }) => {
        const line = row.original;
        return (
          <CellField invalid={Boolean(errors[`warehouse-${line.key}`])} error={errors[`warehouse-${line.key}`]}>
            <SelectField
              id={`${formId}-warehouse-${line.key}`}
              label={t('returns.fields.warehouseLine', { n: row.index + 1 })}
              value={line.warehouseId}
              onChange={(value) => setLine(line.key, { warehouseId: value })}
              options={warehouseOpts}
              placeholder={t('returns.form.choose')}
              disabled={busy || editing}
            />
          </CellField>
        );
      },
    },
    {
      id: 'batchNo',
      header: t('returns.fields.batchNo'),
      cell: ({ row }) => row.original.batchNo || <Dash />,
    },
    {
      id: 'qty',
      header: t('returns.fields.qty'),
      cell: ({ row }) => <span className='tabular-nums'>{row.original.qty}</span>,
    },
    {
      id: 'remainQty',
      header: t('returns.fields.remainQty'),
      cell: ({ row }) => <span className='tabular-nums'>{row.original.remainQty}</span>,
    },
    {
      id: 'returnQty',
      header: t('returns.fields.returnQty'),
      cell: ({ row }) => {
        const line = row.original;
        return (
          <CellField invalid={Boolean(errors[`return-${line.key}`])} error={errors[`return-${line.key}`]}>
            <NumberInput
              id={`${formId}-return-${line.key}`}
              label={t('returns.fields.returnQtyLine', { n: row.index + 1 })}
              value={line.returnQty}
              onChange={(value) => setLine(line.key, { returnQty: value })}
              disabled={busy}
            />
          </CellField>
        );
      },
    },
    {
      id: 'note',
      header: t('returns.fields.note'),
      cell: ({ row }) => (
        <Input
          aria-label={t('returns.fields.noteLine', { n: row.index + 1 })}
          value={row.original.note}
          disabled={busy}
          onChange={(event) => setLine(row.original.key, { note: event.target.value })}
        />
      ),
    },
    {
      id: 'remove',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }) => (
        <Button type='button' variant='ghost' size='sm' disabled={busy || editing} onClick={() => removeLine(row.original.key)}>
          {t('returns.actions.removeLine')}
        </Button>
      ),
    },
  ];

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={editing ? t('returns.editTitle') : t('returns.newTitle')}
          description={editing ? t('returns.editDescription', { docNo: record?.docNo ?? '' }) : t('returns.newDescription')}
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>{t('actions.cancel')}</Button>
              <PendingButton type='submit' form={formId} busy={busy} action='save'>{t('returns.actions.save')}</PendingButton>
            </>
          }
        />
        <FeedbackForm
          id={formId}
          onSubmit={(event) => void onSubmit(event)}
          values={() => values}
          savedValues={initial}
          className='flex w-full max-w-3xl flex-col gap-6'
        >
          {leave.dialog}
          {error ? <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DetailSection title={t('returns.form.header')}>
            <FieldGroup className='grid gap-4 sm:grid-cols-2'>
              <PageField id={`${formId}-source`} label={t('returns.fields.source')} required error={errors.sourceId}>
                <div className='flex items-center gap-2'>
                  <span className='min-w-0 truncate text-sm'>{values.sourceLabel || t('returns.form.sourceEmpty')}</span>
                  <Button type='button' variant='outline' size='sm' disabled={busy || editing} onClick={openPicker}>
                    {t('returns.actions.pickSource')}
                  </Button>
                </div>
              </PageField>
              <SelectField
                id={`${formId}-handler`}
                label={t('returns.fields.handler')}
                value={values.handlerUserId}
                onChange={(value) => set('handlerUserId', value)}
                options={personChoices(people)}
                placeholder={t('returns.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-remark`} label={t('returns.fields.remark')} className='sm:col-span-2'>
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
          <DetailSection title={t('returns.fields.lines')}>
            {errors.lines ? <p role='alert' className='text-sm text-destructive'>{errors.lines}</p> : null}
            <LinesTable
              columns={columns}
              rows={values.lines}
              getRowId={(line) => line.key}
              emptyMessage={t('returns.form.linesEmpty')}
            />
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={record?.files ?? []}
              ids={values.fileIds}
              disabled={busy}
              onChange={(ids) => set('fileIds', [...ids])}
            />
          </DetailSection>
        </FeedbackForm>
      </PageContainer>
      <SourcePickerDialog
        def={def}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={onPick}
      />
    </RouteChildPage>
  );
}
