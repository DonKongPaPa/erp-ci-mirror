import { useTranslation } from '@nocobase/i18n/client';
import { Loader2, Search, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';

import type { QualityClient, TicketCandidate } from './client.js';
import { ticketErrorText } from './ticket-errors.js';

/**
 * 搜同事并选中经办人：关键字只按姓名与用户名匹配（服务端的搜同事端点）。
 * 接口按设计回标识、姓名、用户名三列，但页面只显示姓名 —— 用户名当姓名为空时
 * 的回退也不显示，姓名为空给一句占位；页面上不出现邮箱与账号 id。
 * 搜索要显式点一下按钮才发：空关键字不发请求，结果不自动猜。
 */
export function ColleagueSearch({
  client,
  departmentId,
  value,
  onPick,
  label,
  id,
}: {
  readonly client: QualityClient;
  /** 目标责任部门；没有部门时整个搜索禁用。 */
  readonly departmentId: string | null;
  readonly value: string | null;
  readonly onPick: (candidate: TicketCandidate | null) => void;
  readonly label: string;
  readonly id: string;
}): ReactElement {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const [rows, setRows] = useState<readonly TicketCandidate[]>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();

  const selected = rows?.find((row) => row.id === value) ?? undefined;

  const search = async (): Promise<void> => {
    const q = keyword.trim();
    if (departmentId === null || q.length === 0 || searching) return;
    setSearching(true);
    setError(undefined);
    try {
      const result = await client.searchCandidates(departmentId, q);
      setRows(result.items);
    } catch (next) {
      setError(ticketErrorText(next, t));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2'>
        <Input
          id={id}
          type='search'
          aria-label={label}
          placeholder={t('quality.candidates.placeholder')}
          value={keyword}
          disabled={departmentId === null}
          onChange={(event) => setKeyword(event.target.value)}
          className='max-w-64'
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void search();
            }
          }}
        />
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={departmentId === null || keyword.trim().length === 0 || searching}
          onClick={() => void search()}
        >
          {searching ? (
            <Loader2 data-icon='inline-start' className='animate-spin' />
          ) : (
            <Search data-icon='inline-start' />
          )}
          {t('quality.candidates.search')}
        </Button>
      </div>
      {departmentId === null ? (
        <p className='text-xs text-muted-foreground'>
          {t('quality.candidates.needDepartment')}
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='text-xs text-destructive'>
          {error}
        </p>
      ) : null}
      {selected ? (
        <div className='flex items-center gap-2 text-sm'>
          <span>{selected.name ?? t('quality.candidates.noName')}</span>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            aria-label={t('quality.candidates.clear')}
            onClick={() => onPick(null)}
          >
            <X data-icon='inline-start' />
            {t('quality.candidates.clear')}
          </Button>
        </div>
      ) : null}
      {rows && !selected ? (
        rows.length === 0 ? (
          <p className='text-xs text-muted-foreground'>
            {t('quality.candidates.empty')}
          </p>
        ) : (
          <ul className='flex max-h-40 flex-col gap-1 overflow-y-auto'>
            {rows.map((row) => (
              <li key={row.id}>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='w-full justify-start'
                  onClick={() => onPick(row)}
                >
                  {row.name ?? t('quality.candidates.noName')}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
