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
import { Input } from '#components/ui/input';

import { CellField, SelectField } from './fields.js';
import type { LineDraft } from './model.js';
import { itemChoices, type Choice, type Item } from './reference.js';

/**
 * 新建与编辑里的明细表（《基座ERP前端设计》2.4）：整张表能填，能加行、删行（删的是没保存的行）。
 * 同一张单里同一个物料只能出现一行；选了物料就带出单位。
 *
 * 波 0 加片：交期、税率、两套单价与行备注在这里录入；未税金额、税额、价税合计由服务端算，
 * 页面不在前端另算一套 —— 保存后到详情读服务端回的金额。
 *
 * 格子里的控件是输入框：格子组件定义在模块这一层、身份不变，最新的值与回调从上下文里取。
 * 写在渲染函数里的格子每次输入都会换一个组件，输入框被重装、焦点丢失、第二个字打不进去。
 */
interface EditorContextValue {
  readonly formId: string;
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

function TextCell({
  line,
  field,
  label,
  error,
}: Line & {
  readonly field: keyof LineDraft;
  readonly label: string;
  readonly error?: string;
}): ReactElement {
  const { formId, disabled, onChange } = useEditor();
  const numeric =
    field === 'qty' ||
    field === 'price' ||
    field === 'taxRate' ||
    field === 'taxExcludedPrice';
  return (
    <CellField invalid={Boolean(error)} error={error}>
      <Input
        id={`${formId}-${field}-${line.key}`}
        inputMode={numeric ? 'decimal' : 'text'}
        autoComplete='off'
        aria-label={label}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        value={String(line[field] ?? '')}
        onChange={(event) => onChange(line.key, { [field]: event.target.value })}
      />
    </CellField>
  );
}

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

function FieldCell({
  line,
  index,
  field,
  name,
}: Line & {
  readonly field: keyof LineDraft;
  readonly name: string;
}): ReactElement {
  const { errors } = useEditor();
  const { t } = useTranslation();
  return (
    <TextCell
      line={line}
      index={index}
      field={field}
      label={t(`orderDocs.fields.${name}InLine`, { row: index + 1 })}
      error={errors[`${field}-${line.key}`]}
    />
  );
}

function UnitLineCell({ line }: { readonly line: LineDraft }): ReactElement {
  const { itemsById } = useEditor();
  return (
    <>
      {itemsById.get(line.itemId)?.unitCode ?? (
        <span className='text-muted-foreground'>—</span>
      )}
    </>
  );
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

const fieldCell = (field: keyof LineDraft, name: string) =>
  function Cell(context: CellContext<LineDraft, unknown>): ReactElement {
    return <FieldCell {...line(context)} field={field} name={name} />;
  };

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
  qty: fieldCell('qty', 'qty'),
  price: fieldCell('price', 'price'),
  taxExcludedPrice: fieldCell('taxExcludedPrice', 'taxExcludedPrice'),
  taxRate: fieldCell('taxRate', 'taxRate'),
  deliveryDate: fieldCell('deliveryDate', 'deliveryDate'),
  note: (context: CellContext<LineDraft, unknown>): ReactElement => {
    const value = line(context);
    return <NoteCell {...value} />;
  },
  remove: (context: CellContext<LineDraft, unknown>): ReactElement => (
    <RemoveLineCell {...line(context)} />
  ),
} satisfies Record<string, ColumnDef<LineDraft>['cell']>;

function NoteCell({ line, index }: Line): ReactElement {
  const { errors } = useEditor();
  const { t } = useTranslation();
  return (
    <TextCell
      line={line}
      index={index}
      field='note'
      label={t('orderDocs.fields.noteInLine', { row: index + 1 })}
      error={errors[`note-${line.key}`]}
    />
  );
}

const REMOVE_HEADER = (): ReactElement => <RemoveHeader />;

export function LinesEditor({
  formId,
  lines,
  errors,
  items,
  disabled,
  onAdd,
  onChange,
  onRemove,
}: {
  readonly formId: string;
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
      { id: 'qty', header: t('orderDocs.fields.qty'), cell: CELLS.qty },
      { id: 'price', header: t('orderDocs.fields.price'), cell: CELLS.price },
      {
        id: 'taxExcludedPrice',
        header: t('orderDocs.fields.taxExcludedPrice'),
        cell: CELLS.taxExcludedPrice,
      },
      { id: 'taxRate', header: t('orderDocs.fields.taxRate'), cell: CELLS.taxRate },
      {
        id: 'deliveryDate',
        header: t('orderDocs.fields.deliveryDate'),
        cell: CELLS.deliveryDate,
      },
      { id: 'note', header: t('erp.fields.note'), cell: CELLS.note },
      { id: 'remove', header: REMOVE_HEADER, cell: CELLS.remove },
    ],
    [t],
  );

  const stopEnter = (event: KeyboardEvent<HTMLElement>): void => {
    // 明细里按回车是「填完了这一格」，不是「保存」：保存只走页头的按钮。
    if (event.key === 'Enter') event.preventDefault();
  };

  return (
    <EditorContext.Provider
      value={{ formId, errors, itemsById, choices, disabled, onChange, onRemove }}
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
          <Button size='sm' variant='outline' disabled={disabled} onClick={onAdd}>
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
        {lines.some(
          (row) => itemsById.get(row.itemId)?.status === 'inactive',
        ) ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('items.form.inactive')}
          </p>
        ) : null}
      </DetailSection>
    </EditorContext.Provider>
  );
}
