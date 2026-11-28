import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { XIcon } from 'lucide-react';
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

import { ConfirmDialog } from '#components/erp/confirm';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { FeedbackForm } from '#components/feedback-form';
import { LinesTable } from '#components/erp/document';
import { DetailSection } from '#components/erp/detail';
import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText } from '#components/erp/messages';
import {
  personChoices,
  usePersonOptions,
  type PersonOption,
} from '#components/erp/options';
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
import type { Choice } from '../orders/reference.js';
import {
  InspectionsClient,
  type InspectionOrder,
  type OrderOption,
} from './client.js';
import {
  CellField,
  Dash,
  NumberInput,
  PageField,
  SelectField,
} from './fields.js';
import {
  createInputOf,
  derivedOf,
  emptyInspectionForm,
  inspectionFieldErrors,
  inspectionFormOf,
  lineFromOrder,
  validateInspectionForm,
  type InspectionFormValues,
  type LineDraft,
} from './model.js';
import {
  INSPECTIONS_LIST_KEYS,
  INSPECTIONS_RESOURCE,
} from './page-id.js';
import { InspectionOrderPickerDialog } from './order-picker.js';
import { useInspection } from './record.js';

/** 焦点必须看得见：这一组页面统一用可读的轮廓，不依赖外壳的浅色阴影。 */
const focusRing = [
  '[&_button:focus-visible]:outline-2',
  '[&_button:focus-visible]:outline-offset-2',
  '[&_button:focus-visible]:outline-ring',
  '[&_input:focus-visible]:outline-2',
  '[&_input:focus-visible]:outline-offset-2',
  '[&_input:focus-visible]:outline-ring',
  '[&_[role=combobox]:focus-visible]:outline-2',
  '[&_[role=combobox]:focus-visible]:outline-offset-2',
  '[&_[role=combobox]:focus-visible]:outline-ring',
].join(' ');

/**
 * 新建与编辑检验单（`/inspections/new`、`/inspections/:id/edit`）。
 * 从采购订单选行，填收货、检验、合格与抽检数量；采购数量与三个算列只读回显，
 * 提交体只带原始输入。只有 `pending` 能改，动作权限按资源判定。
 */
