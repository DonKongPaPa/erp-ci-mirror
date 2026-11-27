import type { ColumnDef } from '@tanstack/react-table';
import type { ReactElement, ReactNode } from 'react';

import { DataTable } from '#components/data-table';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { RouteChildPage } from '#components/route-child-page';
import { cn } from 'cn';

import { DetailFields, type DetailField } from './detail.js';
import { ListTabs, type ListTab } from './list-page.js';

/**
 * 单据页的版式（《基座ERP前端设计》2.4）：采购订单、销售订单、入库单、出库单共用一个骨架 ——
 * 盖在列表上的子页，页头是单号与状态徽标加这一刻能做的操作，下面是状态条、页签、表头字段、明细与合计。
 */

export type StatusTone = 'neutral' | 'info' | 'warning' | 'destructive';

const TONES: Readonly<Record<StatusTone, string>> = {
  neutral: 'border-border',
  info: 'border-primary/20 bg-primary/5',
  warning: 'border-(--status-warning)/30 bg-(--status-warning-background)',
  destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
};

/**
 * 一张单的子页。`actions` 里主按钮只有一个，其余的放次级按钮；已经生成的单据不传任何操作。
 */
export function DocumentPage({
  title,
  badge,
  actions,
  status,
  tabs,
  children,
}: {
  /** 单号。 */
  readonly title: ReactNode;
  /** 状态徽标。 */
  readonly badge?: ReactNode;
  readonly actions?: ReactNode;
  /** 状态条：现在是什么状态、下一步做什么；出错了用 `tone='destructive'`。 */
  readonly status?: ReactNode;
  readonly tabs?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteChildPage>
      <PageContainer>
        <PageHeader
          title={
            <span className='flex flex-wrap items-center gap-2'>
              {title}
              {badge}
            </span>
          }
          actions={actions}
        />
        {status}
        {tabs}
        {children}
      </PageContainer>
    </RouteChildPage>
  );
}

/** 单据的页签（「订单信息」「入库记录」），记在地址栏的 `tab` 上。 */
export function DocumentTabs({
  items,
  value,
  onChange,
}: {
  readonly items: readonly ListTab[];
  readonly value: string;
  readonly onChange: (key: string) => void;
}): ReactElement {
  return <ListTabs items={items} value={value} onChange={onChange} />;
}

/** 状态条：一行说明；颜色只是辅助，文字里已经写明是什么状态。 */
export function DocumentStatusBar({
  tone = 'neutral',
  children,
}: {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        TONES[tone],
      )}
    >
      {children}
    </div>
  );
}

/** 单据表头的「标签 — 值」，一行四到五个。 */
export function DocumentHeaderFields({
  fields,
}: {
  readonly fields: readonly (DetailField | false | null | undefined)[];
}): ReactElement {
  return <DetailFields fields={fields} layout='stack' />;
}

/** 表头的一节或明细的一节的标题。 */
export function DocumentSection({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className='flex min-w-0 flex-col gap-3'>
      <h3 className='text-sm font-semibold'>{title}</h3>
      {children}
    </section>
  );
}

/**
 * 明细表：查看时是只读的表格，数量右对齐；`totals` 是明细下面的合计行（与列对齐的单元格），
 * 由页面按明细加出来。没有分页、没有排序。
 */
export function LinesTable<TData>({
  columns,
  rows,
  getRowId,
  totals,
  emptyMessage,
}: {
  readonly columns: ColumnDef<TData>[];
  readonly rows: readonly TData[];
  readonly getRowId: (row: TData) => string;
  readonly totals?: ReactNode;
  readonly emptyMessage?: ReactNode;
}): ReactElement {
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => getRowId(row)}
      pagination={false}
      showSelectedCount={false}
      sortableColumns={[]}
      summaryRow={totals}
      emptyMessage={emptyMessage}
    />
  );
}
