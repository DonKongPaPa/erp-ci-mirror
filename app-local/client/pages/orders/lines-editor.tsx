import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { PlusIcon, XIcon } from 'lucide-react';
import {
  createContext,
  useContext,
  useMemo,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import { DataTable } from '#components/data-table';
import { DetailSection } from '#components/erp/detail';
import type { FieldErrors } from '#components/erp/form-dialog';
import { Button } from '#components/ui/button';
import { TableCell } from '#components/ui/table';
import { Input } from '#components/ui/input';

import { CellField, Dash, SelectField } from './fields.js';
import {
  formatAmount,
  lineAmount,
  orderTotal,
  parseDecimal,
  type LineDraft,
} from './model.js';
import { itemChoices, type Choice, type Item } from './reference.js';

/**
 * 新建与编辑里的明细表（《基座ERP前端设计》2.4）：整张表能填，能加行、删行（删的是没保存的行）。
 * 同一张单里同一个物料只能出现一行；选了物料就带出单位。
 *
 * 格子里的控件是输入框：格子组件定义在模块这一层、身份不变，最新的值与回调从上下文里取。
 * 写在渲染函数里的格子每次输入都会换一个组件，输入框被重装、焦点丢失、第二个字打不进去。
 */
interface EditorContextValue {
  /** 整张表单的 id：控件的名字是 `<表单 id>-<字段名>`，校验没过时光标按这个落下来。 */
  readonly formId: string;
  readonly locale: string;
  readonly errors: FieldErrors;
  readonly itemsById: ReadonlyMap<string, Item>;
  readonly choices: readonly Choice[];
  readonly disabled: boolean;
  readonly onChange: (key: string, patch: Readonly<Partial<LineDraft>>) => void;
  readonly onRemove: (key: string) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value)
    throw new Error('Line cells must be rendered inside LinesEditor.');
  return value;
}

type Line = { readonly line: LineDraft; readonly index: number };

function ItemLineCell({ line, index }: Line): ReactElement {
  const { formId, choices, errors, disabled, onChange } = useEditor();
  const { t } = useTranslation();
  return (
    <div className='flex min-w-56 flex-col gap-3'>
      <SelectField
        id={`${formId}-item-${line.key}`}
        hideLabel
        required
        label={t('orderDocs.fields.itemInLine', { row: index + 1 })}
        error={errors[`item-${line.key}`]}
        value={line.itemId}
        onChange={(itemId) => onChange(line.key, { itemId })}
        options={choices}
        placeholder={t('orderDocs.form.choose')}
        disabled={disabled}
        className='min-w-48'
      />
    </div>
  );
}

function PriceLineCell({ line, index }: Line): ReactElement {
  const { formId, errors, disabled, onChange } = useEditor();
  const { t } = useTranslation();
  const message = errors[`price-${line.key}`];
  return (
    <CellField invalid={Boolean(message)} error={message}>
      <Input
        id={`${formId}-price-${line.key}`}
        inputMode='decimal'
        autoComplete='off'
        aria-label={t('orderDocs.fields.priceInLine', { row: index + 1 })}
        aria-invalid={message ? true : undefined}
        disabled={disabled}
        value={line.price}
        onChange={(event) => onChange(line.key, { price: event.target.value })}
      />
    </CellField>
  );
}

function AmountLineCell({ line }: { readonly line: LineDraft }): ReactElement {
  const { locale } = useEditor();
  const { t } = useTranslation();
  const qty = parseDecimal(line.qty);
  const price = parseDecimal(line.price);
  const amount =
    qty === undefined || price === undefined
      ? undefined
      : lineAmount({ qty, price });
  return amount === undefined ? (
    <Dash />
  ) : (
    <span className='tabular-nums'>
      {t('orderDocs.money', { amount: formatAmount(amount, locale) })}
    </span>
  );
}

function QtyLineCell({ line, index }: Line): ReactElement {
  const { formId, errors, disabled, onChange } = useEditor();
  const { t } = useTranslation();
  const message = errors[`qty-${line.key}`];
  return (
    <CellField invalid={Boolean(message)} error={message}>
      <Input
        id={`${formId}-qty-${line.key}`}
        inputMode='decimal'
        autoComplete='off'
        required
        aria-label={t('orderDocs.fields.qtyInLine', { row: index + 1 })}
        aria-invalid={message ? true : undefined}
        disabled={disabled}
        value={line.qty}
        onChange={(event) => onChange(line.key, { qty: event.target.value })}
      />
    </CellField>
  );
}

function UnitLineCell({ line }: { readonly line: LineDraft }): ReactElement {
  const { itemsById } = useEditor();
  return <>{itemsById.get(line.itemId)?.unitCode ?? <Dash />}</>;
}

function RemoveLineCell({ line, index }: Line): ReactElement {
  const { disabled, onRemove } = useEditor();
  const { t } = useTranslation();
  return (
    <div className='flex justify-end'>
      <Button
        variant='ghost'
        size='icon-sm'
        disabled={disabled}
        aria-label={t('orderDocs.actions.removeLine', { row: index + 1 })}
        onClick={() => onRemove(line.key)}
      >
        <XIcon aria-hidden='true' />
      </Button>
    </div>
  );
}

