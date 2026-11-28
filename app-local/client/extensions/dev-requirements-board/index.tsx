import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { Badge } from '#components/ui/badge';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#components/ui/sheet';

/**
 * R-082 需求池看板：开发区里的只读页面（R-073，不进部署产物）。
 *
 * 数据来自 `GET /dev/requirements-board`，每次打开现算；页面不提供改状态、排序或编辑权重。
 * 要调次序由人看完之后告诉主会话，需求池仍是唯一的数据源。
 */

import {
  STATUS_COLUMNS,
  blockingLabel,
  suggestedOrder,
  type BoardItem,
  type BoardSnapshot,
} from './model.js';

const WEIGHT_STYLE: Readonly<Record<string, string>> = {
  P0: 'bg-destructive/10 text-destructive',
  P1: 'bg-primary/10 text-primary',
  P2: 'bg-muted text-foreground',
  P3: 'bg-muted text-muted-foreground',
  P4: 'bg-muted text-muted-foreground',
};

function WeightBadge({ weight }: { readonly weight: string }): ReactElement | null {
  if (!weight || weight === '无') return null;
  return (
    <Badge variant='secondary' className={WEIGHT_STYLE[weight] ?? ''}>
      {weight}
    </Badge>
  );
}

function BoardCard({
  item,
  onOpen,
}: {
  readonly item: BoardItem;
  readonly onOpen: (item: BoardItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  const lines = item.lastEntry?.text.split('\n').slice(0, 2) ?? [];
  return (
    <article
      data-testid={`card-${item.id}`}
      className='rounded-md border border-border bg-card p-3 text-left text-sm'
    >
      <button
        type='button'
        className='w-full cursor-pointer text-left'
        aria-label={t('devTools.requirementsBoard.openDetail', { name: item.id })}
        onClick={() => onOpen(item)}
      >
        <span className='flex items-center gap-2'>
          <span className='font-medium'>{item.id}</span>
          <Badge variant='outline'>{item.category}</Badge>
          <WeightBadge weight={item.weight} />
        </span>
        <span className='mt-1 block'>{item.name}</span>
        <span className='mt-1 block text-xs text-muted-foreground'>
          {blockingLabel(item)}
        </span>
        {item.lastEntry ? (
          <span className='mt-1 block text-xs text-muted-foreground'>
            {item.lastEntry.at}
            {lines.map((line) => (
              <span key={line} className='block'>
                {line}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </article>
  );
}

export default function RequirementsBoardPage(): ReactElement {
  const api = useApiClient();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState('all');
  const [onlyUnfinished, setOnlyUnfinished] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<BoardItem | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .request<{ data: BoardSnapshot }>({
        path: '/dev/requirements-board',
        signal: controller.signal,
      })
      .then((body) => {
        if (!controller.signal.aborted) setSnapshot(body.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [api]);

  const order = useMemo(
    () => suggestedOrder(snapshot?.requirements ?? []),
    [snapshot],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (snapshot?.requirements ?? []).filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (onlyUnfinished && item.blocking === '已完成') return false;
      if (!needle) return true;
      return (
        item.id.toLowerCase().includes(needle) ||
        item.name.toLowerCase().includes(needle)
      );
    });
  }, [snapshot, category, onlyUnfinished, query]);

  if (failed) {
    return <p role='alert'>{t('devTools.requirementsBoard.loadFailed')}</p>;
  }
  if (!snapshot) {
    return <p>{t('devTools.requirementsBoard.loading')}</p>;
  }

  const counts = new Map(
    STATUS_COLUMNS.map((status) => [
      status,
      snapshot.requirements.filter((item) => item.status === status).length,
    ]),
  );

  return (
    <div className='mx-auto flex w-full max-w-7xl flex-col gap-6 p-6'>
      <div>
        <h1 className='text-2xl font-semibold'>
          {t('devTools.requirementsBoard.title')}
        </h1>
        <p className='text-sm text-muted-foreground'>
          <span>{t('devTools.requirementsBoard.total', { count: snapshot.totals.pool })}</span>
          {' · '}
          <span>
            {t('devTools.requirementsBoard.skipped', {
              count: snapshot.totals.skipped,
            })}
          </span>
          {' · '}
          <span>
            {t('devTools.requirementsBoard.generatedAt', {
              at: snapshot.generatedAt,
            })}
          </span>
        </p>
        <p className='text-xs text-muted-foreground'>
          {STATUS_COLUMNS.map((status) => (
            <span key={status} className='mr-3'>
              {status}: {counts.get(status) ?? 0}
            </span>
          ))}
        </p>
      </div>

      <section data-testid='suggested-order' aria-label={t('devTools.requirementsBoard.suggestedOrder')}>
        <h2 className='text-lg font-semibold'>
          {t('devTools.requirementsBoard.suggestedOrder')}
        </h2>
        <ol className='flex flex-col gap-2'>
          {order.inProgress.map((item) => (
            <li key={item.id} data-testid='suggested-item'>
              {item.id} {item.name} —{' '}
              {t('devTools.requirementsBoard.reasonInProgress', {
                at: item.lastEntry?.at ?? '',
              })}
            </li>
          ))}
          {order.ready.map((item) => (
            <li key={item.id} data-testid='suggested-item'>
              {item.id} {item.name} —{' '}
              {t('devTools.requirementsBoard.reasonReady')}
            </li>
          ))}
          {order.blocked.map((item) => (
            <li key={item.id} data-testid='suggested-item'>
              {item.id} {item.name} —{' '}
              {t('devTools.requirementsBoard.reasonBlocked', {
                deps: item.blockingDetail,
              })}
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={t('devTools.requirementsBoard.filters')}>
        <h2 className='text-lg font-semibold'>
          {t('devTools.requirementsBoard.filters')}
        </h2>
        <div className='flex flex-wrap items-center gap-3'>
          <Select value={category} onValueChange={(value) => setCategory(value ?? 'all')}>
            <SelectTrigger aria-label={t('devTools.requirementsBoard.category')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>
                {t('devTools.requirementsBoard.allCategories')}
              </SelectItem>
              <SelectItem value='业务'>
                {t('devTools.requirementsBoard.business')}
              </SelectItem>
              <SelectItem value='工程'>
                {t('devTools.requirementsBoard.engineering')}
              </SelectItem>
            </SelectContent>
          </Select>
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={onlyUnfinished}
              onCheckedChange={(value) => setOnlyUnfinished(value === true)}
            />
            {t('devTools.requirementsBoard.onlyUnfinished')}
          </label>
          <Input
            aria-label={t('devTools.requirementsBoard.search')}
            placeholder={t('devTools.requirementsBoard.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </section>

      <section aria-label={t('devTools.requirementsBoard.board')}>
        <div className='grid grid-cols-1 gap-3 md:grid-cols-4 xl:grid-cols-7'>
          {STATUS_COLUMNS.map((status) => (
            <div
              key={status}
              data-testid={`column-${status}`}
              className='rounded-md border border-border bg-muted/30 p-2'
            >
              <h3 className='mb-2 text-sm font-semibold'>{status}</h3>
              <div className='flex flex-col gap-2'>
                {visible
                  .filter((item) => item.status === status)
                  .map((item) => (
                    <BoardCard key={item.id} item={item} onOpen={setSelected} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{selected ? `${selected.id} ${selected.name}` : ''}</SheetTitle>
            <SheetDescription>
              {selected ? blockingLabel(selected) : ''}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className='flex flex-col gap-3 text-sm'>
              <div>
                <h4 className='font-medium'>
                  {t('devTools.requirementsBoard.note')}
                </h4>
                <p>{selected.note}</p>
              </div>
              <div>
                <h4 className='font-medium'>
                  {t('devTools.requirementsBoard.dependencies')}
                </h4>
                <p>{selected.hardDeps.join(', ') || '—'}</p>
                <p className='text-xs text-muted-foreground'>
                  {selected.softDeps.join(', ') || '—'}
                </p>
              </div>
              <div>
                <h4 className='font-medium'>
                  {t('devTools.requirementsBoard.latestEntry')}
                </h4>
                <p>{selected.lastEntry?.text ?? t('devTools.requirementsBoard.noEntries')}</p>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
