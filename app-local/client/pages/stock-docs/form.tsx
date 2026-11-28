import { useApiClient, usePageBreadcrumb, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { PlusIcon, XIcon } from 'lucide-react';
import {
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
  useOutletContext,
  useParams,
} from 'react-router';

import {
  DocumentPage,
  DocumentSection,
  DocumentStatusBar,
} from '#components/erp/document';
import { DocFilesPanel } from '#components/erp/doc-files-panel';
import { errorText } from '#components/erp/messages';
import {
  defaultDictCode,
  departmentChoices,
  dictChoices,
  personChoiceFrom,
  personChoices,
  useDepartmentOptions,
  withKnownChoices,
  useDictEntries,
  usePersonOptions,
  type DictEntry,
  type DepartmentOption,
  type PersonOption,
} from '#components/erp/options';
import type { FieldErrors } from '#components/erp/form-dialog';
import { useRecord } from '#components/erp/record';
import { FeedbackForm } from '#components/feedback-form';
import { PendingButton } from '#components/pending-button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '#components/ui/field';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Textarea } from '#components/ui/textarea';
import { cn } from 'cn';

import { usePageLeave } from '../../routing/route-leave-boundary.js';
import { formatQty } from '../stock/format.js';
import {
  ITEMS_RESOURCE,
  itemLabel,
  useInventoryLookup,
} from '../stock/lookup.js';
import { INVENTORY_RESOURCE } from '../warehouses/page-id.js';

import type { NarrowOrder } from '../orders/client.js';
import {
  PURCHASE,
  SALES,
} from '../orders/kinds.js';
import type { ReceivableInspection } from '../inspections/client.js';
import { INSPECTIONS_RESOURCE } from '../inspections/page-id.js';
import { StockDocsClient, type StockDoc } from './client.js';
import { InspectionPickerDialog } from './inspection-picker.js';
import { OrderPickerDialog } from './order-picker.js';
import type { StockKind } from './kind.js';
import type { StockDocDetailContext } from './detail.js';
import { stockKey, useLineStock } from './line-stock.js';
import {
  emptyForm,
  emptyLine,
  formOf,
  inputOf,
  validateDocForm,
  type DocFormValues,
  type LineFormValues,
} from './model.js';

const NONE = '__none__';
const NUMBER = 'flex justify-end tabular-nums';
const DASH = <span className='text-muted-foreground'>—</span>;

/**
 * 新建、编辑一张入库单或出库单（`…/new`、`…/:docId/edit`）：盖在列表（或单据）上的子页。
 * 表头是类型与备注，明细整张表可填，能加行、删行（删的是没保存的行）。保存后是草稿，不动库存。
 * 建与改草稿要 inventory.stockWrite；只有草稿能改。
 */
export function StockDocFormPage({
  def,
  mode,
}: {
  readonly def: StockKind;
  readonly mode: 'new' | 'edit';
}): ReactElement {
  const { docId = '' } = useParams();
  const { t } = useTranslation();
  const view = useCan({ resource: INVENTORY_RESOURCE, action: 'stockView' });
  const write = useCan({ resource: INVENTORY_RESOURCE, action: 'stockWrite' });
  const itemView = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const warehouseView = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseView',
  });
  const priceView = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'stockPriceView',
  });
  const dictView = useCan({
    resource: { type: 'composite', id: 'bizDict' },
    action: 'view',
  });
  const optionsView = useCan({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  const pickView = useCan({
    resource: def.kind === 'in' ? PURCHASE.resource : SALES.resource,
    action: def.kind === 'in' ? 'receive' : 'ship',
  });
  // R-070：仓管在采购入库单上从检验单选择，只读窄形状，不给检验页与写动作。
  const inspectionView = useCan({
    resource: INSPECTIONS_RESOURCE,
    action: 'receiveView',
  });
  const projects = useDictEntries('project', dictView.can);
  const taxRates = useDictEntries('tax_rate', dictView.can);
  const people = usePersonOptions(optionsView.can);
  const departments = useDepartmentOptions(optionsView.can);
  const defaultTaxRate = defaultDictCode(taxRates.items);
  const canWrite = write.can;
  const editing = mode === 'edit';
  const record = useRecord<StockDoc>(
    `stock-docs/${encodeURIComponent(docId)}`,
    editing && view.can,
  );
  // 另一个方向的单据当作不存在。
  const doc = record.data?.docType === def.kind ? record.data : undefined;
  // 选物料要 items.view，选仓库要 warehouseView：缺一个就选不了明细。
  const canPick = itemView.can && warehouseView.can;
  const lookup = useInventoryLookup({
    items: canWrite && itemView.can,
    warehouses: canWrite && warehouseView.can,
  });

  // 面包屑：列表 › 单号 › 编辑。单号那一层由详情页交下来；没有它时用路由上的静态标题。
  const parent = useOutletContext<StockDocDetailContext | null>();
  const title = t(
    editing ? `stockDocs.${def.words}.editTitle` : `stockDocs.${def.words}.newTitle`,
  );
  const levels = useMemo(
    () => (parent ? [...parent.levels, { label: title }] : null),
    [parent, title],
  );
  usePageBreadcrumb(levels);

  const note = (message: ReactNode): ReactElement => (
    <DocumentPage
      title={title}
      status={
        <DocumentStatusBar tone='destructive'>{message}</DocumentStatusBar>
      }
    >
      {null}
    </DocumentPage>
  );
  if (write.isPending || (editing && (view.isPending || !doc)))
    return (
      <DocumentPage
        title={title}
        status={
          <DocumentStatusBar>
            {!write.isPending && !write.can
              ? t('erp.form.noWrite')
              : t('status.loading')}
          </DocumentStatusBar>
        }
      >
        {null}
      </DocumentPage>
    );
  if (!canWrite) return note(t('erp.form.noWrite'));
  if (editing && record.error !== undefined)
    return note(errorText(record.error, t));
  if (editing && !doc) return note(t('status.loading'));
  if (editing && doc?.status !== 'draft')
    // 已过账、已作废的单据没有改的入口：说明一句，不画表单。
    return note(t('inventory.errors.docNotDraft'));

  return (
    <StockDocForm
      key={doc?.updatedAt ?? 'new'}
      def={def}
      doc={doc}
      title={title}
      lookup={lookup}
      canPick={canPick}
      priceView={priceView.can}
      canPickOrder={pickView.can}
      canPickInspection={inspectionView.can}
      projects={projects.items}
      people={people.items}
      departments={departments.items}
      defaultTaxRate={defaultTaxRate}
    />
  );
}

interface StockDocFormProps {
  readonly def: StockKind;
  /** 编辑时的那一张；新建时没有。 */
  readonly doc: StockDoc | undefined;
  readonly title: string;
  readonly lookup: ReturnType<typeof useInventoryLookup>;
  readonly canPick: boolean;
  readonly priceView: boolean;
  readonly canPickOrder: boolean;
  readonly canPickInspection: boolean;
  readonly projects: readonly DictEntry[] | undefined;
  readonly people: readonly PersonOption[] | undefined;
  readonly departments: readonly DepartmentOption[] | undefined;
  readonly defaultTaxRate: string;
}

function StockDocForm({
  def,
  doc,
  title,
  lookup,
  canPick,
  priceView,
  canPickOrder,
  canPickInspection,
  projects,
  people,
  departments,
  defaultTaxRate,
}: StockDocFormProps): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useMemo(() => new StockDocsClient(api), [api]);
  const formId = useId();
  const initial = useMemo(
    () => (doc ? formOf(doc) : emptyForm(def.manualReason)),
    [doc, def.manualReason],
  );
  const [values, setValues] = useState<DocFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  // 和订单编辑同一套离开守卫：保存成功后先把这一份标成已保存，再去详情，不再问「放弃修改」。
  const leave = usePageLeave(touched && !saved, busy);
  // 出库单的每一行旁边带现存量：填的数量超过它就标红（过账时以服务端的判断为准）。
  const hand = useLineStock(values.lines, def.kind === 'out' && canPick);
  // 选项只回在职员工与在用部门；老单据上已存过的标识用详情里的摘要补成不可选项，
  // 免得控件把裸标识画出来。职务没变的人仍在选项里，这里不会重复。
  const personItems = withKnownChoices(personChoices(people), [
    personChoiceFrom(doc?.handler),
    personChoiceFrom(doc?.taker),
  ]);
  const departmentItems = withKnownChoices(departmentChoices(departments), [
    doc?.takerDepartmentId
      ? {
          value: doc.takerDepartmentId,
          label: doc.takerDepartment?.name ?? doc.takerDepartmentId,
        }
      : undefined,
  ]);
  const selectable = {
    people: new Set(personChoices(people).map((choice) => choice.value)),
    departments: new Set(departmentChoices(departments).map((choice) => choice.value)),
  };

  const setHeader = (key: keyof DocFormValues, value: string | readonly string[]) => {
    setTouched(true);
    setValues((old) => ({ ...old, [key]: value }));
  };
  const setLine = (index: number, key: keyof LineFormValues, value: string) => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.map((line, at) =>
        at === index ? { ...line, [key]: value } : line,
      ),
    }));
    // 改了哪一项，就把哪一项下面的提示收掉。
    setErrors((old) =>
      old[`line.${index}.${key}`] === undefined
        ? old
        : { ...old, [`line.${index}.${key}`]: undefined },
    );
  };
  const addLine = () => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: [...old.lines, { ...emptyLine(), taxRate: defaultTaxRate }],
    }));
  };
  const [picking, setPicking] = useState(false);
  const [pickingInspection, setPickingInspection] = useState(false);
  /** 从待收、待发的订单里选一张：带出仍有剩余的行、对方与联系方式，并记下来源。 */
  const applyOrder = (order: NarrowOrder): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      partnerId: order.supplier?.id ?? order.customer?.id ?? old.partnerId,
      contactName: order.contactName ?? old.contactName,
      contactPhone: order.contactPhone ?? old.contactPhone,
      sourceType: def.kind === 'in' ? 'purchase_order' : 'sales_order',
      sourceId: order.id,
      // 换来源就丢掉检验单，普通订单入库的请求体没有检验键。
      inspectionId: '',
      hasAddons: true,
      lines: order.lines
        .filter((line) => line.remainingQty > 0)
        .map((line) => ({
          ...emptyLine(),
          itemId: line.itemId,
          warehouseId: order.warehouseId ?? '',
          qty: String(line.remainingQty),
          taxRate: defaultTaxRate,
        })),
    }));
  };
  /**
   * R-070：从已通过/部分合格的检验单选可入库行。默认把尚可入库数量填进数量，
   * 并记录检验单 id 与检验行 id；供应商与采购订单由检验单带出，数量允许改小。
   */
  const applyInspection = (inspection: ReceivableInspection): void => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      sourceType: 'purchase_order',
      sourceId: inspection.purchaseOrderId,
      inspectionId: inspection.id,
      hasAddons: true,
      lines: inspection.lines
        .filter((line) => line.remainQty > 0)
        .map((line) => ({
          ...emptyLine(),
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          batchNo: line.batchNo,
          qty: String(line.remainQty),
          inspectionLineId: line.inspectionLineId,
          taxRate: defaultTaxRate,
        })),
    }));
  };
  /** 删的是没保存的这一行，不是删记录：保存时整单替换明细。 */
  const removeLine = (index: number) => {
    setTouched(true);
    setValues((old) => ({
      ...old,
      lines: old.lines.filter((_, at) => at !== index),
    }));
    setErrors((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => !key.startsWith(`line.${index}.`)),
      ),
    );
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || !canPick) return;
    const found = validateDocForm(values, t);
    setErrors(() => found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first !== undefined) {
      document.getElementById(`${formId}-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const body = inputOf(values, selectable);
      const saved =
        doc === undefined
          ? await client.create({ docType: def.kind, ...body })
          : await client.update(doc.id, body);
      toaster.show({ type: 'success', title: t('stockDocs.savedToast') });
      setSaved(true);
      // 先放行这一次的离开，再导航；否则表单还认为有未保存的更改。
      leave.allow();
      // 保存成功：到这张单的页面，地址栏里列表的搜索与筛选带过去。
      await navigate(
        {
          pathname: `${def.base}/${encodeURIComponent(saved.id)}`,
          search: location.search,
        },
        { replace: true },
      );
    } catch (next) {
      setError(errorText(next, t));
    } finally {
      setBusy(false);
    }
  };

  // 已保存的行可能引用着停用的物料或仓库：留在清单里，这一行才显示得出名字。
  const activeItems = lookup.items.filter((item) => item.status === 'active');
  const usedItems = values.lines.flatMap((line) => {
    const item = lookup.item(line.itemId);
    return item && item.status !== 'active' ? [item] : [];
  });
  const itemOptions = [...new Map([...usedItems, ...activeItems].map((item) => [item.id, item])).values()].map(
    (item) => ({ value: item.id, label: itemLabel(item) }),
  );
  const activeWarehouses = lookup.warehouses.filter((one) => one.status === 'active');
  const usedWarehouses = values.lines.flatMap((line) => {
    const one = lookup.warehouse(line.warehouseId);
    return one && one.status !== 'active' ? [one] : [];
  });
  const warehouseOptions = [
    ...new Map([...usedWarehouses, ...activeWarehouses].map((one) => [one.id, one])).values(),
  ].map((one) => ({ value: one.id, label: one.name }));
  const reasonOptions = def.reasons.map((reason) => ({
    value: reason,
    label: t(`stockDocs.reasons.${reason}`),
  }));
  const idOf = (key: string): string => `${formId}-${key}`;
  const showHand = def.kind === 'out';
  const closeTo = doc
    ? { pathname: `${def.base}/${encodeURIComponent(doc.id)}`, search: location.search }
    : { pathname: def.base, search: location.search };

  return (
    <DocumentPage
      title={title}
      status={
        error ? (
          <DocumentStatusBar tone='destructive'>
            <span role='alert'>{error}</span>
          </DocumentStatusBar>
        ) : (
          <DocumentStatusBar>
            {doc
              ? t('stockDocs.editDescription', { docNo: doc.docNo })
              : t(`stockDocs.${def.words}.formDescription`)}
          </DocumentStatusBar>
        )
      }
      actions={
        <>
          <Button
            variant='outline'
            disabled={busy}
            onClick={() => void navigate(closeTo, { replace: true })}
          >
            {t('stockDocs.cancel')}
          </Button>
          <PendingButton
            type='submit'
            form={formId}
            busy={busy}
            action='save'
            disabled={!canPick}
          >
            {t('stockDocs.saveDraft')}
          </PendingButton>
        </>
      }
    >
      <FeedbackForm
        id={formId}
        onSubmit={(event) => void onSubmit(event)}
        values={() => values}
        savedValues={initial}
        className='flex flex-col gap-6'
      >
        {!canPick ? (
          <Alert variant='destructive'>
            <AlertDescription>{t('stockDocs.lookupDenied')}</AlertDescription>
          </Alert>
        ) : null}
        <DocumentSection title={t('stockDocs.header')}>
          <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
            <DocField
              id={idOf('reason')}
              label={t('stockDocs.fields.reason')}
              required
              error={errors.reason}
            >
              <Select
                items={reasonOptions}
                value={values.reason}
                onValueChange={(next) => {
                  setTouched(true);
                  setValues((old) => ({ ...old, reason: String(next) as DocFormValues['reason'] }));
                }}
              >
                <SelectTrigger id={idOf('reason')} className='w-full' aria-invalid={Boolean(errors.reason)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reasonOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DocField>
            <DocField
              id={idOf('docDate')}
              label={t(`stockDocs.${def.words}.docDate`)}
            >
              <Input
                id={idOf('docDate')}
                inputMode='numeric'
                autoComplete='off'
                placeholder='YYYY-MM-DD'
                value={values.docDate}
                onChange={(event) => setHeader('docDate', event.target.value)}
              />
            </DocField>
            <DocField
              id={idOf('partnerId')}
              label={t(`stockDocs.${def.words}.partner`)}
            >
              <Input
                id={idOf('partnerId')}
                autoComplete='off'
                placeholder={t('stockDocs.partnerHint')}
                value={values.partnerId}
                onChange={(event) => setHeader('partnerId', event.target.value)}
              />
            </DocField>
            <DocField
              id={idOf('contactName')}
              label={t('stockDocs.fields.contactName')}
            >
              <Input
                id={idOf('contactName')}
                autoComplete='off'
                maxLength={128}
                value={values.contactName}
                onChange={(event) => setHeader('contactName', event.target.value)}
              />
            </DocField>
            <DocField
              id={idOf('contactPhone')}
              label={t('stockDocs.fields.contactPhone')}
            >
              <Input
                id={idOf('contactPhone')}
                autoComplete='off'
                maxLength={64}
                value={values.contactPhone}
                onChange={(event) => setHeader('contactPhone', event.target.value)}
              />
            </DocField>
            <DocField
              id={idOf('deliveryAddress')}
              label={t('stockDocs.fields.deliveryAddress')}
              className='sm:col-span-2 xl:col-span-1'
            >
              <Input
                id={idOf('deliveryAddress')}
                autoComplete='off'
                maxLength={512}
                value={values.deliveryAddress}
                onChange={(event) => setHeader('deliveryAddress', event.target.value)}
              />
            </DocField>
            {def.kind === 'out' ? (
              <DocField
                id={idOf('customerOrderNo')}
                label={t('stockDocs.fields.customerOrderNo')}
              >
                <Input
                  id={idOf('customerOrderNo')}
                  autoComplete='off'
                  maxLength={64}
                  value={values.customerOrderNo}
                  onChange={(event) => setHeader('customerOrderNo', event.target.value)}
                />
              </DocField>
            ) : null}
            <DocField
              id={idOf('projectCode')}
              label={t('stockDocs.fields.project')}
            >
              <Select
                items={dictChoices(projects)}
                value={values.projectCode || null}
                onValueChange={(next) => setHeader('projectCode', next ?? '')}
              >
                <SelectTrigger id={idOf('projectCode')} className='w-full'>
                  <SelectValue placeholder={t('orderDocs.form.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {dictChoices(projects).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DocField>
            <DocField
              id={idOf('handlerUserId')}
              label={t('stockDocs.fields.handler')}
            >
              <Select
                items={personItems}
                value={values.handlerUserId || null}
                onValueChange={(next) => setHeader('handlerUserId', next ?? '')}
              >
                <SelectTrigger id={idOf('handlerUserId')} className='w-full'>
                  <SelectValue placeholder={t('orderDocs.form.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {personItems.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DocField>
            {values.reason === 'internal_use' ? (
              <>
                <DocField
                  id={idOf('takerDepartmentId')}
                  label={t('stockDocs.fields.takerDepartment')}
                  required
                  error={errors.takerDepartmentId}
                >
                  <Select
                    items={departmentItems}
                    value={values.takerDepartmentId || null}
                    onValueChange={(next) => setHeader('takerDepartmentId', next ?? '')}
                  >
                    <SelectTrigger
                      id={idOf('takerDepartmentId')}
                      className='w-full'
                      aria-invalid={Boolean(errors.takerDepartmentId)}
                    >
                      <SelectValue placeholder={t('orderDocs.form.choose')} />
                    </SelectTrigger>
                    <SelectContent>
                      {departmentItems.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DocField>
                <DocField
                  id={idOf('takerUserId')}
                  label={t('stockDocs.fields.taker')}
                  required
                  error={errors.takerUserId}
                >
                  <Select
                    items={personItems}
                    value={values.takerUserId || null}
                    onValueChange={(next) => setHeader('takerUserId', next ?? '')}
                  >
                    <SelectTrigger
                      id={idOf('takerUserId')}
                      className='w-full'
                      aria-invalid={Boolean(errors.takerUserId)}
                    >
                      <SelectValue placeholder={t('orderDocs.form.choose')} />
                    </SelectTrigger>
                    <SelectContent>
                      {personItems.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DocField>
              </>
            ) : null}
            <DocField
              id={idOf('discountAmount')}
              label={t('orderDocs.fields.discountAmount')}
              error={errors.discountAmount}
            >
              <Input
                id={idOf('discountAmount')}
                inputMode='decimal'
                autoComplete='off'
                aria-invalid={Boolean(errors.discountAmount)}
                value={values.discountAmount}
                onChange={(event) => setHeader('discountAmount', event.target.value)}
              />
            </DocField>
            <Field>
              <FieldLabel>{t('stockDocs.fields.source')}</FieldLabel>
              {/* 来源由订单那一头生成时才有，这里不改。 */}
              <div className='flex min-h-8 items-center rounded-lg border border-border bg-muted/50 px-2.5 text-sm'>
                {values.sourceType
                  ? t(`stockDocs.source.${values.sourceType}`)
                  : t('stockDocs.source.manual')}
              </div>
            </Field>
            <DocField
              id={idOf('remark')}
              label={t('erp.fields.note')}
              error={errors.remark}
              className='sm:col-span-2 xl:col-span-1'
            >
              <Textarea
                id={idOf('remark')}
                maxLength={1000}
                aria-invalid={Boolean(errors.remark)}
                value={values.remark}
                onChange={(event) => {
                  setTouched(true);
                  setValues((old) => ({ ...old, remark: event.target.value }));
                }}
              />
            </DocField>
          </div>
        </DocumentSection>
        <DocumentSection title={t('stockDocs.lines')}>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <p className='text-sm text-muted-foreground'>
              {t('stockDocs.lineCount', { lines: values.lines.length })}
            </p>
            <div className='flex flex-wrap gap-2'>
              {canPickOrder ? (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setPicking(true)}
                >
                  {t(
                    def.kind === 'in'
                      ? 'stockDocs.pickPurchaseOrder'
                      : 'stockDocs.pickSalesOrder',
                  )}
                </Button>
              ) : null}
              {def.kind === 'in' &&
              values.reason === 'purchase_receipt' &&
              canPickInspection ? (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setPickingInspection(true)}
                >
                  {t('stockDocs.pickInspection')}
                </Button>
              ) : null}
            </div>
          </div>
          {errors.lines ? (
            <p role='alert' className='text-sm text-destructive'>
              {errors.lines}
            </p>
          ) : null}
          <div className='overflow-x-auto rounded-lg border border-border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-12'>#</TableHead>
                  <TableHead>
                    {t('stockDocs.columns.item')}
                    <span aria-hidden='true' className='text-destructive'>
                      *
                    </span>
                  </TableHead>
                  <TableHead>
                    {t('stockDocs.columns.warehouse')}
                    <span aria-hidden='true' className='text-destructive'>
                      *
                    </span>
                  </TableHead>
                  <TableHead>{t('stockDocs.columns.batch')}</TableHead>
                  {priceView ? (
                    <>
                      <TableHead>{t('stockDocs.columns.taxIncludedPrice')}</TableHead>
                      <TableHead>{t('stockDocs.columns.taxExcludedPrice')}</TableHead>
                    </>
                  ) : null}
                  <TableHead>{t('stockDocs.columns.unit')}</TableHead>
                  <TableHead className='text-right'>
                    {t('stockDocs.columns.qty')}
                    <span aria-hidden='true' className='text-destructive'>
                      *
                    </span>
                  </TableHead>
                  <TableHead>{t('stockDocs.columns.taxRate')}</TableHead>
                  <TableHead>{t('stockDocs.columns.productionDate')}</TableHead>
                  <TableHead>{t('stockDocs.columns.expiryDate')}</TableHead>
                  <TableHead>{t('erp.fields.note')}</TableHead>
                  {showHand ? (
                    <TableHead className='text-right'>
                      {t('stockDocs.columns.onHand')}
                    </TableHead>
                  ) : null}
                  <TableHead className='w-12'>
                    <span className='sr-only'>{t('erp.fields.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {values.lines.map((line, index) => {
                  const row = index + 1;
                  const prefix = `line.${index}.`;
                  const item = lookup.item(line.itemId);
                  const stock =
                    showHand && line.itemId && line.warehouseId
                      ? hand.stock?.[stockKey({ ...line, batchNo: line.batchNo.trim() })]
                      : undefined;
                  const qty = Number(line.qty);
                  return (
                    <TableRow key={line.key}>
                      <TableCell className='text-muted-foreground tabular-nums'>
                        {row}
                      </TableCell>
                      <TableCell>
                        <LineSelect
                          id={idOf(`${prefix}itemId`)}
                          label={t('stockDocs.lineItem', { row })}
                          placeholder={t('stockDocs.pickItem')}
                          value={line.itemId}
                          options={itemOptions}
                          invalid={Boolean(errors[`${prefix}itemId`])}
                          disabled={!canPick}
                          onChange={(value) => setLine(index, 'itemId', value)}
                        />
                        <LineError message={errors[`${prefix}itemId`]} />
                      </TableCell>
                      <TableCell>
                        <LineSelect
                          id={idOf(`${prefix}warehouseId`)}
                          label={t('stockDocs.lineWarehouse', { row })}
                          placeholder={t('stockDocs.pickWarehouse')}
                          value={line.warehouseId}
                          options={warehouseOptions}
                          invalid={Boolean(errors[`${prefix}warehouseId`])}
                          disabled={!canPick}
                          onChange={(value) => setLine(index, 'warehouseId', value)}
                        />
                        <LineError message={errors[`${prefix}warehouseId`]} />
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}batchNo`)}
                          maxLength={64}
                          aria-label={t('stockDocs.lineBatch', { row })}
                          aria-invalid={Boolean(errors[`${prefix}batchNo`])}
                          placeholder={t('stockDocs.batchPlaceholder')}
                          value={line.batchNo}
                          onChange={(event) =>
                            setLine(index, 'batchNo', event.target.value)
                          }
                        />
                        <LineError message={errors[`${prefix}batchNo`]} />
                      </TableCell>
                      {priceView ? (
                        <>
                          <TableCell>
                            <Input
                              id={idOf(`${prefix}taxIncludedPrice`)}
                              inputMode='decimal'
                              className={cn(NUMBER)}
                              aria-label={t('stockDocs.lineTaxIncludedPrice', { row })}
                              aria-invalid={Boolean(errors[`${prefix}taxIncludedPrice`])}
                              value={line.taxIncludedPrice}
                              onChange={(event) =>
                                setLine(index, 'taxIncludedPrice', event.target.value)
                              }
                            />
                            <LineError message={errors[`${prefix}taxIncludedPrice`]} />
                          </TableCell>
                          <TableCell>
                            <Input
                              id={idOf(`${prefix}taxExcludedPrice`)}
                              inputMode='decimal'
                              className={cn(NUMBER)}
                              aria-label={t('stockDocs.lineTaxExcludedPrice', { row })}
                              aria-invalid={Boolean(errors[`${prefix}taxExcludedPrice`])}
                              value={line.taxExcludedPrice}
                              onChange={(event) =>
                                setLine(index, 'taxExcludedPrice', event.target.value)
                              }
                            />
                            <LineError message={errors[`${prefix}taxExcludedPrice`]} />
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell className='text-muted-foreground'>
                        {item?.unitCode || DASH}
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}qty`)}
                          inputMode='decimal'
                          className={cn('w-28 text-right', NUMBER)}
                          aria-label={t('stockDocs.lineQty', { row })}
                          aria-invalid={Boolean(errors[`${prefix}qty`])}
                          value={line.qty}
                          onChange={(event) => setLine(index, 'qty', event.target.value)}
                        />
                        <LineError message={errors[`${prefix}qty`]} />
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}taxRate`)}
                          inputMode='decimal'
                          className={cn(NUMBER)}
                          aria-label={t('stockDocs.lineTaxRate', { row })}
                          aria-invalid={Boolean(errors[`${prefix}taxRate`])}
                          value={line.taxRate}
                          onChange={(event) => setLine(index, 'taxRate', event.target.value)}
                        />
                        <LineError message={errors[`${prefix}taxRate`]} />
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}productionDate`)}
                          inputMode='numeric'
                          placeholder='YYYY-MM-DD'
                          aria-label={t('stockDocs.lineProductionDate', { row })}
                          aria-invalid={Boolean(errors[`${prefix}productionDate`])}
                          value={line.productionDate}
                          onChange={(event) =>
                            setLine(index, 'productionDate', event.target.value)
                          }
                        />
                        <LineError message={errors[`${prefix}productionDate`]} />
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}expiryDate`)}
                          inputMode='numeric'
                          placeholder='YYYY-MM-DD'
                          aria-label={t('stockDocs.lineExpiryDate', { row })}
                          aria-invalid={Boolean(errors[`${prefix}expiryDate`])}
                          value={line.expiryDate}
                          onChange={(event) => setLine(index, 'expiryDate', event.target.value)}
                        />
                        <LineError message={errors[`${prefix}expiryDate`]} />
                      </TableCell>
                      <TableCell>
                        <Input
                          id={idOf(`${prefix}note`)}
                          maxLength={500}
                          aria-label={t('stockDocs.lineNote', { row })}
                          aria-invalid={Boolean(errors[`${prefix}note`])}
                          value={line.note}
                          onChange={(event) => setLine(index, 'note', event.target.value)}
                        />
                        <LineError message={errors[`${prefix}note`]} />
                      </TableCell>
                      {showHand ? (
                        <TableCell>
                          {stock === undefined ? (
                            <span className='text-muted-foreground'>
                              {line.itemId && line.warehouseId
                                ? t('stockDocs.loadingStock')
                                : DASH}
                            </span>
                          ) : (
                            <span
                              className={cn(
                                NUMBER,
                                qty > stock && 'text-destructive',
                              )}
                            >
                              {qty > stock
                                ? t('stockDocs.overBy', {
                                    onHand: formatQty(stock, locale),
                                    over: formatQty(qty - stock, locale),
                                  })
                                : formatQty(stock, locale)}
                            </span>
                          )}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <Button
                          variant='ghost'
                          disabled={busy}
                          aria-label={t('stockDocs.removeLine', { row })}
                          onClick={() => removeLine(index)}
                        >
                          <XIcon aria-hidden='true' />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='outline' size='sm' disabled={busy} onClick={addLine}>
              <PlusIcon aria-hidden='true' />
              {t('stockDocs.addLine')}
            </Button>
            <span className='text-sm text-muted-foreground'>
              {t(`stockDocs.${def.words}.formHint`)}
            </span>
          </div>
        </DocumentSection>
        <DocumentSection title={t('erp.docFiles.title')}>
          <DocFilesPanel
            files={doc?.files ?? []}
            ids={values.fileIds}
            disabled={busy}
            onChange={(fileIds) => setHeader('fileIds', [...fileIds])}
          />
        </DocumentSection>
        <OrderPickerDialog
          def={def}
          open={picking}
          onOpenChange={setPicking}
          onPick={applyOrder}
        />
        {def.kind === 'in' && canPickInspection ? (
          <InspectionPickerDialog
            open={pickingInspection}
            onOpenChange={setPickingInspection}
            onPick={applyInspection}
          />
        ) : null}
        {leave.dialog}
      </FeedbackForm>
    </DocumentPage>
  );
}

/** 子页里的一个可填字段：标签在上面，必填的加星号，错了在下面标出来。 */
function DocField({
  id,
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly required?: boolean;
  readonly error?: string;
  readonly hint?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Field className={className} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden='true' className='text-destructive'>
            *
          </span>
        ) : null}
      </FieldLabel>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** 明细里的一个下拉：第一项是「请选择」，选它等于没选。 */
function LineSelect({
  id,
  label,
  placeholder,
  value,
  options,
  invalid,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const items = [{ value: NONE, label: placeholder }, ...options];
  return (
    <Select
      items={items}
      disabled={disabled}
      value={value || NONE}
      onValueChange={(next) =>
        onChange(String(next) === NONE ? '' : String(next))
      }
    >
      <SelectTrigger
        id={id}
        className='w-full min-w-40'
        aria-label={label}
        aria-invalid={invalid}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className={option.value === NONE ? 'text-muted-foreground' : undefined}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LineError({ message }: { readonly message: string | undefined }): ReactElement | null {
  if (!message) return null;
  return (
    <p role='alert' className='mt-1 text-xs text-destructive'>
      {message}
    </p>
  );
}
