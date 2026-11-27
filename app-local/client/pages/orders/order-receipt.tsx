import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
} from 'react';
import { useParams } from 'react-router';

import { LinesTable } from '#components/erp/document';
import {
  FormApi,
  FormDialog,
  FormField,
  FormGrid,
} from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { Field, FieldError } from '#components/ui/field';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import {
  OrdersClient,
  type Order,
  type OrderLine,
  type StockDocument,
} from './client.js';
import { ItemCell } from './fields.js';
import type { OrderKindDef } from './kinds.js';
import {
  formatNumber,
  receiptFieldErrors,
  receiptFormOf,
  receiptInputOf,
  validateReceipt,
  type ReceiptFormValues,
} from './model.js';
import { useOrder } from './record.js';
import {
  useReferencePage,
  type Item,
  type WarehouseOption,
} from './reference.js';

/**
 * 「生成入库单 / 出库单」（`…/create-receipt`、`…/create-issue`）：订单页上的一个对话框（《基座ERP前端设计》2.4）。
 * 选一个仓库，每一行的本次数量默认是未到货（未发货）数量，可以改小，不能改大；留 0 的行不生成。
 * 得到的是一张草稿库存单据，过账由仓管在那张单上做。
 */
export function OrderReceiptPage({
  def,
}: {
  readonly def: OrderKindDef;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const orderId = useParams()[def.param] ?? '';
  const client = useMemo(() => new OrdersClient(api, def), [api, def]);
  const make = useCan({ resource: def.resource, action: def.makeAction });
  const itemsView = useCan({
    resource: { type: 'composite', id: 'items' },
    action: 'view',
  });
  const warehouseView = useCan({
    resource: { type: 'composite', id: 'inventory' },
    action: 'warehouseView',
  });
  const record = useOrder(def, orderId, make.can);
  const items = useReferencePage<Item>('items', itemsView.can);
  const warehouses = useReferencePage<WarehouseOption>(
    'warehouses?status=active',
    warehouseView.can,
  );
  const title = t(`${def.l}.receiptTitle`);
  return (
    <FormRoute title={title} pending={make.isPending} allowed={make.can}>
      <RecordRoute title={title} record={record}>
        {(order) => (
          <ReceiptForm
            key={order.updatedAt}
            def={def}
            order={order}
            client={client}
            items={items.items}
            warehouses={warehouses.items}
            notify={toaster}
          />
        )}
      </RecordRoute>
    </FormRoute>
  );
}

function ReceiptForm({
  def,
  order,
  client,
  items,
  warehouses,
  notify,
}: {
  readonly def: OrderKindDef;
  readonly order: Order;
  readonly client: OrdersClient;
  readonly items: readonly Item[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly notify: ReturnType<typeof useToaster>;
}): ReactElement {
  const { t } = useTranslation();
  // 规则码落到哪一行要看提交时填的数：留最新的一份值。
  const latestRef = useRef<ReceiptFormValues>(receiptFormOf(order));
  const initialValues = useMemo(() => receiptFormOf(order), [order]);
  return (
    <FormDialog<ReceiptFormValues, StockDocument>
      title={t(`${def.l}.receiptTitle`)}
      description={t(`${def.l}.receiptDescription`, {
        orderNo: order.orderNo,
      })}
      submitLabel={t('orderDocs.actions.generate')}
      initialValues={initialValues}
      validate={(values) =>
        validateReceipt(values, order, t(`${def.l}.actions.doneWord`), t)
      }
      save={(values) => client.make(order.id, receiptInputOf(values))}
      onSuccess={(doc) =>
        notify.show({
          type: 'success',
          title: t(`${def.l}.madeToast`, { name: doc.docNo }),
        })
      }
      fieldErrors={(error) =>
        receiptFieldErrors(error, latestRef.current, order)
      }
    >
      {(form) => (
        <ReceiptFields
          def={def}
          order={order}
          form={form}
          items={items}
          warehouses={warehouses}
          onValues={(values) => {
            latestRef.current = values;
          }}
        />
      )}
    </FormDialog>
  );
}

/**
 * 对话框里的格子与明细表一样：组件身份不变，表单的最新值从上下文里取。
 * 写在渲染函数里的格子每次输入都会换一个组件，输入框被重装、焦点丢失、第二个字打不进去。
 */
interface ReceiptContextValue {
  readonly def: OrderKindDef;
  readonly locale: string;
  readonly form: FormApi<ReceiptFormValues>;
  readonly itemsById: ReadonlyMap<string, Item>;
}

const ReceiptContext = createContext<ReceiptContextValue | null>(null);

function useReceiptCells(): ReceiptContextValue {
  const value = useContext(ReceiptContext);
  if (!value)
    throw new Error('Receipt cells must be rendered inside ReceiptFields.');
  return value;
}

function QtyLineCell({
  line,
  index,
}: {
  readonly line: OrderLine;
  readonly index: number;
}): ReactElement {
  const { def, form } = useReceiptCells();
  const { t } = useTranslation();
  return (
    <FormField
      name={`qty-${line.id}`}
      label={
        <span className='sr-only'>
          {t(`${def.l}.receiptLineTitle`)} {index + 1}
        </span>
      }
      className='w-28'
    >
      {(id, invalid) => (
        <Input
          id={id}
          inputMode='decimal'
          autoComplete='off'
          aria-invalid={invalid}
          value={form.values.quantities[line.id] ?? ''}
          onChange={(event) =>
            form.set('quantities', {
              ...form.values.quantities,
              [line.id]: event.target.value,
            })
          }
        />
      )}
    </FormField>
  );
}

function ItemLineCell({ line }: { readonly line: OrderLine }): ReactElement {
  const { itemsById } = useReceiptCells();
  return <ItemCell item={itemsById.get(line.itemId)} />;
}

function RemainingLineCell({
  line,
}: {
  readonly line: OrderLine;
}): ReactElement {
  const { locale } = useReceiptCells();
  return (
    <span className='tabular-nums'>
      {formatNumber(line.remainingQty, locale)}
    </span>
  );
}

const cell = (context: CellContext<OrderLine, unknown>): OrderLine =>
  context.row.original;

const CELLS = {
  item: (context: CellContext<OrderLine, unknown>): ReactElement => (
    <ItemLineCell line={cell(context)} />
  ),
  remaining: (context: CellContext<OrderLine, unknown>): ReactElement => (
    <RemainingLineCell line={cell(context)} />
  ),
  qty: (context: CellContext<OrderLine, unknown>): ReactElement => (
    <QtyLineCell line={cell(context)} index={context.row.index} />
  ),
} satisfies Record<string, ColumnDef<OrderLine>['cell']>;

function ReceiptFields({
  def,
  order,
  form,
  items,
  warehouses,
  onValues,
}: {
  readonly def: OrderKindDef;
  readonly order: Order;
  readonly form: FormApi<ReceiptFormValues>;
  readonly items: readonly Item[] | undefined;
  readonly warehouses: readonly WarehouseOption[] | undefined;
  readonly onValues: (values: ReceiptFormValues) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  useEffect(() => {
    onValues(form.values);
  }, [form.values, onValues]);
  useEffect(() => {
    // 服务端说数量超过剩余（设计第七节第 4 步）：把光标放到标出来的那一行的数量上。
    // 共用的 FormDialog 只在自己的校验没过时挪光标，服务端的规则码在这里补上。
    const key = Object.keys(form.errors).find(
      (name) => name.startsWith('qty-') && form.errors[name],
    );
    if (!key) return;
    document.querySelector<HTMLElement>(`[id$="-${key}"]`)?.focus();
  }, [form.errors]);
  const itemsById = useMemo(
    () => new Map((items ?? []).map((item) => [item.id, item] as const)),
    [items],
  );
  const columns = useMemo<ColumnDef<OrderLine>[]>(
    () => [
      {
        id: 'item',
        header: t('orderDocs.fields.item'),
        cell: CELLS.item,
      },
      {
        id: 'remaining',
        header: t(`${def.l}.actions.remaining`),
        cell: CELLS.remaining,
      },
      {
        id: 'qty',
        header: t(`${def.l}.receiptLineTitle`),
        cell: CELLS.qty,
      },
    ],
    [t, def.l],
  );
  // 已经生成完的行不列。
  const rows = useMemo(
    () => order.lines.filter((line) => line.remainingQty > 0),
    [order],
  );
  const choices = (warehouses ?? []).map((warehouse) => ({
    value: warehouse.id,
    label: `${warehouse.code} ${warehouse.name}`,
  }));
  const general = form.errors.receipt;
  return (
    <div className='flex flex-col gap-4'>
      <FormGrid>
        <FormField
          name='warehouseId'
          label={t('orderDocs.fields.warehouse')}
          required
          className='sm:col-span-2'
        >
          {(id, invalid) => (
            <Select
              items={choices}
              value={form.values.warehouseId || null}
              onValueChange={(next) =>
                form.set('warehouseId', next === null ? '' : String(next))
              }
            >
              <SelectTrigger id={id} className='w-full' aria-invalid={invalid}>
                <SelectValue placeholder={t('orderDocs.form.choose')} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </FormGrid>
      <ReceiptContext.Provider value={{ def, locale, form, itemsById }}>
        <LinesTable<OrderLine>
          columns={columns}
          rows={rows}
          getRowId={(line) => line.id}
          emptyMessage={t('orderDocs.receipt.nothingLeft')}
        />
      </ReceiptContext.Provider>
      <Field data-invalid={general ? true : undefined}>
        {general ? <FieldError>{general}</FieldError> : null}
      </Field>
      <p className='text-sm text-muted-foreground'>
        {t(`${def.l}.receiptHint`)}
      </p>
    </div>
  );
}
