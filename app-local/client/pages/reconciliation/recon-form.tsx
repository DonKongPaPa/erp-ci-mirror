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
import { ReconciliationClient, type PartnerRef, type ReconRecord } from './client.js';
import { ReconField } from './fields.js';
import type { ReconKind } from './kinds.js';
import { RECON_LIST_KEYS } from './page-id.js';
import {
  emptyReconForm, financeErrorText, reconFieldErrors, reconFormOf, reconInputOf,
  validateRecon, type ReconFormValues,
} from './model.js';
import { SourceDocPicker } from './pickers.js';

/** 新建、编辑应收与应付对账单。明细是勾选已过账单据后由服务摊开的只读快照。 */
export function ReconFormPage({ kind, editing }: {
  readonly kind: ReconKind;
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
  const allowed = editing ? update.can : create.can;
  const pending = editing ? update.isPending || view.isPending : create.isPending;
  const record = useRecord<ReconRecord>(`${kind.api}/${encodeURIComponent(id)}`, editing && view.can);
  const projects = useDictEntries('project', dictView.can);
  const invoiceTypes = useDictEntries('invoice_type', dictView.can);
  const people = usePersonOptions(optionsView.can);
  const [partners, setPartners] = useState<readonly PartnerRef[]>([]);

  useEffect(() => {
    if (!view.can) return;
    const controller = new AbortController();
    void client.partners(kind.partnerKind, { pageSize: 100 })
      .then((page) => { if (!controller.signal.aborted) setPartners(page.items); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, view.can, kind.partnerKind]);

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
    <ReconFormView
      key={record.data?.updatedAt}
      kind={kind}
      client={client}
      initial={record.data ? reconFormOf(record.data, kind) : emptyReconForm()}
      record={record.data}
      partners={partners}
      projects={projects.items}
      invoiceTypes={invoiceTypes.items}
      people={people.items}
      canConfirm={confirm.can}
      optionsView={optionsView.can}
    />
  );
}

interface ReconFormViewProps {
  readonly kind: ReconKind;
  readonly client: ReconciliationClient;
  readonly initial: ReconFormValues;
  readonly record: ReconRecord | undefined;
  readonly partners: readonly PartnerRef[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly invoiceTypes: readonly DictEntry[] | undefined;
  readonly people: readonly import('#components/erp/options').PersonOption[] | undefined;
  readonly canConfirm: boolean;
  readonly optionsView: boolean;
}

function ReconFormView({
  kind, client, initial, record, partners, projects, invoiceTypes, people, canConfirm, optionsView,
}: ReconFormViewProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<ReconFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof ReconFormValues>(key: K, value: ReconFormValues[K]): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => old[key] === undefined ? old : { ...old, [key]: undefined });
  };

  const doSubmit = async (register: boolean): Promise<void> => {
    if (busy) return;
    const found = validateRecon(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = reconInputOf(values, kind);
      const result = record
        ? await client.update(kind.api, record.id, input)
        : await client.create(kind.api, input);
      if (register) await client.confirm(kind.api, result.id);
      toaster.show({
        type: 'success',
        title: register
          ? t('reconciliation.registeredToast', { docNo: result.docNo })
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
      setErrors(reconFieldErrors(cause));
      if (cause instanceof ApiClientError && cause.reason === 'RECON_NOT_DRAFT')
        void navigate({ pathname: '..', search: location.search }, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const partnerChoices = withKnownChoices(
    (partners ?? []).map((one) => ({ value: one.id, label: `${one.code} ${one.name}` })),
    [partnerChoiceFrom(kind.partnerKind === 'customer' ? record?.customer : record?.supplier)],
  );
  const projectChoices = dictChoices(projects);
  const typeChoices = dictChoices(invoiceTypes);
  const personOptions = withKnownChoices(personChoices(people), [
    personChoiceFrom(record?.handler),
  ]);

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
              <ReconField id={`${formId}-reconDate`} label={t('reconciliation.reconDate')} required error={errors.reconDate}>
                <Input id={`${formId}-reconDate`} inputMode='numeric' value={values.reconDate} onChange={(event) => set('reconDate', event.target.value)} />
              </ReconField>
              <ReconField id={`${formId}-partnerId`} label={t(kind.partnerKind === 'customer' ? 'reconciliation.customer' : 'reconciliation.supplier')} required error={errors.partnerId}>
                <Select items={partnerChoices} value={values.partnerId || null} onValueChange={(next) => set('partnerId', next ?? '')}>
                  <SelectTrigger id={`${formId}-partnerId`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{partnerChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </ReconField>
              <ReconField id={`${formId}-periodAmount`} label={t('reconciliation.periodAmount')} required error={errors.periodAmount}>
                <Input id={`${formId}-periodAmount`} inputMode='decimal' value={values.periodAmount} onChange={(event) => set('periodAmount', event.target.value)} />
              </ReconField>
              <ReconField id={`${formId}-expectedPayDate`} label={t('reconciliation.expectedPayDate')}>
                <Input id={`${formId}-expectedPayDate`} inputMode='numeric' value={values.expectedPayDate} onChange={(event) => set('expectedPayDate', event.target.value)} />
              </ReconField>
              <ReconField id={`${formId}-contactName`} label={t('reconciliation.contactName')}>
                <Input id={`${formId}-contactName`} value={values.contactName} onChange={(event) => set('contactName', event.target.value)} />
              </ReconField>
              <ReconField id={`${formId}-phone`} label={t('reconciliation.phone')}>
                <Input id={`${formId}-phone`} value={values.phone} onChange={(event) => set('phone', event.target.value)} />
              </ReconField>
              {kind.typeDict === 'invoice_type' ? (
                <ReconField id={`${formId}-invoiceTypeCode`} label={t('reconciliation.invoiceType')} error={errors.invoiceTypeCode}>
                  <Select items={typeChoices} value={values.invoiceTypeCode || null} onValueChange={(next) => set('invoiceTypeCode', next ?? '')}>
                    <SelectTrigger id={`${formId}-invoiceTypeCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                    <SelectContent>{typeChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </ReconField>
              ) : null}
              <ReconField id={`${formId}-projectCode`} label={t('reconciliation.project')}>
                <Select items={projectChoices} value={values.projectCode || null} onValueChange={(next) => set('projectCode', next ?? '')}>
                  <SelectTrigger id={`${formId}-projectCode`} className='w-full'><SelectValue placeholder={t('orderDocs.form.choose')} /></SelectTrigger>
                  <SelectContent>{projectChoices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </ReconField>
              <ReconField id={`${formId}-handlerUserId`} label={t('reconciliation.handler')} error={errors.handlerUserId}>
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
          <DetailSection
            title={t('reconciliation.snapshotLines')}
            actions={
              <Button type='button' size='sm' variant='outline' onClick={() => setPicking(true)}>
                {t(kind.sourceKind === 'out' ? 'reconciliation.pickOutbound' : 'reconciliation.pickInbound')}
              </Button>
            }
          >
            <p className='text-sm text-muted-foreground'>{t('reconciliation.snapshotHint')}</p>
            {errors.sourceIds ? <p role='alert' className='text-sm text-destructive'>{errors.sourceIds}</p> : null}
            <ul className='divide-y'>
              {values.sourceIds.map((id) => (
                <li key={id} className='flex items-center gap-2 py-2 text-sm'>
                  <span className='tabular-nums'>{id}</span>
                  <Button type='button' variant='ghost' size='sm' onClick={() => set('sourceIds', values.sourceIds.filter((one) => one !== id))}>
                    {t('reconciliation.removeSource')}
                  </Button>
                </li>
              ))}
            </ul>
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel files={record?.files ?? []} ids={values.fileIds} disabled={busy} onChange={(ids) => set('fileIds', [...ids])} />
          </DetailSection>
          <SourceDocPicker
            kind={kind} open={picking} onOpenChange={setPicking}
            selected={values.sourceIds}
            onPick={(ids) => set('sourceIds', ids)}
          />
          {optionsView ? null : null}
          {leave.dialog}
        </FeedbackForm>
      </PageContainer>
    </RouteChildPage>
  );
}
