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
import { errorText } from '#components/erp/messages';
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

import { StockDocsClient, type StockDoc } from './client.js';
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
}

function StockDocForm({
  def,
  doc,
  title,
  lookup,
  canPick,
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
    setValues((old) => ({ ...old, lines: [...old.lines, emptyLine()] }));
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
      const body = inputOf(values);
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
            <Field>
              <FieldLabel>{t('stockDocs.fields.source')}</FieldLabel>
              {/* 来源由订单那一头生成时才有，这里不改。 */}
              <div className='flex min-h-8 items-center rounded-lg border border-border bg-muted/50 px-2.5 text-sm'>
                {doc?.sourceType
                  ? t(`stockDocs.source.${doc.sourceType}`)
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
          <p className='text-sm text-muted-foreground'>
            {t('stockDocs.lineCount', { lines: values.lines.length })}
          </p>
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
                  <TableHead>{t('stockDocs.columns.unit')}</TableHead>
                  <TableHead className='text-right'>
                    {t('stockDocs.columns.qty')}
                    <span aria-hidden='true' className='text-destructive'>
                      *
                    </span>
                  </TableHead>
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
