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
import type { FieldErrors } from '#components/erp/form-dialog';
import { errorText } from '#components/erp/messages';
import {
  departmentChoices,
  dictChoices,
  personChoices,
  useDepartmentOptions,
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
} from '../orders/reference.js';
import { LinesTable } from '#components/erp/document';
import { PurchaseRequestsClient, type PurchaseRequest } from './client.js';
import { CellField, Dash, NumberInput, PageField, SelectField } from './fields.js';
import {
  emptyRequestForm,
  newLine,
  requestFieldErrors,
  requestFormOf,
  requestInputOf,
  validateRequestForm,
  type LineDraft,
  type RequestFormValues,
} from './model.js';
import {
  PURCHASE_REQUESTS_LIST_KEYS,
  PURCHASE_REQUESTS_RESOURCE,
} from './page-id.js';
import { usePurchaseRequest } from './record.js';

/**
 * 新建与编辑请购单（`/purchase-requests/new`、`/purchase-requests/:id/edit`）。
 * 表头字段照旧系统「请购单」新建页的原字；明细录物品、请购数量、预计单价，
 * 预计金额与表尾合计由服务端算，页面只回显，不自己补价也不自己加总。
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
  const id = editing ? (params.purchaseRequestId ?? '') : '';
  const client = useMemo(() => new PurchaseRequestsClient(api), [api]);
  const view = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'view' });
  const create = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'create' });
  const update = useCan({ resource: PURCHASE_REQUESTS_RESOURCE, action: 'update' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const itemsView = useCan({
    resource: { type: 'composite', id: 'items' },
    action: 'view',
  });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const record = usePurchaseRequest(id, editing && view.can);
  const items = useReferencePage<Item>('items', itemsView.can);
  const departments = useDepartmentOptions(optionsView.can);
  const people = usePersonOptions(optionsView.can);
  const projects = useDictEntries('project', dictView.can);
  const request = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t('navigation.purchaseRequests'),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, PURCHASE_REQUESTS_LIST_KEYS),
    },
  };
  const title = editing
    ? t('purchaseRequests.editTitle')
    : t('purchaseRequests.newTitle');
  const description = editing
    ? t('purchaseRequests.editDescription', { docNo: request?.docNo ?? '' })
    : t('purchaseRequests.newDescription');
  usePageBreadcrumb(
    editing
      ? [listLevel, { label: request?.docNo ?? t('purchaseRequests.detailTitle') }, { label: title }]
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
          <AlertDescription>{t('purchaseRequests.form.notEditable')}</AlertDescription>
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
      items={items.items}
      departments={departments.items}
      people={people.items}
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
  readonly client: PurchaseRequestsClient;
  readonly editing: boolean;
  readonly initial: RequestFormValues;
  readonly request: PurchaseRequest | undefined;
  readonly items: readonly Item[] | undefined;
  readonly departments: readonly { id: string; name: string }[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly onNotEditable: () => void;
}

function RequestForm({
  client,
  editing,
  initial,
  request,
  items,
  departments,
  people,
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
  const setLine = (key: string, patch: Partial<LineDraft>): void => {
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  };
  const addLine = (): void => {
    setValues((old) => ({ ...old, lines: [...old.lines, newLine()] }));
  };
  const removeLine = (key: string): void => {
    setValues((old) => ({ ...old, lines: old.lines.filter((line) => line.key !== key) }));
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
      const { header, lines } = requestInputOf(values);
      const saved = editing && request
        ? await client.update(request.id, header)
        : await client.create(header);
      await client.setLines(saved.id, { lines, replace: true });
      toaster.show({
        type: 'success',
        title: editing
          ? t('purchaseRequests.toasts.saved', { name: saved.docNo })
          : t('purchaseRequests.toasts.created', { name: saved.docNo }),
      });
      await navigate(
        {
          pathname: `/purchase-requests/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(requestFieldErrors(next));
      if (
        next instanceof ApiClientError &&
        next.reason === 'PURCHASE_REQUEST_NOT_EDITABLE'
      )
        onNotEditable();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: editing && request ? `/purchase-requests/${request.id}` : '/purchase-requests',
        search: location.search,
      },
      { replace: true },
    );
  };

  const itemOpts = itemChoices(items ?? [], t('orderDocs.form.inactiveItem'));
  const deptOpts = departmentChoices(departments);
  const projectOpts = dictChoices(projects);

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={editing ? t('purchaseRequests.editTitle') : t('purchaseRequests.newTitle')}
          description={
            editing
              ? t('purchaseRequests.editDescription', { docNo: request?.docNo ?? '' })
              : t('purchaseRequests.newDescription')
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy}>
                {t('purchaseRequests.actions.saveDraft')}
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
          <DetailSection title={t('purchaseRequests.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <PageField id={`${formId}-requestDate`} label={t('purchaseRequests.fields.requestDate')} required error={errors.requestDate}>
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
                id={`${formId}-departmentId`}
                label={t('purchaseRequests.fields.department')}
                required
                error={errors.departmentId}
                value={values.departmentId}
                onChange={(value) => set('departmentId', value)}
                options={deptOpts}
                placeholder={t('purchaseRequests.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-requesterUserId`}
                label={t('purchaseRequests.fields.requester')}
                required
                error={errors.requesterUserId}
                value={values.requesterUserId}
                onChange={(value) => set('requesterUserId', value)}
                options={personChoices(people)}
                placeholder={t('purchaseRequests.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-projectCode`}
                label={t('purchaseRequests.fields.project')}
                error={errors.projectCode}
                value={values.projectCode}
                onChange={(value) => set('projectCode', value)}
                options={projectOpts}
                placeholder={t('purchaseRequests.form.choose')}
                disabled={busy}
              />
              <PageField id={`${formId}-customText1`} label={t('purchaseRequests.fields.customText1')}>
                <Input
                  id={`${formId}-customText1`}
                  autoComplete='off'
                  disabled={busy}
                  value={values.customText1}
                  onChange={(event) => set('customText1', event.target.value)}
                />
              </PageField>
              <PageField id={`${formId}-customText2`} label={t('purchaseRequests.fields.customText2')}>
                <Input
                  id={`${formId}-customText2`}
                  autoComplete='off'
                  disabled={busy}
                  value={values.customText2}
                  onChange={(event) => set('customText2', event.target.value)}
                />
              </PageField>
              <PageField id={`${formId}-description`} label={t('purchaseRequests.fields.description')} className='sm:col-span-2'>
                <Textarea
                  id={`${formId}-description`}
                  placeholder={t('purchaseRequests.form.descriptionPlaceholder')}
                  disabled={busy}
                  value={values.description}
                  onChange={(event) => set('description', event.target.value)}
                />
              </PageField>
            </FieldGroup>
          </DetailSection>
          <DetailSection title={t('purchaseRequests.fields.lines')}>
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
                  header: t('purchaseRequests.fields.item'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('purchaseRequests.fields.itemLine', { n: row.index + 1 });
                    return (
                      <CellField invalid={Boolean(errors[`item-${line.key}`])} error={errors[`item-${line.key}`]}>
                        <Select
                          items={itemOpts}
                          value={line.itemId || undefined}
                          onValueChange={(value) => setLine(line.key, { itemId: value ?? '' })}
                          disabled={busy}
                        >
                          <SelectTrigger aria-label={label}>
                            <SelectValue placeholder={t('purchaseRequests.form.choose')} />
                          </SelectTrigger>
                          <SelectContent>
                            {itemOpts.map((option) => (
                              <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
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
                  header: t('purchaseRequests.fields.qty'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('purchaseRequests.fields.qtyLine', { n: row.index + 1 });
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
                  id: 'expectedPrice',
                  header: t('purchaseRequests.fields.expectedPrice'),
                  cell: ({ row }) => {
                    const line = row.original;
                    const label = t('purchaseRequests.fields.expectedPriceLine', { n: row.index + 1 });
                    return (
                      <CellField invalid={Boolean(errors[`expectedPrice-${line.key}`])} error={errors[`expectedPrice-${line.key}`]}>
                        <NumberInput
                          id={`${formId}-price-${line.key}`}
                          label={label}
                          value={line.expectedPrice}
                          onChange={(value) => setLine(line.key, { expectedPrice: value })}
                          disabled={busy}
                        />
                      </CellField>
                    );
                  },
                },
                {
                  id: 'expectedAmount',
                  header: t('purchaseRequests.fields.expectedAmount'),
                  // 预计金额由服务端算；表单不推断，没保存的行没有这个值。
                  cell: () => <Dash />,
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
                      {t('purchaseRequests.actions.removeLine')}
                    </Button>
                  ),
                },
              ] as ColumnDef<LineDraft>[]}
              rows={values.lines}
              getRowId={(line) => line.key}
              emptyMessage={t('purchaseRequests.form.linesEmpty')}
            />
            <Button type='button' variant='outline' disabled={busy} onClick={addLine}>
              {t('purchaseRequests.actions.addLine')}
            </Button>
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