export default function InspectionFormPage({
  editing,
}: {
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params.inspectionId ?? '') : '';
  const client = useMemo(() => new InspectionsClient(api), [api]);
  const view = useCan({ resource: INSPECTIONS_RESOURCE, action: 'view' });
  const create = useCan({ resource: INSPECTIONS_RESOURCE, action: 'create' });
  const update = useCan({ resource: INSPECTIONS_RESOURCE, action: 'update' });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const people = usePersonOptions(optionsView.can);
  const record = useInspection(id, editing && view.can);
  const inspection = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.inspections'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, INSPECTIONS_LIST_KEYS),
    },
  };
  const title = editing
    ? t('inspections.editTitle')
    : t('inspections.newTitle');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: inspection?.docNo ?? t('inspections.detailTitle') }, { label: title }]
      : [listLevel, { label: title }],
  );

  if (pending)
    return (
      <FormShell title={title}>
        <p role='status' className='text-sm text-muted-foreground'>
          {t('status.loading')}
        </p>
      </FormShell>
    );
  if (!allowed)
    return (
      <FormShell title={title}>
        <p role='status' className='text-sm text-muted-foreground'>
          {t('erp.form.noWrite')}
        </p>
      </FormShell>
    );
  if (editing && inspection === undefined)
    return (
      <FormShell title={title}>
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
  if (inspection && inspection.status !== 'pending')
    return (
      <FormShell title={title}>
        <Alert>
          <AlertDescription>{t('inspections.form.notEditable')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <InspectionForm
      key={inspection?.updatedAt}
      client={client}
      editing={editing}
      initial={inspection ? inspectionFormOf(inspection) : emptyInspectionForm()}
      inspection={inspection}
      people={people.items}
      onNotEditable={record.reload}
    />
  );
}

function FormShell({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader title={title} />
        {children}
      </PageContainer>
    </RouteChildPage>
  );
}

interface InspectionFormProps {
  readonly client: InspectionsClient;
  readonly editing: boolean;
  readonly initial: InspectionFormValues;
  readonly inspection: InspectionOrder | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly onNotEditable: () => void;
}

function InspectionForm({
  client,
  editing,
  initial,
  inspection,
  people,
  onNotEditable,
}: InspectionFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<InspectionFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leave = usePageLeave(touched && !saved, busy);
  const doLeave = (): void => {
    leave.allow();
    leavePage();
  };

  const set = <K extends keyof InspectionFormValues>(
    key: K,
    value: InspectionFormValues[K],
  ): void => {
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
  const removeLine = useCallback((key: string): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((line) => line.key !== key),
    }));
  }, []);
  const applyOrder = (order: OrderOption): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      purchaseOrderId: order.id,
      purchaseOrderLabel: order.orderNo,
      lines: order.lines
        .filter((line) => line.receivedRemainQty > 0)
        .map((line) => lineFromOrder(order.id, line)),
    }));
    setErrors((old) => ({ ...old, purchaseOrderId: undefined, lines: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateInspectionForm(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = createInputOf(values);
      const savedRecord = editing && inspection
        ? await client.update(inspection.id, {
          inspectionDate: input.inspectionDate,
          inspectorUserId: input.inspectorUserId,
          remark: input.remark,
          fileIds: input.fileIds,
          lines: input.lines,
        })
        : await client.create(input);
      toaster.show({
        type: 'success',
        title: editing
          ? t('inspections.toasts.saved', { name: savedRecord.docNo })
          : t('inspections.toasts.created', { name: savedRecord.docNo }),
      });
      setSaved(true);
      leave.allow();
      await navigate(
        {
          pathname: `/inspections/${encodeURIComponent(savedRecord.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(inspectionFieldErrors(next));
      if (
        next instanceof ApiClientError &&
        next.reason === 'IQC_NOT_PENDING'
      )
        onNotEditable();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: editing && inspection ? `/inspections/${inspection.id}` : '/inspections',
        search: location.search,
      },
      { replace: true },
    );
  };

  const typeChoices: Choice[] = ['full', 'sampling', 'exempt'].map((code) => ({
    value: code,
    label: t(`inspections.inspectionType.${code}`),
  }));
  const personOpts = personChoices(people ?? []);

  const columns = useMemo<ColumnDef<LineDraft>[]>(
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
        header: t('inspections.fields.item'),
        cell: ({ row }) => (
          <span className='wrap-anywhere tabular-nums'>{row.original.itemLabel}</span>
        ),
      },
      {
        id: 'inspectionTypeCode',
        header: t('inspections.fields.inspectionType'),
        cell: ({ row }) => {
          const line = row.original;
          const label = t('inspections.fields.inspectionTypeLine', { n: row.index + 1 });
          return (
            <CellField invalid={Boolean(errors[`inspectionTypeCode-${line.key}`])}>
              <Select
                items={typeChoices}
                value={line.inspectionTypeCode || undefined}
                onValueChange={(value) =>
                  setLine(line.key, { inspectionTypeCode: value ?? 'full' })
                }
                disabled={busy}
              >
                <SelectTrigger aria-label={label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeChoices.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
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
        id: 'purchaseQty',
        header: t('inspections.fields.purchaseQty'),
        cell: ({ row }) => <span className='tabular-nums'>{row.original.purchaseQty || <Dash />}</span>,
      },
      {
        id: 'receivedQty',
        header: t('inspections.fields.receivedQty'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `receivedQty-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <NumberInput
                id={`${formId}-received-${line.key}`}
                label={t('inspections.fields.receivedQtyLine', { n: row.index + 1 })}
                value={line.receivedQty}
                onChange={(value) => setLine(line.key, { receivedQty: value })}
                disabled={busy}
              />
            </CellField>
          );
        },
      },
      {
        id: 'inspectionQty',
        header: t('inspections.fields.inspectionQty'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `inspectionQty-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <NumberInput
                id={`${formId}-inspection-${line.key}`}
                label={t('inspections.fields.inspectionQtyLine', { n: row.index + 1 })}
                value={line.inspectionQty}
                onChange={(value) => setLine(line.key, { inspectionQty: value })}
                disabled={busy}
              />
            </CellField>
          );
        },
      },
      {
        id: 'qualifiedQty',
        header: t('inspections.fields.qualifiedQty'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `qualifiedQty-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <NumberInput
                id={`${formId}-qualified-${line.key}`}
                label={t('inspections.fields.qualifiedQtyLine', { n: row.index + 1 })}
                value={line.qualifiedQty}
                onChange={(value) => setLine(line.key, { qualifiedQty: value })}
                disabled={busy}
              />
            </CellField>
          );
        },
      },
      {
        id: 'samplingQty',
        header: t('inspections.fields.samplingQty'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `samplingQty-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <NumberInput
                id={`${formId}-sampling-${line.key}`}
                label={t('inspections.fields.samplingQtyLine', { n: row.index + 1 })}
                value={line.samplingQty}
                onChange={(value) => setLine(line.key, { samplingQty: value })}
                disabled={busy}
              />
            </CellField>
          );
        },
      },
      {
        id: 'samplingQualifiedQty',
        header: t('inspections.fields.samplingQualifiedQty'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `samplingQualifiedQty-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <NumberInput
                id={`${formId}-sampling-qualified-${line.key}`}
                label={t('inspections.fields.samplingQualifiedQtyLine', { n: row.index + 1 })}
                value={line.samplingQualifiedQty}
                onChange={(value) => setLine(line.key, { samplingQualifiedQty: value })}
                disabled={busy}
              />
            </CellField>
          );
        },
      },
      {
        id: 'unqualifiedQty',
        header: t('inspections.fields.unqualifiedQty'),
        cell: ({ row }) => (
          <span data-testid={`unqualified-${row.index}`} className='tabular-nums'>
            {derivedOf(row.original).unqualified}
          </span>
        ),
      },
      {
        id: 'releasableQty',
        header: t('inspections.fields.releasableQty'),
        cell: ({ row }) => (
          <span data-testid={`releasable-${row.index}`} className='tabular-nums'>
            {derivedOf(row.original).releasable}
          </span>
        ),
      },
      {
        id: 'returnQty',
        header: t('inspections.fields.returnQty'),
        cell: ({ row }) => (
          <span data-testid={`return-${row.index}`} className='tabular-nums'>
            {derivedOf(row.original).return}
          </span>
        ),
      },
      {
        id: 'note',
        header: t('erp.fields.note'),
        cell: ({ row }) => {
          const line = row.original;
          const suffix = `note-${line.key}`;
          return (
            <CellField invalid={Boolean(errors[suffix])} error={errors[suffix]}>
              <Input
                aria-label={t('inspections.fields.noteLine', { n: row.index + 1 })}
                disabled={busy}
                value={line.note}
                onChange={(event) => setLine(line.key, { note: event.target.value })}
              />
            </CellField>
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
            {t('inspections.actions.removeLine')}
          </Button>
        ),
      },
    ] as ColumnDef<LineDraft>[],
    [t, busy, errors, formId, setLine, typeChoices, removeLine],
  );

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={editing ? t('inspections.editTitle') : t('inspections.newTitle')}
          description={editing
            ? t('inspections.editDescription', { docNo: inspection?.docNo ?? '' })
            : t('inspections.newDescription')}
          actions={
            <>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => (touched && !saved ? setConfirmLeave(true) : doLeave())}
              >
                <XIcon data-icon='inline-start' aria-hidden='true' />
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy} action='save'>
                {t('inspections.actions.save')}
              </PendingButton>
            </>
          }
        />
        <div className={`w-full max-w-3xl ${focusRing}`}>
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
          <DetailSection title={t('inspections.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <PageField id={`${formId}-inspectionDate`} label={t('inspections.fields.inspectionDate')} required error={errors.inspectionDate}>
                <Input
                  id={`${formId}-inspectionDate`}
                  inputMode='numeric'
                  autoComplete='off'
                  disabled={busy}
                  value={values.inspectionDate}
                  onChange={(event) => set('inspectionDate', event.target.value)}
                />
              </PageField>
              <PageField id={`${formId}-purchaseOrder`} label={t('inspections.fields.purchaseOrder')} required error={errors.purchaseOrderId}>
                <div className='flex items-center gap-2'>
                  <Input
                    id={`${formId}-purchaseOrder`}
                    readOnly
                    value={values.purchaseOrderLabel}
                    placeholder={t('inspections.form.chooseOrder')}
                  />
                  <Button
                    type='button'
                    variant='outline'
                    disabled={busy}
                    onClick={() => setPicking(true)}
                  >
                    {t('inspections.actions.pickOrder')}
                  </Button>
                </div>
              </PageField>
              {personOpts.length > 0 ? (
                <SelectField
                  id={`${formId}-inspectorUserId`}
                  label={t('inspections.fields.inspector')}
                  error={errors.inspectorUserId}
                  value={values.inspectorUserId}
                  onChange={(value) => set('inspectorUserId', value)}
                  options={personOpts}
                  placeholder={t('inspections.form.choose')}
                  disabled={busy}
                />
              ) : null}
              <PageField id={`${formId}-remark`} label={t('erp.fields.note')} className='sm:col-span-2'>
                <Textarea
                  id={`${formId}-remark`}
                  maxLength={1000}
                  disabled={busy}
                  value={values.remark}
                  onChange={(event) => set('remark', event.target.value)}
                />
              </PageField>
            </FieldGroup>
          </DetailSection>
          <DetailSection title={t('inspections.fields.lines')}>
            {errors.lines ? (
              <p role='alert' className='text-sm text-destructive'>{errors.lines}</p>
            ) : null}
            <LinesTable<LineDraft>
              columns={columns}
              rows={values.lines}
              getRowId={(line) => line.key}
              emptyMessage={t('inspections.form.linesEmpty')}
            />
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={inspection?.files ?? []}
              ids={values.fileIds}
              disabled={busy}
              onChange={(ids) => set('fileIds', [...ids])}
            />
          </DetailSection>
        </FeedbackForm>
        </div>
      </PageContainer>
      <InspectionOrderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        onPick={applyOrder}
      />
      <ConfirmDialog
        open={confirmLeave}
        title={t('inspections.discardTitle', {
          name: inspection?.docNo ?? t('inspections.newTitle'),
        })}
        description={t('inspections.discardDescription')}
        confirmLabel={t('inspections.actions.discard')}
        busy={false}
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          doLeave();
        }}
      />
      {leave.dialog}
    </RouteChildPage>
  );
}
