import {
  ApiClientError, useApiClient, usePageBreadcrumb, useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useResolvedPath } from 'react-router';

import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { DetailSection } from '#components/erp/detail';
import type { FieldErrors } from '#components/erp/form-dialog';
import {
  dictChoices, partnerChoiceFrom, personChoiceFrom, personChoices,
  useDictEntries, usePersonOptions, withKnownChoices, type DictEntry,
} from '#components/erp/options';
import { useRecord } from '#components/erp/record';
import { usePageLeave } from '../../routing/route-leave-boundary.js';
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '#components/ui/select';
import { Textarea } from '#components/ui/textarea';

import { useAncestorSearch } from '../../routing/route-context.js';
import { ReconciliationClient, type DocRecord, type PartnerRef, type ReceivableOrder, type ReconOption } from './client.js';
import { ReconField } from './fields.js';
import type { DocKind } from './kinds.js';
import { RECEIVABLE_RECONS_RESOURCE, RECON_LIST_KEYS } from './page-id.js';
import {
  docFieldErrors, docFormOf, docInputOf, emptyDocForm, emptyLine,
  financeErrorText, validateDoc, type DocFormValues, type DocLineDraft,
} from './model.js';
import { ReceivableOrderPicker, ReconPicker } from './pickers.js';

/** 新建、编辑收入记录与销售开票记录。绑销售订单或已确认的对账单，明细逐单填金额。 */
export function DocFormPage({ kind, editing }: {
  readonly kind: DocKind;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params[kind.param] ?? '') : '';
  const client = useMemo(() => new ReconciliationClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const create = useCan({ resource: kind.resource, action: 'create' });
  const update = useCan({ resource: kind.resource, action: 'update' });
  const confirm = useCan({ resource: kind.resource, action: 'confirm' });
  const dictView = useCan({ resource: { type: 'composite', id: 'bizDict' }, action: 'view' });
  const optionsView = useCan({ resource: { type: 'composite', id: 'bizOptions' }, action: 'view' });
  const partnersView = useCan({
    resource: { type: 'composite', id: 'receivableRecons' }, action: 'view',
  });
  const allowed = editing ? update.can : create.can;
  const pending = editing ? update.isPending || view.isPending : create.isPending;
  const record = useRecord<DocRecord>(`${kind.api}/${encodeURIComponent(id)}`, editing && view.can);
  const types = useDictEntries(kind.typeDict, dictView.can);
  const funds = useDictEntries('fund_account', dictView.can);
  const projects = useDictEntries('project', dictView.can);
  const people = usePersonOptions(optionsView.can);
  const [partners, setPartners] = useState<readonly PartnerRef[]>([]);
  const [pickingOrder, setPickingOrder] = useState(false);
  const [pickingRecon, setPickingRecon] = useState(false);

  useEffect(() => {
    if (!partnersView.can) return;
    const controller = new AbortController();
    void client.partners('customer', { pageSize: 100 })
      .then((page) => { if (!controller.signal.aborted) setPartners(page.items); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, partnersView.can]);

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t(`navigation.${kind.l}`),
    to: { pathname: owner, search: useAncestorSearch(owner, RECON_LIST_KEYS) },
  };
  const title = editing ? t(`${kind.l}.editTitle`) : t(`${kind.l}.newTitle`);
  usePageBreadcrumb(editing
    ? [listLevel, { label: record.data?.docNo ?? t(`${kind.l}.detailTitle`) }, { label: title }]
    : [listLevel, { label: title }]);

  const shell = (children: ReactNode): ReactElement => (
    <RouteChildPage>
      <PageContainer><PageHeader title={title} />{children}</PageContainer>
    </RouteChildPage>
  );
  if (pending) return shell(<p role='status'>{t('status.loading')}</p>);
  if (!allowed) return shell(<p role='status'>{t('erp.form.noWrite')}</p>);
  if (editing && record.data === undefined)
    return shell(!view.can ? (
      <p role='alert'>{t('erp.errors.denied')}</p>
    ) : record.error !== undefined ? (
      <Alert variant='destructive'><AlertDescription>{financeErrorText(record.error, t)}</AlertDescription></Alert>
    ) : <p role='status'>{t('status.loading')}</p>);
  if (record.data && record.data.status !== 'draft')
    return shell(<Alert><AlertDescription>{t('reconciliation.notDraft')}</AlertDescription></Alert>);

  return (
    <DocForm
      key={record.data?.updatedAt}
      kind={kind}
      client={client}
      initial={record.data ? docFormOf(record.data) : emptyDocForm()}
      record={record.data}
      types={types.items}
      funds={funds.items}
      projects={projects.items}
      people={people.items}
      partners={partners}
      canConfirm={confirm.can}
      pickingOrder={pickingOrder}
      setPickingOrder={setPickingOrder}
      pickingRecon={pickingRecon}
      setPickingRecon={setPickingRecon}
    />
  );
}

interface DocFormProps {
  readonly kind: DocKind;
  readonly client: ReconciliationClient;
  readonly initial: DocFormValues;
  readonly record: DocRecord | undefined;
  readonly types: readonly DictEntry[] | undefined;
  readonly funds: readonly DictEntry[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly people: readonly import('#components/erp/options').PersonOption[] | undefined;
  readonly partners: readonly PartnerRef[] | undefined;
  readonly canConfirm: boolean;
  readonly pickingOrder: boolean;
  readonly setPickingOrder: (open: boolean) => void;
  readonly pickingRecon: boolean;
  readonly setPickingRecon: (open: boolean) => void;
}

function DocForm({
  kind, client, initial, record, types, funds, projects, people, partners,
  canConfirm, pickingOrder, setPickingOrder, pickingRecon, setPickingRecon,
}: DocFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<DocFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof DocFormValues>(key: K, value: DocFormValues[K]): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => old[key] === undefined ? old : { ...old, [key]: undefined });
  };
  const setLine = (key: string, patch: Partial<DocLineDraft>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => line.key === key ? { ...line, ...patch } : line),
    }));
  };
  const addEmptyLine = (): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: [...old.lines, emptyLine()] }));
  };
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: old.lines.filter((line) => line.key !== key) }));
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`${formId}-${focus}`)?.focus();
  }, [focus, formId]);

  const doSubmit = async (register: boolean): Promise<void> => {
    if (busy) return;
    const found = validateDoc(values, t);
    setErrors(found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first) { setFocus(first); return; }
    setBusy(true);
    setError(undefined);
    try {
      const input = docInputOf(values, kind, register);
      const result = record
        ? await client.update(kind.api, record.id, input)
        : await client.create(kind.api, input);
      toaster.show({
        type: 'success',
        title: register ? t('reconciliation.registeredToast', { docNo: result.docNo })
          : t('reconciliation.savedToast', { docNo: result.docNo }),
      });
      setSaved(true);
      leave.allow();
      await navigate(record
        ? { pathname: '..', search: location.search }
        : { pathname: `${kind.base}/${encodeURIComponent(result.id)}`, search: location.search },
      { replace: true });
    } catch (cause) {
      setError(financeErrorText(cause, t));
      setErrors(docFieldErrors(cause));
      if (cause instanceof ApiClientError && cause.reason === 'FINANCE_NOT_DRAFT')
        void navigate({ pathname: '..', search: location.search }, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const typeChoices = dictChoices(types);
  const fundChoices = dictChoices(funds);
  const projectChoices = dictChoices(projects);
  const personOptions = withKnownChoices(personChoices(people), [
    personChoiceFrom(record?.handler),
  ]);
  const partnerChoices = withKnownChoices(
    (partners ?? []).map((one) => ({ value: one.id, label: `${one.code} ${one.name}` })),
    [partnerChoiceFrom(record?.customer)],
  );
  const bindChoices = [
    { value: 'sales_order', label: t('reconciliation.bindSalesOrder') },
    { value: 'receivable_recon', label: t('reconciliation.bindReceivableRecon') },
    { value: 'none', label: t('reconciliation.bindNone') },
  ];
  const boundSalesOrder = (order: ReceivableOrder): void => {
    setPickingOrder(false);
    setValues((old) => {
      const first = old.lines[0];
      const line = {
        key: first?.key ?? `new-${Date.now()}`,
        salesOrderId: order.id, receivableReconId: '',
        amount: first?.amount ?? '', note: first?.note ?? '',
      };
      return {
        ...old,
        lines: first ? [line, ...old.lines.slice(1)] : [line],
        customerId: order.customerId ?? old.customerId,
      };
    });
    setTouched(true);
  };
  const boundRecon = (option: ReconOption): void => {
    setPickingRecon(false);
    setValues((old) => {
      const first = old.lines[0];
      const line = {
        key: first?.key ?? `new-${Date.now()}`,
        salesOrderId: '', receivableReconId: option.id,
        amount: first?.amount ?? '', note: first?.note ?? '',
      };
      return { ...old, lines: first ? [line, ...old.lines.slice(1)] : [line] };
    });
    setTouched(true);
  };

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={record ? t(`${kind.l}.editTitle`) : t(`${kind.l}.newTitle`)}
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={() => void navigate({ pathname: '..', search: location.search }, { replace: true })}>
                {t('actions.cancel')}
              </Button>
              {canConfirm ? (
                <PendingButton type='button' busy={busy} action='post' onClick={() => void doSubmit(true)}>
                  {t('reconciliation.saveAndRegister')}
                </PendingButton>
              ) : null}
              <PendingButton type='submit' form={formId} busy={busy} action='save'>{t('reconciliation.saveDraft')}</PendingButton>
            </>
          }
        />
        <FeedbackForm
          id={formId}
          onSubmit={(event) => { event.preventDefault(); void doSubmit(false); }}
          submitting={busy}
          values={() => values}
          savedValues={initial}
          className='flex w-full max-w-3xl flex-col gap-6'
        >
          {error ? <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DetailSection title={t('reconciliation.header')}>
            <FieldGroup className='grid gap-4 sm:grid-cols-2'>
              <ReconField id={`${formId}-date`} label={t(kind.id === 'income' ? 'reconciliation.incomeDate' : 'reconciliation.invoiceDate')} required error={errors.date}>
                <Input id={`${formId}-date`} inputMode='numeric' value={values.date} onChange={(event) => set('date', event.target.value)} />
              </ReconField>
              <ReconField id={`${formId}-typeCode`} label={t(kind.id === 'income' ? 'reconciliation.incomeType' : 'reconciliation.invoiceType')} error={errors.typeCode}>
                <Select items={typeChoices} value={values.typeCode || null} onValueChange={(next) => set('typeCode', next ?? '')}>
                  <SelectTrigger id={`${formId}-typeCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{typeChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </ReconField>
              {kind.id === 'income' ? (
                <>
                  <ReconField id={`${formId}-fundAccountCode`} label={t('reconciliation.fundAccount')}>
                    <Select items={fundChoices} value={values.fundAccountCode || null} onValueChange={(next) => set('fundAccountCode', next ?? '')}>
                      <SelectTrigger id={`${formId}-fundAccountCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                      <SelectContent>{fundChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </ReconField>
                  <ReconField id={`${formId}-payerName`} label={t('reconciliation.payerName')}>
                    <Input id={`${formId}-payerName`} value={values.payerName} onChange={(event) => set('payerName', event.target.value)} />
                  </ReconField>
                </>
              ) : (
                <>
                  <ReconField id={`${formId}-invoiceToName`} label={t('reconciliation.invoiceToName')}>
                    <Input id={`${formId}-invoiceToName`} value={values.invoiceToName} onChange={(event) => set('invoiceToName', event.target.value)} />
                  </ReconField>
                  <ReconField id={`${formId}-invoiceNo`} label={t('reconciliation.invoiceNo')}>
                    <Input id={`${formId}-invoiceNo`} value={values.invoiceNo} onChange={(event) => set('invoiceNo', event.target.value)} />
                  </ReconField>
                </>
              )}
              <ReconField id={`${formId}-bindMode`} label={t('reconciliation.bindMode')}>
                <Select items={bindChoices} value={values.bindMode} onValueChange={(next) => set('bindMode', next ?? 'none')}>
                  <SelectTrigger id={`${formId}-bindMode`} className='w-full'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value='sales_order'>{t('reconciliation.bindSalesOrder')}</SelectItem>
                    <SelectItem value='receivable_recon'>{t('reconciliation.bindReceivableRecon')}</SelectItem>
                    <SelectItem value='none'>{t('reconciliation.bindNone')}</SelectItem>
                  </SelectContent>
                </Select>
              </ReconField>
              {values.bindMode === 'sales_order' ? (
                <ReconField id={`${formId}-customerId`} label={t('reconciliation.customer')} error={errors.customerId}>
                  <Select items={partnerChoices} value={values.customerId || null} onValueChange={(next) => set('customerId', next ?? '')}>
                    <SelectTrigger id={`${formId}-customerId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                    <SelectContent>{partnerChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </ReconField>
              ) : null}
              <ReconField id={`${formId}-projectCode`} label={t('reconciliation.project')}>
                <Select items={projectChoices} value={values.projectCode || null} onValueChange={(next) => set('projectCode', next ?? '')}>
                  <SelectTrigger id={`${formId}-projectCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{projectChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </ReconField>
              <ReconField id={`${formId}-handlerUserId`} label={t('reconciliation.handler')}>
                <Select items={personOptions} value={values.handlerUserId || null} onValueChange={(next) => set('handlerUserId', next ?? '')}>
                  <SelectTrigger id={`${formId}-handlerUserId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{personOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </ReconField>
              <ReconField id={`${formId}-remark`} label={t('erp.fields.note')} className='sm:col-span-2'>
                <Textarea id={`${formId}-remark`} rows={2} value={values.remark} onChange={(event) => set('remark', event.target.value)} />
              </ReconField>
            </FieldGroup>
          </DetailSection>
          {values.bindMode === 'none' ? (
            <DetailSection title={t('reconciliation.lines')}>
              <ReconField id={`${formId}-amount`} label={t('reconciliation.totalAmount')} required error={errors.amount}>
                <Input id={`${formId}-amount`} inputMode='decimal' value={values.amount} onChange={(event) => set('amount', event.target.value)} />
              </ReconField>
            </DetailSection>
          ) : (
            <DetailSection
              title={t('reconciliation.lines')}
              actions={
                values.bindMode === 'sales_order' ? (
                  <Button type='button' size='sm' variant='outline' onClick={() => setPickingOrder(true)}>
                    {t('reconciliation.pickSalesOrder')}
                  </Button>
                ) : (
                  <Button type='button' size='sm' variant='outline' onClick={() => setPickingRecon(true)}>
                    {t('reconciliation.pickRecon')}
                  </Button>
                )
              }
            >
              <p className='text-sm text-muted-foreground'>{t('reconciliation.linesHint')}</p>
              {errors.lines ? <p role='alert' className='text-sm text-destructive'>{errors.lines}</p> : null}
              {values.lines.map((line, index) => (
                <FieldGroup key={line.key} className='grid gap-3 border-t pt-3 sm:grid-cols-3'>
                  <ReconField id={`${formId}-line.${index}.id`} label={t('reconciliation.upstream')} required error={errors[`line.${index}.id`]}>
                    <Input
                      id={`${formId}-line.${index}.id`} readOnly
                      value={values.bindMode === 'sales_order' ? line.salesOrderId : line.receivableReconId}
                    />
                  </ReconField>
                  <ReconField id={`${formId}-line.${index}.amount`} label={t(kind.id === 'income' ? 'reconciliation.incomeAmount' : 'reconciliation.invoiceAmount')} required error={errors[`line.${index}.amount`]}>
                    <Input id={`${formId}-line.${index}.amount`} inputMode='decimal' value={line.amount} onChange={(event) => setLine(line.key, { amount: event.target.value })} />
                  </ReconField>
                  <div className='flex min-w-0 items-end gap-2 sm:col-start-3'>
                    <ReconField id={`${formId}-line.${index}.note`} label={t('erp.fields.note')} className='min-w-0 flex-1'>
                      <Input id={`${formId}-line.${index}.note`} value={line.note} onChange={(event) => setLine(line.key, { note: event.target.value })} />
                    </ReconField>
                    <Button type='button' variant='ghost' size='sm' onClick={() => removeLine(line.key)}>{t('reconciliation.removeLine')}</Button>
                  </div>
                </FieldGroup>
              ))}
              <Button type='button' variant='outline' size='sm' onClick={addEmptyLine}>{t('reconciliation.addLine')}</Button>
            </DetailSection>
          )}
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel files={record?.files ?? []} ids={values.fileIds} disabled={busy} onChange={(ids) => set('fileIds', [...ids])} />
          </DetailSection>
          <ReceivableOrderPicker open={pickingOrder} onOpenChange={setPickingOrder} onPick={boundSalesOrder} />
          <ReconPicker apiBase='receivable-recons' resourceId={RECEIVABLE_RECONS_RESOURCE.id} open={pickingRecon} onOpenChange={setPickingRecon} onPick={boundRecon} />
          {leave.dialog}
        </FeedbackForm>
      </PageContainer>
    </RouteChildPage>
  );
}
