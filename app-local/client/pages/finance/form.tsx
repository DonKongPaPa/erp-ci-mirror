import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useResolvedPath,
} from 'react-router';

import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { DetailSection } from '#components/erp/detail';
import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText } from '#components/erp/messages';
import {
  dictChoices,
  personChoices,
  useDictEntries,
  usePersonOptions,
  type DictEntry,
} from '#components/erp/options';
import { useRecord } from '#components/erp/record';
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

import { useAncestorSearch } from '../../routing/route-context.js';
import { usePageLeave } from '../../routing/route-leave-boundary.js';
import {
  FinanceClient,
  type FinanceRecord,
  type PayableOrder,
  type SupplierOption,
} from './client.js';
import type { FinanceKind } from './kinds.js';
import {
  emptyForm,
  fieldErrors,
  formOf,
  inputOf,
  validate,
  type FinanceFormValues,
  type FinanceLineDraft,
} from './model.js';
import { PayablePicker } from './payable-picker.js';
import { FINANCE_LIST_KEYS } from './list-keys.js';
import { FinanceField } from './fields.js';

/**
 * 新建、编辑支出记录与到票记录（`/expenses/new`、`/invoice-receipts/:id/edit`）。
 * 建单默认是草稿；有登记动作时可以直接「保存并登记」（请求体带 `confirm: true`）。
 * 明细选的是财务专用的待付款采购订单窄形状：没有明细、单价、备注、经办人。
 */
