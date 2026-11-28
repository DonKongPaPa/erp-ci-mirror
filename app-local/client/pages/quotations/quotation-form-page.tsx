import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
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
  defaultDictCode,
  dictChoices,
  personChoices,
  useDictEntries,
  usePersonOptions,
  type DictEntry,
  type PersonOption,
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

import { useAncestorSearch } from '../../routing/route-context.js';
import { usePageLeave } from '../../routing/route-leave-boundary.js';
import type { LineDraft } from '../orders/model.js';
import { LinesEditor } from '../orders/lines-editor.js';
import { newLine } from '../orders/model.js';
import { PageField, SelectField } from '../orders/fields.js';
import {
  useReferencePage,
  type Choice,
  type Item,
  type PartnerOption,
  type WarehouseOption,
} from '../orders/reference.js';
import { QuotationsClient, type Quotation } from './client.js';
import { QuotationTotals } from './fields.js';
import {
  emptyQuotationForm,
  quotationFieldErrors,
  quotationFormOf,
  quotationInputOf,
  validateQuotationForm,
  type QuotationFormValues,
} from './model.js';
import { QUOTATIONS_LIST_KEYS, QUOTATIONS_RESOURCE } from './page-id.js';

/**
 * 新建与编辑报价单（`/quotations/new`、`/quotations/:id/edit`）：盖在列表上的子页。
 * 表头字段照旧系统「报价单」的原字；明细复用销售订单的编辑器（少「图片」）。
 * 金额与六个合计由服务端算，页面只录原始输入、回显服务端返回的值；只有草稿能改。
 */