function RemoveHeader(): ReactElement {
  const { t } = useTranslation();
  return <span className='sr-only'>{t('orderDocs.fields.lines')}</span>;
}

const line = ({ row }: CellContext<LineDraft, unknown>): Line => ({
  line: row.original,
  index: row.index,
});

/** 格子的身份不变：表格重新渲染时控件不会被重装。 */
const CELLS = {
  index: ({ row }: CellContext<LineDraft, unknown>): ReactElement => (
    <span className='text-muted-foreground tabular-nums'>{row.index + 1}</span>
  ),
  item: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <ItemLineCell {...line(context)} />
  ),
  unit: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <UnitLineCell line={context.row.original} />
  ),
  price: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <PriceLineCell {...line(context)} />
  ),
  amount: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <AmountLineCell line={context.row.original} />
  ),
  qty: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <QtyLineCell {...line(context)} />
  ),
  remove: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <RemoveLineCell {...line(context)} />
  ),
} satisfies Record<string, ColumnDef<LineDraft>['cell']>;

const REMOVE_HEADER = (): ReactElement => <RemoveHeader />;

export function LinesEditor({
  formId,
  locale,
  lines,
  errors,
  items,
  disabled,
  onAdd,
  onChange,
  onRemove,
}: {
  readonly formId: string;
  readonly locale: string;
  readonly lines: readonly LineDraft[];
  readonly errors: FieldErrors;
  readonly items: readonly Item[] | undefined;
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onChange: (key: string, patch: Readonly<Partial<LineDraft>>) => void;
  readonly onRemove: (key: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const itemsById = useMemo(
    () => new Map((items ?? []).map((item) => [item.id, item] as const)),
    [items],
  );
  const choices = useMemo(
    () => itemChoices(items ?? [], t('orderDocs.form.inactiveItem')),
    [items, t],
  );
  const columns = useMemo<ColumnDef<LineDraft>[]>(
    () => [
      { id: 'index', header: '#', cell: CELLS.index },
      { id: 'item', header: t('orderDocs.fields.item'), cell: CELLS.item },
      { id: 'unit', header: t('orderDocs.fields.unit'), cell: CELLS.unit },
      {
        id: 'price',
        header: t('orderDocs.fields.price'),
        cell: CELLS.price,
      },
      {
        id: 'amount',
        header: t('orderDocs.fields.amount'),
        cell: CELLS.amount,
      },
      { id: 'qty', header: t('orderDocs.fields.qty'), cell: CELLS.qty },
      { id: 'remove', header: REMOVE_HEADER, cell: CELLS.remove },
    ],
    [t],
  );

  // 每一行都填了数量与单价才画合计行。
  const total = orderTotal(
    lines.map((row) => ({
      qty: parseDecimal(row.qty) ?? Number.NaN,
      price: row.price.trim() ? (parseDecimal(row.price) ?? null) : null,
    })),
  );
  const stopEnter = (event: KeyboardEvent<HTMLElement>): void => {
    // 明细里按回车是「填完了这一格」，不是「保存」：保存只走页头的按钮。
    if (event.key === 'Enter') event.preventDefault();
  };
  const shown = total !== undefined && !Number.isNaN(total);

  return (
    <EditorContext.Provider
      value={{
        formId,
        locale,
        errors,
        itemsById,
        choices,
        disabled,
        onChange,
        onRemove,
      }}
    >
      <DetailSection
        title={
          <span className='flex items-baseline gap-3'>
            {t('orderDocs.fields.lines')}
            <span className='text-sm font-normal text-muted-foreground tabular-nums'>
              {t('orderDocs.fields.lineCount', { count: lines.length })}
            </span>
          </span>
        }
        actions={
          <Button
            size='sm'
            variant='outline'
            disabled={disabled}
            onClick={onAdd}
          >
            <PlusIcon aria-hidden='true' />
            {t('orderDocs.actions.addLine')}
          </Button>
        }
      >
        <div onKeyDownCapture={stopEnter}>
          <DataTable<LineDraft>
            columns={columns}
            data={lines}
            getRowId={(row) => row.key}
            pagination={false}
            showSelectedCount={false}
            sortableColumns={[]}
            summaryRow={
              shown && total !== undefined ? (
                <>
                  <TableCell colSpan={5} className='text-right font-medium'>
                    {t('orderDocs.fields.totalAmount')}
                  </TableCell>
                  <TableCell className='text-right font-medium tabular-nums'>
                    {t('orderDocs.money', {
                      amount: formatAmount(total, locale),
                    })}
                  </TableCell>
                </>
              ) : undefined
            }
            emptyMessage={t('orderDocs.form.linesEmpty')}
          />
        </div>
        {errors.lines ? (
          <p role='alert' className='text-sm text-destructive'>
            {errors.lines}
          </p>
        ) : null}
        <p className='text-sm text-muted-foreground'>
          {t('orderDocs.form.linesHint')}
        </p>
      </DetailSection>
    </EditorContext.Provider>
  );
}