export function FinanceFormPage({
  kind,
  editing,
}: {
  readonly kind: FinanceKind;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params[kind.param] ?? '') : '';
  const client = useMemo(() => new FinanceClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const create = useCan({ resource: kind.resource, action: 'create' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const confirm = useCan({ resource: kind.resource, action: 'confirm' });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const allowed = editing ? update.can : create.can;
  const pending = editing ? update.isPending || view.isPending : create.isPending;
  const record = useRecord<FinanceRecord>(
    `${kind.api}/${encodeURIComponent(id)}`,
    editing && view.can,
  );
  const types = useDictEntries(kind.typeDict, dictView.can);
  const funds = useDictEntries('fund_account', dictView.can);
  const projects = useDictEntries('project', dictView.can);
  const people = usePersonOptions(optionsView.can);
  const [suppliers, setSuppliers] = useState<readonly SupplierOption[]>([]);
  const [payable, setPayable] = useState<readonly PayableOrder[]>([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!view.can) return;
    const controller = new AbortController();
    void client
      .supplierOptions()
      .then((page) => {
        if (!controller.signal.aborted) setSuppliers(page.items);
      })
      .catch(() => undefined);
    void client
      .payable({ pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) setPayable(page.items);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, view.can]);

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t(`navigation.${kind.l}`),
    to: { pathname: owner, search: useAncestorSearch(owner, FINANCE_LIST_KEYS) },
  };
  const title = editing ? t(`${kind.l}.editTitle`) : t(`${kind.l}.newTitle`);
  usePageBreadcrumb(
    editing
      ? [
          listLevel,
          { label: record.data?.docNo ?? t(`${kind.l}.detailTitle`) },
          { label: title },
        ]
      : [listLevel, { label: title }],
  );
  const description = editing
    ? t(`${kind.l}.editDescription`, { docNo: record.data?.docNo ?? '' })
    : t(`${kind.l}.newDescription`);

  const shell = (children: ReactNode): ReactElement => (
    <RouteChildPage>
      <PageContainer>
        <PageHeader title={title} description={description} />
        {children}
      </PageContainer>
    </RouteChildPage>
  );
  if (pending)
    return shell(<p role='status'>{t('status.loading')}</p>);
  if (!allowed) return shell(<p role='status'>{t('erp.form.noWrite')}</p>);
  if (editing && record.data === undefined)
    return shell(
      !view.can ? (
        <p role='alert'>{t('erp.errors.denied')}</p>
      ) : record.error !== undefined ? (
        <Alert variant='destructive'>
          <AlertDescription>{errorText(record.error, t)}</AlertDescription>
        </Alert>
      ) : (
        <p role='status'>{t('status.loading')}</p>
      ),
    );
  if (record.data && record.data.status !== 'draft')
    return shell(<Alert><AlertDescription>{t('finance.notDraft')}</AlertDescription></Alert>);

  return (
    <FinanceForm
      key={record.data?.updatedAt}
      kind={kind}
      client={client}
      initial={record.data ? formOf(record.data) : emptyForm()}
      record={record.data}
      types={types.items}
      funds={funds.items}
      projects={projects.items}
      people={people.items}
      suppliers={suppliers}
      payable={payable}
      canConfirm={confirm.can}
      picking={picking}
      setPicking={setPicking}
    />
  );
}

interface FinanceFormProps {
  readonly kind: FinanceKind;
  readonly client: FinanceClient;
  readonly initial: FinanceFormValues;
  readonly record: FinanceRecord | undefined;
  readonly types: readonly DictEntry[] | undefined;
  readonly funds: readonly DictEntry[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly people: readonly import('#components/erp/options').PersonOption[] | undefined;
  readonly suppliers: readonly SupplierOption[] | undefined;
  readonly payable: readonly PayableOrder[] | undefined;
  readonly canConfirm: boolean;
  readonly picking: boolean;
  readonly setPicking: (open: boolean) => void;
}

function FinanceForm({
  kind,
  client,
  initial,
  record,
  types,
  funds,
  projects,
  people,
  suppliers,
  canConfirm,
  picking,
  setPicking,
  payable,
}: FinanceFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<FinanceFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof FinanceFormValues>(
    key: K,
    value: FinanceFormValues[K],
  ): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) =>
      old[key] === undefined ? old : { ...old, [key]: undefined },
    );
  };
  const setLine = (key: string, patch: Partial<FinanceLineDraft>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) =>
        line.key === key ? { ...line, ...patch } : line,
      ),
    }));
  };
  const addEmptyLine = (): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: [...old.lines, { key: `new-${Date.now()}-${Math.random()}`, purchaseOrderId: '', amount: '', note: '' }] }));
  };
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((line) => line.key !== key),
    }));
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`${formId}-${focus}`)?.focus();
  }, [focus, formId]);

  const doSubmit = async (register: boolean): Promise<void> => {
    if (busy) return;
    const found = validate(values, t);
    setErrors(found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first) {
      setFocus(first);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const input = inputOf(values, kind, register);
      const result = record
        ? await client.update(kind.api, record.id, input)
        : await client.create(kind.api, input);
      toaster.show({
        type: 'success',
        title: register
          ? t(`${kind.l}.registeredToast`, { docNo: result.docNo })
          : record
            ? t(`${kind.l}.savedToast`, { docNo: result.docNo })
            : t(`${kind.l}.createdToast`, { docNo: result.docNo }),
      });
      setSaved(true);
      leave.allow();
      await navigate(
        record
          ? { pathname: '..', search: location.search }
          : { pathname: `${kind.base}/${encodeURIComponent(result.id)}`, search: location.search },
        { replace: true },
      );
    } catch (cause) {
      setError(errorText(cause, t));
      setErrors(fieldErrors(cause));
      if (cause instanceof ApiClientError && cause.reason === 'FINANCE_NOT_DRAFT')
        void navigate({ pathname: '..', search: location.search }, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const typeChoices = dictChoices(types);
  const fundChoices = dictChoices(funds);
  const projectChoices = dictChoices(projects);
  const personOptions = personChoices(people);
  const supplierChoices = (suppliers ?? []).map((one) => ({
    value: one.id,
    label: `${one.code} ${one.name}`,
  }));
  const orderChoices = (payable ?? []).map((one) => ({
    value: one.id,
    label: `${one.orderNo} · ${one.supplier?.name ?? ''}`,
  }));

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={record ? t(`${kind.l}.editTitle`) : t(`${kind.l}.newTitle`)}
          description={
            record
              ? t(`${kind.l}.editDescription`, { docNo: record.docNo })
              : t(`${kind.l}.newDescription`)
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={() => void navigate({ pathname: '..', search: location.search }, { replace: true })}>
                {t('actions.cancel')}
              </Button>
              {canConfirm ? (
                <PendingButton type='button' busy={busy} onClick={() => void doSubmit(true)}>
                  {t('finance.saveAndRegister')}
                </PendingButton>
              ) : null}
              <PendingButton type='submit' form={formId} busy={busy}>
                {t('finance.saveDraft')}
              </PendingButton>
            </>
          }
        />
        <FeedbackForm
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void doSubmit(false);
          }}
          submitting={busy}
          values={() => values}
          savedValues={initial}
          className='flex flex-col gap-6'
        >
          {error ? <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DetailSection title={t('finance.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <FinanceField id={`${formId}-date`} label={t(kind.id === 'expense' ? 'finance.expenseDate' : 'finance.invoiceDate')} required error={errors.date}>
                <Input id={`${formId}-date`} inputMode='numeric' value={values.date} onChange={(event) => set('date', event.target.value)} />
              </FinanceField>
              <FinanceField id={`${formId}-typeCode`} label={t(kind.id === 'expense' ? 'finance.expenseType' : 'finance.invoiceType')} error={errors.typeCode}>
                <Select items={typeChoices} value={values.typeCode || null} onValueChange={(next) => set('typeCode', next ?? '')}>
                  <SelectTrigger id={`${formId}-typeCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{typeChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </FinanceField>
              {kind.id === 'expense' ? (
                <FinanceField id={`${formId}-fundAccountCode`} label={t('finance.fundAccount')} error={errors.fundAccountCode}>
                  <Select items={fundChoices} value={values.fundAccountCode || null} onValueChange={(next) => set('fundAccountCode', next ?? '')}>
                    <SelectTrigger id={`${formId}-fundAccountCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                    <SelectContent>{fundChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </FinanceField>
              ) : null}
              {kind.id === 'invoice' ? (
                <>
                  <FinanceField id={`${formId}-issuerName`} label={t('finance.issuerName')}>
                    <Input id={`${formId}-issuerName`} value={values.issuerName} onChange={(event) => set('issuerName', event.target.value)} />
                  </FinanceField>
                  <FinanceField id={`${formId}-invoiceNo`} label={t('finance.invoiceNo')}>
                    <Input id={`${formId}-invoiceNo`} value={values.invoiceNo} onChange={(event) => set('invoiceNo', event.target.value)} />
                  </FinanceField>
                </>
              ) : null}
              <FinanceField id={`${formId}-bindMode`} label={t('finance.bindMode')}>
                <Select value={values.bindMode} onValueChange={(next) => set('bindMode', (next ?? 'none'))}>
                  <SelectTrigger id={`${formId}-bindMode`} className='w-full'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value='purchase_order'>{t('finance.bindPurchaseOrder')}</SelectItem>
                    <SelectItem value='none'>{t('finance.bindNone')}</SelectItem>
                  </SelectContent>
                </Select>
              </FinanceField>
              <FinanceField id={`${formId}-supplierId`} label={t('finance.supplier')} error={errors.supplierId}>
                <Select items={supplierChoices} value={values.supplierId || null} onValueChange={(next) => set('supplierId', next ?? '')}>
                  <SelectTrigger id={`${formId}-supplierId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{supplierChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </FinanceField>
              <FinanceField id={`${formId}-payeeName`} label={t('finance.payeeName')}>
                <Input id={`${formId}-payeeName`} value={values.payeeName} onChange={(event) => set('payeeName', event.target.value)} />
              </FinanceField>
              <FinanceField id={`${formId}-projectCode`} label={t('finance.project')} error={errors.projectCode}>
                <Select items={projectChoices} value={values.projectCode || null} onValueChange={(next) => set('projectCode', next ?? '')}>
                  <SelectTrigger id={`${formId}-projectCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{projectChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </FinanceField>
              <FinanceField id={`${formId}-handlerUserId`} label={t('finance.handler')} error={errors.handlerUserId}>
                <Select items={personOptions} value={values.handlerUserId || null} onValueChange={(next) => set('handlerUserId', next ?? '')}>
                  <SelectTrigger id={`${formId}-handlerUserId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{personOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </FinanceField>
              <FinanceField id={`${formId}-remark`} label={t('erp.fields.note')} className='sm:col-span-2'>
                <Textarea id={`${formId}-remark`} rows={2} value={values.remark} onChange={(event) => set('remark', event.target.value)} />
              </FinanceField>
            </FieldGroup>
          </DetailSection>
          {values.bindMode === 'purchase_order' ? (
            <DetailSection
              title={t('finance.lines')}
              actions={<Button type='button' size='sm' variant='outline' onClick={() => setPicking(true)}>{t('finance.pickOrderTitle')}</Button>}
            >
              <p className='text-sm text-muted-foreground'>{t('finance.linesHint')}</p>
              {errors.lines ? <p role='alert' className='text-sm text-destructive'>{errors.lines}</p> : null}
              {values.lines.map((line, index) => (
                <FieldGroup key={line.key} className='grid gap-3 border-t pt-3 sm:grid-cols-3'>
                  <FinanceField id={`${formId}-line.${index}.purchaseOrderId`} label={t('finance.upstreamOrder')} required error={errors[`line.${index}.purchaseOrderId`]}>
                    <Select items={orderChoices} value={line.purchaseOrderId || null} onValueChange={(next) => setLine(line.key, { purchaseOrderId: next ?? '' })}>
                      <SelectTrigger id={`${formId}-line.${index}.purchaseOrderId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                      <SelectContent>{orderChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </FinanceField>
                  <FinanceField id={`${formId}-line.${index}.amount`} label={t(kind.id === 'expense' ? 'finance.expenseAmount' : 'finance.invoiceAmount')} required error={errors[`line.${index}.amount`]}>
                    <Input id={`${formId}-line.${index}.amount`} inputMode='decimal' value={line.amount} onChange={(event) => setLine(line.key, { amount: event.target.value })} />
                  </FinanceField>
                  <FinanceField id={`${formId}-line.${index}.note`} label={t('erp.fields.note')}>
                    <Input id={`${formId}-line.${index}.note`} value={line.note} onChange={(event) => setLine(line.key, { note: event.target.value })} />
                  </FinanceField>
                  <Button type='button' variant='ghost' size='sm' onClick={() => removeLine(line.key)}>{t('finance.removeLine')}</Button>
                </FieldGroup>
              ))}
              <Button type='button' variant='outline' size='sm' onClick={addEmptyLine}>{t('finance.addLine')}</Button>
            </DetailSection>
          ) : (
            <DetailSection title={t('finance.lines')}>
              <FinanceField id={`${formId}-amount`} label={t('finance.totalAmount')} required error={errors.amount}>
                <Input id={`${formId}-amount`} inputMode='decimal' value={values.amount} onChange={(event) => set('amount', event.target.value)} />
              </FinanceField>
            </DetailSection>
          )}
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel files={record?.files ?? []} ids={values.fileIds} disabled={busy} onChange={(ids) => set('fileIds', [...ids])} />
          </DetailSection>
          <PayablePicker
            open={picking}
            onOpenChange={setPicking}
            onPick={(order) => {
              setPicking(false);
              // 选中的订单 id 直接填到第一行（空行则新建），金额仍由财务填。
              setValues((old) => {
                const first = old.lines[0];
                const line = {
                  key: first?.key ?? `new-${Date.now()}`,
                  purchaseOrderId: order.id,
                  amount: first?.amount ?? '',
                  note: first?.note ?? '',
                };
                return { ...old, lines: first ? [line, ...old.lines.slice(1)] : [line], supplierId: order.supplier?.id ?? old.supplierId };
              });
              setTouched(true);
            }}
          />
          {leave.dialog}
        </FeedbackForm>
      </PageContainer>
    </RouteChildPage>
  );
}
