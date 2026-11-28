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
import { OrdersClient, type Order } from './client.js';
import { useOrder } from './record.js';
import { PageField, SelectField } from './fields.js';
import { ORDER_LIST_KEYS, type OrderKindDef } from './kinds.js';
import { LinesEditor } from './lines-editor.js';
import {
  emptyOrderForm,
  newLine,
  orderFieldErrors,
  orderFormOf,
  orderInputOf,
  validateOrderForm,
  type LineDraft,
  type OrderFormValues,
} from './model.js';
import {
  useReferencePage,
  type Choice,
  type Item,
  type PartnerOption,
  type WarehouseOption,
} from './reference.js';

/**
 * 新建与编辑订单（`/purchase-orders/new`、`/purchase-orders/:id/edit`）：盖在列表上的子页
 * （《基座ERP前端设计》2.4）。波 0 加片把表头的仓库、联系人、交货地址、结算方式、项目、
 * 经办人、优惠金额与附件，明细的交期、税率、两套单价与行备注补齐。
 * 金额由服务端算，页面只录原始输入；没有 `viewPrice` 时不画价格与金额列。
 * 只有草稿能改：读出来已经不是草稿时只给一句说明，不画表单。
 */
export function OrderFormPage({
  def,
  editing,
}: {
  readonly def: OrderKindDef;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const params = useParams();
  const orderId = editing ? (params[def.param] ?? '') : '';
  const client = useMemo(() => new OrdersClient(api, def), [api, def]);
  const view = useCan({ resource: def.resource, action: 'view' });
  const create = useCan({ resource: def.resource, action: 'create' });
  const update = useCan({ resource: def.resource, action: 'update' });
  const allowed = editing ? update.can : create.can;
  const pending = editing
    ? update.isPending || view.isPending
    : create.isPending;
  const itemsView = useCan({
    resource: { type: 'composite', id: 'items' },
    action: 'view',
  });
  const partnerView = useCan({
    resource: def.partnerResource,
    action: 'view',
  });
  const warehouseView = useCan({
    resource: { type: 'composite', id: 'inventory' },
    action: 'warehouseView',
  });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const record = useOrder(def, orderId, editing && view.can);
  const items = useReferencePage<Item>('items', itemsView.can);
  const partners = useReferencePage<PartnerOption>(
    `partners?kind=${def.partnerKind}&status=active`,
    partnerView.can,
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
  const order = record.data;

  const owner = useResolvedPath(editing ? '../..' : '..').pathname;
  const listLevel = {
    label: t(`navigation.${def.l}`),
    to: {
      pathname: owner,
      search: useAncestorSearch(owner, ORDER_LIST_KEYS),
    },
  };
  const title = editing ? t(`${def.l}.editTitle`) : t(`${def.l}.newTitle`);
  // 面包屑：采购订单 › 单号 › 编辑采购订单；读不到时记录那一级用「采购订单详情」。
  usePageBreadcrumb(
    editing
      ? [
          listLevel,
          { label: order?.orderNo ?? t(`${def.l}.detailTitle`) },
          { label: title },
        ]
      : [listLevel, { label: title }],
  );
  const description = editing
    ? t(`${def.l}.editDescription`, { orderNo: order?.orderNo ?? '' })
    : t(`${def.l}.newDescription`);

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
  if (editing && order === undefined)
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
  // 已经提交的单不能再改（服务端也会拒，`ORDER_NOT_DRAFT`）。
  if (order && order.status !== 'draft')
    return (
      <FormShell title={title} description={description}>
        <Alert>
          <AlertDescription>{t('orderDocs.form.notDraft')}</AlertDescription>
        </Alert>
      </FormShell>
    );
  return (
    <OrderForm
      key={order?.updatedAt}
      def={def}
      client={client}
      initial={order ? orderFormOf(order) : emptyOrderForm()}
      order={order}
      items={items.items}
      partners={partners.items}
      warehouses={warehouses.items}
      settlements={settlements.items}
      projects={projects.items}
      people={people.items}
      defaultTaxRate={defaultTaxRate}
      onNotDraft={record.reload}
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

interface OrderFormProps {
  readonly def: OrderKindDef;
  readonly client: OrdersClient;
  readonly initial: OrderFormValues;
  /** 传了就是编辑。 */
  readonly order: Order | undefined;
  readonly items: readonly Item[] | undefined;
  readonly partners: readonly PartnerOption[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly settlements: readonly DictEntry[] | undefined;
  readonly projects: readonly DictEntry[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly defaultTaxRate: string;
  /** 保存时服务端说已经不是草稿：重新读一遍，这一页换成一句说明。 */
  readonly onNotDraft: () => void;
}

function OrderForm({
  def,
  client,
  initial,
  order,
  items,
  partners,
  warehouses,
  settlements,
  projects,
  people,
  defaultTaxRate,
  onNotDraft,
}: OrderFormProps): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const formId = useId();
  const [values, setValues] = useState<OrderFormValues>(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string>();
  // 提交校验没过时把光标落到第一项；带一个时间戳，连着提交两次也会再落一次。
  const [focus, setFocus] = useState<{
    readonly key: string;
    readonly at: number;
  }>();
  // 做了没保存就想离开（取消、面包屑、浏览器后退）会先问一句。
  const leave = usePageLeave(touched && !saved, busy);

  const set = <K extends keyof OrderFormValues>(
    key: K,
    value: OrderFormValues[K],
  ): void => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
    // 改了哪一项，就把哪一项下面的提示收掉。
    setErrors((old) =>
      old[key] === undefined ? old : { ...old, [key]: undefined },
    );
  };
  const setLine = (key: string, patch: Readonly<Partial<LineDraft>>): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line) =>
        line.key === key ? { ...line, ...patch } : line,
      ),
    }));
  };
  const addLine = (): void => {
    setTouched(true);
    setErrors((old) =>
      old.lines === undefined ? old : { ...old, lines: undefined },
    );
    setValues((old) => ({ ...old, lines: [...old.lines, newLine(defaultTaxRate)] }));
  };
  /** 删的是没保存的行，不是删记录；这一行下面的提示一起收掉。 */
  const removeLine = (key: string): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((line) => line.key !== key),
    }));
    setErrors((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([name]) => !name.endsWith(`-${key}`)),
      ),
    );
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`${formId}-${focus.key}`)?.focus();
  }, [focus, formId]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validateOrderForm(values, t(`${def.l}.partnerLabel`), t);
    setErrors(() => found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first !== undefined) {
      setFocus({ key: first, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const input = orderInputOf(values);
      const result = order
        ? await client.update(order.id, input)
        : await client.create(input);
      toaster.show({
        type: 'success',
        title: order
          ? t(`${def.l}.savedToast`, { name: result.orderNo })
          : t(`${def.l}.createdToast`, { name: result.orderNo }),
      });
      setSaved(true);
      // 保存成功了，离开这一页不再问「放弃未保存的更改」。
      leave.allow();
      // 新建的到这张单的页面；编辑的回到这张单。都带着列表的查询串。
      await navigate(
        order
          ? { pathname: '..', search: location.search }
          : {
              pathname: `${def.path}/${encodeURIComponent(result.id)}`,
              search: location.search,
            },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
      setErrors(orderFieldErrors(next));
      // 已经不是草稿了：重新读一遍，这一页换成一句说明。
      if (next instanceof ApiClientError && next.reason === 'ORDER_NOT_DRAFT')
        onNotDraft();
    } finally {
      setBusy(false);
    }
  };

  const leavePage = (): void => {
    void navigate(
      {
        pathname: order ? '..' : def.path,
        search: location.search,
      },
      { replace: true },
    );
  };
  // 往来单位下拉只查在用的；编辑一张引用了已停用单位的草稿时，详情摘要里还有编码与名称，
  // 把它补成不可选的一项，免得下拉只显示裸 UUID，同时保留「请先启用」的提示。
  const inactivePartner =
    order?.partner?.status === 'inactive' ? order.partner : undefined;
  const partnerChoices: Choice[] = (partners ?? []).map((partner) => ({
    value: partner.id,
    label: `${partner.code} ${partner.name}`,
  }));
  if (inactivePartner) {
    const active = partnerChoices.findIndex(
      (choice) => choice.value === inactivePartner.id,
    );
    if (active >= 0) partnerChoices.splice(active, 1);
    partnerChoices.unshift({
      value: inactivePartner.id,
      label: `${inactivePartner.code} ${inactivePartner.name}（${t('orderDocs.form.inactiveItem')}）`,
      disabled: true,
    });
  }
  const choices = (entries: readonly DictEntry[] | undefined): Choice[] =>
    dictChoices(entries);
  const warehouseChoices: Choice[] = (warehouses ?? []).map((one) => ({
    value: one.id,
    label: `${one.code} ${one.name}`,
    disabled: one.status !== 'active',
  }));
  const handlerChoices = personChoices(people);
  const dateError = errors.orderDate;
  const remarkError = errors.remark;

  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={order ? t(`${def.l}.editTitle`) : t(`${def.l}.newTitle`)}
          description={
            order
              ? t(`${def.l}.editDescription`, { orderNo: order.orderNo })
              : t(`${def.l}.newDescription`)
          }
          actions={
            <>
              <Button variant='outline' disabled={busy} onClick={leavePage}>
                {t('actions.cancel')}
              </Button>
              <PendingButton type='submit' form={formId} busy={busy} action='save'>
                {t('orderDocs.actions.saveDraft')}
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
          <DetailSection title={t('orderDocs.form.header')}>
            <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
              <SelectField
                id={`${formId}-partnerId`}
                label={t(`${def.l}.partnerLabel`)}
                required
                error={errors.partnerId}
                value={values.partnerId}
                onChange={(partnerId) => set('partnerId', partnerId)}
                options={partnerChoices}
                placeholder={t('orderDocs.form.choose')}
                hint={
                  inactivePartner
                    ? t('orders.errors.partnerInactive')
                    : undefined
                }
                disabled={busy}
              />
              <PageField
                id={`${formId}-orderDate`}
                label={t('orderDocs.fields.orderDate')}
                required
                error={dateError}
                hint={t('orderDocs.form.dateHint')}
              >
                <Input
                  id={`${formId}-orderDate`}
                  inputMode='numeric'
                  autoComplete='off'
                  aria-invalid={dateError ? true : undefined}
                  disabled={busy}
                  value={values.orderDate}
                  onChange={(event) => set('orderDate', event.target.value)}
                />
              </PageField>
              <SelectField
                id={`${formId}-warehouseId`}
                label={t('orderDocs.fields.warehouse')}
                error={errors.warehouseId}
                value={values.warehouseId}
                onChange={(warehouseId) => set('warehouseId', warehouseId)}
                options={warehouseChoices}
                placeholder={t('orderDocs.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-settlementCode`}
                label={t('orderDocs.fields.settlement')}
                error={errors.settlementCode}
                value={values.settlementCode}
                onChange={(settlementCode) => set('settlementCode', settlementCode)}
                options={choices(settlements)}
                placeholder={t('orderDocs.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-projectCode`}
                label={t('orderDocs.fields.project')}
                error={errors.projectCode}
                value={values.projectCode}
                onChange={(projectCode) => set('projectCode', projectCode)}
                options={choices(projects)}
                placeholder={t('orderDocs.form.choose')}
                disabled={busy}
              />
              <SelectField
                id={`${formId}-handlerUserId`}
                label={t(`${def.l}.handlerLabel`)}
                error={errors.handlerUserId}
                value={values.handlerUserId}
                onChange={(handlerUserId) => set('handlerUserId', handlerUserId)}
                options={handlerChoices}
                placeholder={t('orderDocs.form.choose')}
                disabled={busy}
              />
              <PageField
                id={`${formId}-contactName`}
                label={t('orderDocs.fields.contactName')}
              >
                <Input
                  id={`${formId}-contactName`}
                  autoComplete='off'
                  maxLength={128}
                  disabled={busy}
                  value={values.contactName}
                  onChange={(event) => set('contactName', event.target.value)}
                />
              </PageField>
              <PageField
                id={`${formId}-contactPhone`}
                label={t('orderDocs.fields.contactPhone')}
              >
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
                label={t(`${def.l}.deliveryAddress`)}
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
              {def.id === 'sales' ? (
                <PageField
                  id={`${formId}-customerOrderNo`}
                  label={t('orderDocs.fields.customerOrderNo')}
                >
                  <Input
                    id={`${formId}-customerOrderNo`}
                    autoComplete='off'
                    maxLength={64}
                    disabled={busy}
                    value={values.customerOrderNo}
                    onChange={(event) => set('customerOrderNo', event.target.value)}
                  />
                </PageField>
              ) : null}
              <PageField
                id={`${formId}-discountAmount`}
                label={t('orderDocs.fields.discountAmount')}
                error={errors.discountAmount}
              >
                <Input
                  id={`${formId}-discountAmount`}
                  inputMode='decimal'
                  autoComplete='off'
                  aria-invalid={errors.discountAmount ? true : undefined}
                  disabled={busy}
                  value={values.discountAmount}
                  onChange={(event) => set('discountAmount', event.target.value)}
                />
              </PageField>
              <PageField
                id={`${formId}-remark`}
                label={t('erp.fields.note')}
                error={remarkError}
                className='sm:col-span-2'
              >
                <Textarea
                  id={`${formId}-remark`}
                  rows={2}
                  aria-invalid={remarkError ? true : undefined}
                  disabled={busy}
                  value={values.remark}
                  onChange={(event) => set('remark', event.target.value)}
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
          <DetailSection title={t('erp.docFiles.title')}>
            <DocFilesPanel
              files={order?.files ?? []}
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