export default function QuotationFormPage({
  editing,
}: {
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const { session } = useAuthentication();
  const params = useParams();
  const quotationId = editing ? (params.quotationId ?? '') : '';
  const client = useMemo(() => new QuotationsClient(api), [api]);
  const view = useCan({ resource: QUOTATIONS_RESOURCE, action: 'view' });
  const create = useCan({ resource: QUOTATIONS_RESOURCE, action: 'create' });
  const update = useCan({ resource: QUOTATIONS_RESOURCE, action: 'update' });
  const allowed = editing ? update.can : create.can;
  const pending = editing ? update.isPending || view.isPending : create.isPending;
  const itemsView = useCan({ resource: { type: 'composite', id: 'items' }, action: 'view' });
  const customerView = useCan({ resource: { type: 'composite', id: 'customers' }, action: 'view' });
  const warehouseView = useCan({
    resource: { type: 'composite', id: 'inventory' },
    action: 'warehouseView',
  });
  const dictView = useCan({ resource: { type: 'composite', id: 'bizDict' }, action: 'view' });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const request = useRecord<Quotation>(
    quotationId ? `quotations/${encodeURIComponent(quotationId)}` : '',
    editing && view.can,
  );
  const quotation = request.data;
  const items = useReferencePage<Item>('items', itemsView.can);
  const customers = useReferencePage<PartnerOption>(
    'partners?kind=customer&status=active',
    customerView.can,
  );
  const warehouses = useReferencePage<WarehouseOption>(
    'warehouses?status=active',
    warehouseView.can,
  );
  const settlements = useDictEntries('settlement', dictView.can);
  const projects = useDictEntries('project', dictView.can);
  const taxRates = useDictEntries('tax_rate', dictView.can);
  const people = usePersonOptions(optionsView.can);
  const defaultTaxRate = defaultDictCode(taxRates.items);

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.quotations'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, QUOTATIONS_LIST_KEYS),
    },
  };
  const title = editing ? t('quotations.editTitle') : t('quotations.newTitle');
  usePageBreadcrumb(
    editing
      ? [
          listLevel,
          { label: quotation?.docNo ?? t('quotations.detailTitle') },
          { label: title },
        ]
      : [listLevel, { label: title }],
  );
  const description = editing
    ? t('quotations.editDescription', { docNo: quotation?.docNo ?? '' })
    : t('quotations.newDescription');

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
  if (editing && quotation === undefined)
    return (
      <FormShell title={title} description={description}>
        {!view.can ? (
          <p role='alert' className='text-sm text-muted-foreground'>
            {t('erp.errors.denied')}
          </p>
        ) : request.error !== undefined ? (
          <Alert variant='destructive'>
            <AlertDescription>{errorText(request.error, t)}</AlertDescription>
          </Alert>
        ) : (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('status.loading')}
          </p>
        )}
      </FormShell>
    );
  if (quotation && quotation.status !== 'draft')
    return (
      <FormShell title={title} description={description}>
        <Alert>
          <AlertDescription>{t('quotations.form.notDraft')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <QuotationForm
      key={quotation?.updatedAt}
      client={client}
      initial={
        quotation ? quotationFormOf(quotation) : emptyQuotationForm(session?.user.id ?? '')
      }
      quotation={quotation}
      items={items.items}
      customers={customers.items}
      warehouses={warehouses.items}
      settlements={settlements.items}
      projects={projects.items}
      people={people.items}
      defaultTaxRate={defaultTaxRate}
      onNotDraft={request.reload}
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

interface FormProps {
  readonly client: QuotationsClient;
  readonly initial: QuotationFormValues;
  /** 传了就是编辑。 */
  readonly quotation: Quotation | undefined;
  readonly items: readonly Item[] | undefined;
  readonly customers: readonly PartnerOption[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly settlements: readonly DictEntry[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly defaultTaxRate: string;
  readonly onNotDraft: () => void;
}

function QuotationForm({
  client,
  initial,
  quotation,
  items,
  customers,
  warehouses,
  settlements,
  projects,
  people,
  defaultTaxRate,
  onNotDraft,
}: FormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<QuotationFormValues>(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<{ readonly key: string; readonly at: number }>();
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof QuotationFormValues>(
    key: K,
    value: QuotationFormValues[K],
  ): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => (old[key] === undefined ? old : { ...old, [key]: undefined }));
  };
  const setLine = (key: string, patch: Readonly<Partial<LineDraft>>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  };
  const addLine = (): void => {
    setTouched(true);
    setErrors((old) => (old.lines === undefined ? old : { ...old, lines: undefined }));
    setValues((old) => ({ ...old, lines: [...old.lines, newLine(defaultTaxRate)] }));
  };
  /** 删的是没保存的行，不是删单据。 */
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({ ...old, lines: old.lines.filter((line) => line.key !== key) }));
    setErrors((old) =>
      Object.fromEntries(Object.entries(old).filter(([name]) => !name.endsWith(`-${key}`))),
    );
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`${formId}-${focus.key}`)?.focus();
  }, [focus, formId]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateQuotationForm(values, t);
    setErrors(() => found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first !== undefined) {
      setFocus({ key: first, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const input = quotationInputOf(values);
      const result = quotation
        ? await client.update(quotation.id, input)
        : await client.create(input);
      toaster.show({
        type: 'success',
        title: quotation
          ? t('quotations.toasts.saved', { name: result.docNo })
          : t('quotations.toasts.created', { name: result.docNo }),
      });
      setSaved(true);
      leave.allow();
      await navigate(
        {
          pathname: `/quotations/${encodeURIComponent(result.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(quotationFieldErrors(next));
      if (next instanceof ApiClientError && next.reason === 'QUOTATION_NOT_DRAFT')
        onNotDraft();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate({ pathname: '/quotations', search: location.search }, { replace: true });
  };

  const customerChoices: Choice[] = (customers ?? []).map((customer) => ({
    value: customer.id,
    label: `${customer.code} ${customer.name}`,
  }));
  const choices = (entries: readonly DictEntry[] | undefined): Choice[] => dictChoices(entries);
  const warehouseChoices: Choice[] = (warehouses ?? []).map((one) => ({
    value: one.id,
    label: `${one.code} ${one.name}`,
    disabled: one.status !== 'active',
  }));
  const handlerChoices = personChoices(people);
  const quoteDateError = errors.quoteDate;
  const validUntilError = errors.validUntil;
  const discountError = errors.discountAmount;

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={quotation ? t('quotations.editTitle') : t('quotations.newTitle')}
          description={
            quotation
              ? t('quotations.editDescription', { docNo: quotation.docNo })
              : t('quotations.newDescription')
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy}>
                {t('quotations.actions.saveDraft')}
              </PendingButton>
            </>
          }
        />
        <FeedbackForm
          id={formId}
          onSubmit={(event) => void onSubmit(event)}
          submitting={busy}
          className='flex flex-col gap-6'
        >
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DetailSection title={t('quotations.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <SelectField
                id={`${formId}-customerId`}
                label={t('quotations.fields.customer')}
                error={errors.customerId}
                value={values.customerId}
                onChange={(customerId) => set('customerId', customerId)}
                options={customerChoices}
                placeholder={t('quotations.form.choose')}
                disabled={busy}
              />
              <PageField
                id={`${formId}-quoteDate`}
                label={t('quotations.fields.quoteDate')}
                required
                error={quoteDateError}
                hint={t('quotations.form.dateHint')}
              >
                <Input
                  id={`${formId}-quoteDate`}
                  inputMode='numeric'
                  autoComplete='off'
                  aria-invalid={quoteDateError ? true : undefined}
                  disabled={busy}
                  value={values.quoteDate}
                  onChange={(event) => set('quoteDate', event.target.value)}
                />
              </PageField>
              <PageField
                id={`${formId}-validUntil`}
                label={t('quotations.fields.validUntil')}
                error={validUntilError}
                hint={t('quotations.form.dateHint')}
              >
                <Input
                  id={`${formId}-validUntil`}
                  inputMode='numeric'
                  autoComplete='off'
                  aria-invalid={validUntilError ? true : undefined}
                  disabled={busy}
                  value={values.validUntil}
                  onChange={(event) => set('validUntil', event.target.value)}
                />
              </PageField>
              <SelectField
                id={`${formId}-warehouseId`}
                label={t('quotations.fields.warehouse')}
                error={errors.warehouseId}
                value={values.warehouseId}
                onChange={(warehouseId) => set('warehouseId', warehouseId)}
                options={warehouseChoices}
                placeholder={t('quotations.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-settlementCode`}
                label={t('quotations.fields.settlement')}
                error={errors.settlementCode}
                value={values.settlementCode}
                onChange={(settlementCode) => set('settlementCode', settlementCode)}
                options={choices(settlements)}
                placeholder={t('quotations.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-projectCode`}
                label={t('quotations.fields.project')}
                error={errors.projectCode}
                value={values.projectCode}
                onChange={(projectCode) => set('projectCode', projectCode)}
                options={choices(projects)}
                placeholder={t('quotations.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-handlerUserId`}
                label={t('quotations.fields.handler')}
                error={errors.handlerUserId}
                value={values.handlerUserId}
                onChange={(handlerUserId) => set('handlerUserId', handlerUserId)}
                options={handlerChoices}
                placeholder={t('quotations.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-customerOrderNo`} label={t('quotations.fields.customerOrderNo')}>
                <Input
                  id={`${formId}-customerOrderNo`}
                  autoComplete='off'
                  maxLength={64}
                  disabled={busy}
                  value={values.customerOrderNo}
                  onChange={(event) => set('customerOrderNo', event.target.value)}
                />
              </PageField>
              <PageField id={`${formId}-contactName`} label={t('quotations.fields.contactName')}>
                <Input
                  id={`${formId}-contactName`}
                  autoComplete='off'
                  maxLength={128}
                  disabled={busy}
                  value={values.contactName}
                  onChange={(event) => set('contactName', event.target.value)}
                />
              </PageField>
              <PageField id={`${formId}-contactPhone`} label={t('quotations.fields.contactPhone')}>
                <Input
                  id={`${formId}-contactPhone`}
                  autoComplete='off'
                  maxLength={64}
                  disabled={busy}
                  value={values.contactPhone}
                  onChange={(event) => set('contactPhone', event.target.value)}
                />
              </PageField>
              <PageField
                id={`${formId}-deliveryAddress`}
                label={t('quotations.fields.deliveryAddress')}
                className='sm:col-span-2'
              >
                <Input
                  id={`${formId}-deliveryAddress`}
                  autoComplete='off'
                  maxLength={512}
                  disabled={busy}
                  value={values.deliveryAddress}
                  onChange={(event) => set('deliveryAddress', event.target.value)}
                />
              </PageField>
              <PageField
                id={`${formId}-discountAmount`}
                label={t('quotations.fields.discountAmount')}
                error={discountError}
              >
                <Input
                  id={`${formId}-discountAmount`}
                  inputMode='decimal'
                  autoComplete='off'
                  aria-invalid={discountError ? true : undefined}
                  disabled={busy}
                  value={values.discountAmount}
                  onChange={(event) => set('discountAmount', event.target.value)}
                />
              </PageField>
            </FieldGroup>
          </DetailSection>
          <LinesEditor
            formId={formId}
            lines={values.lines}
            errors={errors}
            items={items}
            disabled={busy}
            onAdd={addLine}
            onChange={setLine}
            onRemove={removeLine}
          />
          <DetailSection title={t('quotations.totals')}>
            <QuotationTotals quotation={quotation ?? null} />
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={quotation?.files ?? []}
              ids={values.fileIds}
              disabled={busy}
              onChange={(fileIds) => set('fileIds', [...fileIds])}
            />
          </DetailSection>
          {leave.dialog}
        </FeedbackForm>
      </PageContainer>
    </RouteChildPage>
  );
}
