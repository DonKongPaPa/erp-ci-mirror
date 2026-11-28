import {
  ApiClientError,
  useApiClient,
  usePageBreadcrumb,
  useToaster,
} from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
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
import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText } from '#components/erp/messages';
import {
  dictChoices,
  personChoices,
  useDictEntries,
  usePersonOptions,
  type DictEntry,
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
import { Textarea } from '#components/ui/textarea';

import { useAncestorSearch } from '../../routing/route-context.js';
import { FinanceRequestsClient, type FinanceRequest } from './client.js';
import {
  AmountInput,
  PageField,
  SelectField,
  type Choice,
} from './fields.js';
import {
  createInputOf,
  emptyRequestForm,
  requestFieldErrors,
  requestFormOf,
  updateInputOf,
  validateRequestForm,
  type RequestFormValues,
} from './model.js';
import {
  FINANCE_REQUESTS_LIST_KEYS,
  FINANCE_REQUESTS_RESOURCE,
} from './page-id.js';
import { useFinanceRequest } from './record.js';

/**
 * 新建与编辑请款单 / 报销单（`/finance-requests/new`、`/finance-requests/:id/edit`）。
 * 一单一金额、一段事由、一组附件，没有明细行。经办人留空时端点默认登录人。
 * 只有草稿或已驳回能改。
 */
export default function RequestFormPage({
  editing,
}: {
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const id = editing ? (params.financeRequestId ?? '') : '';
  const client = useMemo(() => new FinanceRequestsClient(api), [api]);
  const view = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'view' });
  const create = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'create' });
  const update = useCan({ resource: FINANCE_REQUESTS_RESOURCE, action: 'update' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const record = useFinanceRequest(id, editing && view.can);
  const people = usePersonOptions(optionsView.can);
  const expenseTypes = useDictEntries('expense_type', dictView.can);
  const projects = useDictEntries('project', dictView.can);
  const request = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.financeRequests'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, FINANCE_REQUESTS_LIST_KEYS),
    },
  };
  const title = editing
    ? t('financeRequestDocs.editTitle')
    : t('financeRequestDocs.newTitle');
  const description = editing
    ? t('financeRequestDocs.editDescription', { docNo: request?.docNo ?? '' })
    : t('financeRequestDocs.newDescription');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: request?.docNo ?? t('financeRequestDocs.detailTitle') }, { label: title }]
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
  if (editing && request === undefined)
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
  if (
    request &&
    request.status !== 'draft' &&
    request.status !== 'rejected'
  )
    return (
      <FormShell title={title} description={description}>
        <Alert>
          <AlertDescription>{t('financeRequestDocs.form.notEditable')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <RequestForm
      key={request?.updatedAt}
      client={client}
      editing={editing}
      initial={request ? requestFormOf(request) : emptyRequestForm()}
      request={request}
      people={people.items}
      expenseTypes={expenseTypes.items}
      projects={projects.items}
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

interface RequestFormProps {
  readonly client: FinanceRequestsClient;
  readonly editing: boolean;
  readonly initial: RequestFormValues;
  readonly request: FinanceRequest | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly expenseTypes: readonly DictEntry[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly onNotEditable: () => void;
}

function RequestForm({
  client,
  editing,
  initial,
  request,
  people,
  expenseTypes,
  projects,
  onNotEditable,
}: RequestFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<RequestFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const set = <K extends keyof RequestFormValues>(
    key: K,
    value: RequestFormValues[K],
  ): void => {
    setValues((old) => ({ ...old, [key]: value }));
    setErrors((old) => (old[key] === undefined ? old : { ...old, [key]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateRequestForm(values, t);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved =
        editing && request
          ? await client.update(request.id, updateInputOf(values))
          : await client.create(createInputOf(values));
      toaster.show({
        type: 'success',
        title: editing
          ? t('financeRequestDocs.toasts.saved', { name: saved.docNo })
          : t('financeRequestDocs.toasts.created', { name: saved.docNo }),
      });
      await navigate(
        {
          pathname: `/finance-requests/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(requestFieldErrors(next));
      if (
        next instanceof ApiClientError &&
        next.reason === 'FINANCE_REQUEST_NOT_EDITABLE'
      )
        onNotEditable();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: editing && request ? `/finance-requests/${request.id}` : '/finance-requests',
        search: location.search,
      },
      { replace: true },
    );
  };

  const docTypeOpts: Choice[] = [
    {
      value: 'payment_request',
      label: t('financeRequestDocs.docTypes.payment_request'),
    },
    {
      value: 'expense_claim',
      label: t('financeRequestDocs.docTypes.expense_claim'),
    },
  ];
  const expenseTypeOpts: Choice[] = dictChoices(expenseTypes);
  const projectOpts: Choice[] = dictChoices(projects);
  const personOpts: Choice[] = personChoices(people);

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={editing ? t('financeRequestDocs.editTitle') : t('financeRequestDocs.newTitle')}
          description={
            editing
              ? t('financeRequestDocs.editDescription', { docNo: request?.docNo ?? '' })
              : t('financeRequestDocs.newDescription')
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy}>
                {t('financeRequestDocs.actions.saveDraft')}
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
          <DetailSection title={t('financeRequestDocs.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <SelectField
                id={`${formId}-docType`}
                label={t('financeRequestDocs.fields.docType')}
                required
                error={errors.docType}
                value={values.docType}
                onChange={(value) => set('docType', value)}
                options={docTypeOpts}
                placeholder={t('financeRequestDocs.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-requestDate`} label={t('financeRequestDocs.fields.requestDate')} required error={errors.requestDate}>
                <Input
                  id={`${formId}-requestDate`}
                  inputMode='numeric'
                  autoComplete='off'
                  disabled={busy}
                  value={values.requestDate}
                  onChange={(event) => set('requestDate', event.target.value)}
                />
              </PageField>
              <SelectField
                id={`${formId}-expenseTypeCode`}
                label={t('financeRequestDocs.fields.expenseType')}
                error={errors.expenseTypeCode}
                value={values.expenseTypeCode}
                onChange={(value) => set('expenseTypeCode', value)}
                options={expenseTypeOpts}
                placeholder={t('financeRequestDocs.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-amount`} label={t('financeRequestDocs.fields.amount')} required error={errors.amount}>
                <AmountInput
                  id={`${formId}-amount`}
                  value={values.amount}
                  onChange={(value) => set('amount', value)}
                  disabled={busy}
                />
              </PageField>
              <SelectField
                id={`${formId}-handlerUserId`}
                label={t('financeRequestDocs.fields.handler')}
                error={errors.handlerUserId}
                value={values.handlerUserId}
                onChange={(value) => set('handlerUserId', value)}
                options={personOpts}
                placeholder={t('financeRequestDocs.form.choose')}
                hint={t('financeRequestDocs.form.handlerHint')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-projectCode`}
                label={t('financeRequestDocs.fields.project')}
                error={errors.projectCode}
                value={values.projectCode}
                onChange={(value) => set('projectCode', value)}
                options={projectOpts}
                placeholder={t('financeRequestDocs.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-reason`} label={t('financeRequestDocs.fields.reason')} className='sm:col-span-2'>
                <Textarea
                  id={`${formId}-reason`}
                  placeholder={t('financeRequestDocs.form.reasonPlaceholder')}
                  disabled={busy}
                  value={values.reason}
                  onChange={(event) => set('reason', event.target.value)}
                />
              </PageField>
            </FieldGroup>
          </DetailSection>
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={request?.files ?? []}
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
