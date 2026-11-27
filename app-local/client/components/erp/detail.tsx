import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { RouteDrawer } from '#components/route-drawer';
import { StatusBadge } from '#components/status-badge';
import { cn } from 'cn';

/**
 * 档案与单据的详情版式（《基座ERP前端设计》2.3、2.4）：「标签 — 值」的字段、分节，
 * 主数据的抽屉。单据的子页见 `document.tsx`。
 */

export interface DetailField {
  /** 标签文字；同一组里不重复，兼作键。 */
  readonly label: string;
  /** `null`、`undefined` 或空串画「—」。 */
  readonly value: ReactNode;
  /** 占满一整行（地址、备注这一类长文本）。 */
  readonly wide?: boolean;
}

const EMPTY = '—';

function fieldValue(value: ReactNode): ReactNode {
  if (value === null || value === undefined || value === '')
    return <span className='text-muted-foreground'>{EMPTY}</span>;
  return value;
}

/**
 * 「标签 — 值」两列。`layout='pair'`（档案抽屉）：标签在左、值在右，宽屏一行两对；
 * `layout='stack'`（单据表头）：标签在值上面，一行四到五个。
 */
export function DetailFields({
  fields,
  layout = 'pair',
}: {
  readonly fields: readonly (DetailField | false | null | undefined)[];
  readonly layout?: 'pair' | 'stack';
}): ReactElement {
  return (
    <dl
      data-slot='detail-fields'
      className={cn(
        'grid gap-x-6 gap-y-3 text-sm',
        layout === 'pair'
          ? 'grid-cols-1 sm:grid-cols-2'
          : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-5',
      )}
    >
      {fields
        .filter((field): field is DetailField => Boolean(field))
        .map((field) => (
          <div
            key={field.label}
            className={cn(
              'min-w-0',
              layout === 'pair' ? 'flex gap-3' : 'flex flex-col gap-1',
              field.wide && 'sm:col-span-2',
            )}
          >
            <dt
              className={cn(
                'min-w-0 text-muted-foreground',
                layout === 'pair' && 'w-28 shrink-0',
              )}
            >
              {field.label}
            </dt>
            <dd className='min-w-0 flex-1 wrap-anywhere'>
              {fieldValue(field.value)}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** 详情里的一节：小标题加内容。 */
export function DetailSection({
  title,
  actions,
  children,
}: {
  readonly title: ReactNode;
  /** 标题行右边的操作，如联系人表的「添加联系人」。 */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className='flex min-w-0 flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** 主数据的状态徽标：在用（绿）、已停用（灰）。 */
export function ActiveBadge({
  active,
}: {
  readonly active: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return active ? (
    <StatusBadge size='sm' tone='success'>
      {t('erp.status.active')}
    </StatusBadge>
  ) : (
    <StatusBadge size='sm' tone='neutral'>
      {t('erp.status.inactive')}
    </StatusBadge>
  );
}

/** 分类值一类的徽标（客户、供应商）：不带颜色含义。 */
export function TypeBadge({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <StatusBadge size='sm' tone='neutral'>
      {children}
    </StatusBadge>
  );
}

/**
 * 主数据的详情抽屉：最上面是记录的名字和徽标，正文是各节，页脚是这条记录的操作。
 * 从列表点记录的名字打开，列表还在后面。
 */
export function RecordDrawer({
  title,
  badges,
  description,
  wide,
  footer,
  children,
}: {
  readonly title: ReactNode;
  readonly badges?: ReactNode;
  /** 名字下面的一行，如「编码 CU…」。 */
  readonly description?: ReactNode;
  /** 正文里有子表时加宽。 */
  readonly wide?: boolean;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteDrawer
      title={
        <span className='flex flex-wrap items-center gap-2'>
          <span className='min-w-0 wrap-anywhere'>{title}</span>
          {badges}
        </span>
      }
      description={description}
      className={wide ? 'sm:max-w-3xl' : undefined}
      footer={footer}
    >
      <div className='flex flex-col gap-6'>{children}</div>
    </RouteDrawer>
  );
}
