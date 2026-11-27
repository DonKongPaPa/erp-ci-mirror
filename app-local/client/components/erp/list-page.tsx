import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';

import { DataTableSearch } from '#components/data-table';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';

/**
 * 基座 ERP 的页面构件（《基座ERP前端设计》第二节）。各模块的列表页、详情与表单直接拼这些；
 * 表格、空态与错误态、分页、清空筛选与重试都由 `DataTable` 出，这里只补它上面的一层。
 */

export interface ListPageProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** 对着整个页面的操作，只放一个主按钮；没有写权限的人不传。 */
  readonly actions?: ReactNode;
  readonly tabs?: ReactNode;
  readonly children: ReactNode;
}

/** 列表页的骨架：页头 → 可选的标签栏 → 列表本体。 */
export function ListPage({
  title,
  description,
  actions,
  tabs,
  children,
}: ListPageProps): ReactElement {
  return (
    <PageContainer>
      <PageHeader title={title} description={description} actions={actions} />
      {tabs}
      {children}
    </PageContainer>
  );
}

export interface ListTab {
  readonly key: string;
  readonly label: string;
}

/** 线型标签页。当前标签记在地址栏里，由调用方读写；换标签时页头的主按钮也由调用方跟着换。 */
export function ListTabs({
  items,
  value,
  onChange,
}: {
  readonly items: readonly ListTab[];
  readonly value: string;
  readonly onChange: (key: string) => void;
}): ReactElement {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(String(next))}>
      <TabsList variant='line'>
        {items.map((item) => (
          <TabsTrigger key={item.key} value={item.key} className='px-3'>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** 页头的「新建 ×」：整颗是一个链接，指向新建的路由对话框。 */
export function NewButton({
  to,
  label,
}: {
  readonly to: string;
  readonly label: ReactNode;
}): ReactElement {
  return (
    <Button size='sm' nativeButton={false} render={<Link to={to} />}>
      <PlusIcon aria-hidden='true' />
      {label}
    </Button>
  );
}

/** 列表的搜索框：停下来约 300 毫秒自动搜，输入法组字期间不动。 */
export function ListSearch({
  value,
  onSearch,
  label,
}: {
  readonly value: string;
  readonly onSearch: (value: string) => void;
  /** 无障碍名称，同时当作提示文字：写明搜哪些字段。 */
  readonly label: string;
}): ReactElement {
  return <DataTableSearch value={value} onSearch={onSearch} label={label} />;
}

/** 「筛选」：展开工具栏下面的一行；`applied` 是展开行里生效的筛选个数。 */
export function FilterToggle({
  expanded,
  applied = 0,
  onClick,
}: {
  readonly expanded: boolean;
  readonly applied?: number;
  readonly onClick: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Button variant='outline' aria-expanded={expanded} onClick={onClick}>
      {t('erp.list.filters')}
      <ChevronDownIcon
        aria-hidden='true'
        className={expanded ? 'rotate-180' : undefined}
      />
      {applied > 0 ? <Badge variant='secondary'>{applied}</Badge> : null}
    </Button>
  );
}

/** 展开后的第二行筛选，只放契约里有的筛选参数。 */
export function FilterRow({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      data-slot='list-filter-row'
      className='flex flex-wrap items-end gap-3 rounded-lg border border-border p-3'
    >
      {children}
    </div>
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

const ALL = '__all__';

/** 展开行里的一个下拉筛选：空值就是「全部」，不进请求。 */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterOption[];
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const items = [{ value: ALL, label: t('erp.list.all') }, ...options];
  return (
    <div className='flex w-48 flex-col gap-1.5'>
      <span className='text-sm font-medium'>{label}</span>
      <Select
        items={items}
        value={value || ALL}
        onValueChange={(next) =>
          onChange(String(next) === ALL ? '' : String(next))
        }
      >
        <SelectTrigger className='w-full' aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** 「含已停用」：主数据列表唯一常驻工具栏的筛选，不设展开。 */
export function IncludeInactiveFilter({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Label className='h-8 whitespace-nowrap font-normal'>
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      {t('erp.list.includeInactive')}
    </Label>
  );
}

/** 结果数，放工具栏的末尾。 */
export function ResultCount({
  count,
}: {
  readonly count: number;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className='text-sm text-muted-foreground tabular-nums'>
      {t('erp.list.resultCount', { count })}
    </span>
  );
}
