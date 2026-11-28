import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { ClockIcon, InboxIcon, Link2Icon, RocketIcon } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty';
import { Input } from '#components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#components/ui/sheet';
import { Skeleton } from '#components/ui/skeleton';
import { Switch } from '#components/ui/switch';
import { Timeline, TimelineItem } from '#components/ui/timeline';
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group';
import { cn } from 'cn';

/**
 * R-082 需求池看板：开发区里的只读页面（R-073，不进部署产物）。
 *
 * 数据来自 `GET /dev/requirements-board`，每次打开现算；页面不提供改状态、排序或编辑权重。
 * 要调次序由人看完之后告诉主会话，需求池仍是唯一的数据源。
 *
 * 2026-11-28 重新设计（用户：「没点进去之前总结一段简短一点的，点进去才看长的」）：
 * 页头下一排状态磁贴与两块计数；建议次序是三条横向轨道里的迷你卡；泳道上的卡片只留编号、标签、
 * 两行标题与一句话摘要；长的东西（卡点细节、依赖、全部跟进记录的时间线）都在抽屉里。
 * 手机：磁贴与计数排两列，轨道的标签挪到迷你卡上方，泳道仍是在自己的容器里横向滚动。
 */

import {
  STATUS_COLUMNS,
  cardSummary,
  longTime,
  shortTime,
  suggestedOrder,
  type BoardItem,
  type BoardSnapshot,
} from './model.js';

/** 高亮一次停留的时间：滚过去之后让人看到是哪一张。 */
const FLASH_MS = 1600;
/** 卡片底部最多露出的硬依赖徽章，多的折成 +N。 */
const MAX_DEP_BADGES = 3;

/** 只用主题令牌：七个状态各占一种，深浅主题都由主题文件给色。 */
const STATUS_COLOR: Readonly<Record<string, string>> = {
  待评估: 'bg-(--chart-5)',
  可行性已确认: 'bg-(--chart-2)',
  需业务决策: 'bg-(--status-warning)',
  方案已定: 'bg-(--chart-3)',
  实现中: 'bg-(--chart-1)',
  待验收: 'bg-primary',
  已实现: 'bg-(--status-success)',
};

/** 权重由重到轻：P0 最重，P3、P4 最轻；「无」没有点也不显示徽章。 */
const WEIGHT_STYLE: Readonly<Record<string, string>> = {
  P0: 'bg-destructive/10 text-destructive',
  P1: 'bg-primary/10 text-primary',
  P2: 'bg-muted text-foreground',
  P3: 'bg-muted text-muted-foreground',
  P4: 'bg-muted text-muted-foreground',
};
const WEIGHT_DOT: Readonly<Record<string, string>> = {
  P0: 'bg-destructive',
  P1: 'bg-primary',
  P2: 'bg-foreground',
  P3: 'bg-muted-foreground/60',
  P4: 'bg-muted-foreground/60',
};

/** 「卡在哪」五种，颜色只作辅助，文字一直在。 */
const BLOCKING_COLOR: Readonly<Record<string, string>> = {
  已完成: 'bg-(--status-success)',
  在途: 'bg-primary',
  待设计: 'bg-muted-foreground/50',
  等依赖: 'bg-(--status-warning)',
  可开工: 'bg-(--chart-2)',
};
const BLOCKING_KEY: Readonly<Record<string, string>> = {
  已完成: 'devTools.requirementsBoard.done',
  在途: 'devTools.requirementsBoard.inProgress',
  待设计: 'devTools.requirementsBoard.designPending',
  等依赖: 'devTools.requirementsBoard.blocked',
  可开工: 'devTools.requirementsBoard.ready',
};

const CATEGORIES = ['all', '业务', '工程'] as const;
const CATEGORY_KEY: Readonly<Record<string, string>> = {
  all: 'devTools.requirementsBoard.allCategories',
  业务: 'devTools.requirementsBoard.business',
  工程: 'devTools.requirementsBoard.engineering',
};

/** 点一下跳到泳道或卡片：先滚过去，再高亮一会儿。 */
interface Flash {
  readonly kind: 'column' | 'card';
  readonly id: string;
}

interface TrackItem {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly items: readonly BoardItem[];
}

interface ItemActions {
  readonly onOpen: (item: BoardItem) => void;
  /** 板上有的编号才能跳。 */
  readonly isOnBoard: (id: string) => boolean;
  readonly onJump: (id: string) => void;
}

function Dot({
  color,
  className,
}: {
  readonly color: string | undefined;
  readonly className?: string;
}): ReactElement {
  return (
    <span
      data-dot=''
      aria-hidden='true'
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        color,
        className,
      )}
    />
  );
}

/** 「卡在哪」的文字：接口给的是中文的值，页面上按当前语言显示。 */
function BlockingName({
  blocking,
}: {
  readonly blocking: string;
}): ReactElement {
  const { t } = useTranslation();
  return <>{t(BLOCKING_KEY[blocking] ?? blocking)}</>;
}

function WeightBadge({
  weight,
}: {
  readonly weight: string;
}): ReactElement | null {
  if (!weight || weight === '无') return null;
  return (
    <Badge variant='secondary' className={WEIGHT_STYLE[weight] ?? ''}>
      {weight}
    </Badge>
  );
}

/**
 * 依赖编号的小徽章。板上有的编号可点（盖在卡片的整块按钮之上）；板外的（X-xxx、没登记的）只是标签。
 */
function DepBadge({
  id,
  actions,
}: {
  readonly id: string;
  readonly actions: ItemActions;
}): ReactElement {
  const { t } = useTranslation();
  if (!actions.isOnBoard(id)) {
    return (
      <Badge
        data-testid={`dep-${id}`}
        variant='outline'
        className='shrink-0 font-mono'
      >
        {id}
      </Badge>
    );
  }
  return (
    <Button
      data-testid={`dep-${id}`}
      type='button'
      size='xs'
      variant='secondary'
      className='relative z-20 shrink-0 gap-0 font-mono'
      aria-label={t('devTools.requirementsBoard.jumpTo', { id })}
      onClick={() => actions.onJump(id)}
    >
      {id}
    </Button>
  );
}

/** 整块可点的卡：一个铺满的按钮垫在内容下面，可点的徽章用 z-20 盖在它上面。 */
function CardButton({
  item,
  actions,
  title,
}: {
  readonly item: BoardItem;
  readonly actions: ItemActions;
  readonly title: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Button
      type='button'
      variant='ghost'
      className='absolute inset-0 z-10 h-auto w-auto rounded-lg focus-visible:ring-2 focus-visible:ring-ring'
      aria-label={t('devTools.requirementsBoard.openDetail', { name: item.id })}
      title={title}
      onClick={() => actions.onOpen(item)}
    />
  );
}

function BoardCard({
  item,
  actions,
  highlighted,
}: {
  readonly item: BoardItem;
  readonly actions: ItemActions;
  readonly highlighted: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const summary = cardSummary(item);
  const source = item.lastEntry?.text || item.note;
  const shownDeps = item.hardDeps.slice(0, MAX_DEP_BADGES);
  const rest = item.hardDeps.length - shownDeps.length;
  return (
    <article
      data-testid={`card-${item.id}`}
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'relative flex min-w-0 flex-col gap-1.5 rounded-lg bg-card p-3 text-left ring-1 ring-foreground/10 transition-shadow dark:ring-border',
        highlighted && 'ring-2 ring-ring',
      )}
    >
      <CardButton
        item={item}
        actions={actions}
        title={source ? `${item.name}\n\n${source}` : item.name}
      />
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='font-mono text-xs font-bold whitespace-nowrap'>
          {item.id}
        </span>
        <Badge variant='outline'>{item.category}</Badge>
        <WeightBadge weight={item.weight} />
      </div>
      <p
        className='line-clamp-2 break-words text-sm font-medium'
        title={item.name}
      >
        {item.name}
      </p>
      <p
        data-testid='card-summary'
        className='line-clamp-2 text-xs break-words text-muted-foreground'
        title={source || undefined}
      >
        {summary || t('devTools.requirementsBoard.noRecord')}
      </p>
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground'>
        <span className='inline-flex min-w-0 max-w-full items-center gap-1'>
          <Dot color={BLOCKING_COLOR[item.blocking]} />
          <span className='truncate'>
            <BlockingName blocking={item.blocking} />
          </span>
        </span>
        {shownDeps.map((dep) => (
          <DepBadge key={dep} id={dep} actions={actions} />
        ))}
        {rest > 0 ? (
          <Badge data-testid='dep-more' variant='outline' className='shrink-0'>
            {t('devTools.requirementsBoard.moreDeps', { count: rest })}
          </Badge>
        ) : null}
        {item.lastEntry ? (
          <span
            data-testid='card-time'
            className='ml-auto inline-flex items-center gap-1 whitespace-nowrap tabular-nums'
          >
            <ClockIcon className='size-3' aria-hidden='true' />
            {shortTime(item.lastEntry.at)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

/**
 * 建议次序里的迷你卡：左边一道按权重着色的竖条，第一行编号与权重徽章，标题两行，原因在底部。
 * 放不下就少显示几张（见 `Track`），不靠省略号。
 */
function MiniCard({
  item,
  actions,
}: {
  readonly item: BoardItem;
  readonly actions: ItemActions;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <article
      data-testid='suggested-item'
      className='relative flex w-64 shrink-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-card py-2.5 pr-3 pl-4 text-left transition-colors hover:bg-hover'
    >
      <span
        data-slot='weight-bar'
        aria-hidden='true'
        className={cn('absolute inset-y-0 left-0 w-1', WEIGHT_DOT[item.weight])}
      />
      <CardButton item={item} actions={actions} title={item.name} />
      <span className='flex min-w-0 flex-wrap items-center gap-1.5'>
        <Badge variant='outline' className='shrink-0 font-mono'>
          {item.id}
        </Badge>
        <WeightBadge weight={item.weight} />
      </span>
      <p className='line-clamp-2 break-words text-sm' title={item.name}>
        {item.name}
      </p>
      <span className='mt-auto flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground'>
        {item.blocking === '等依赖' ? (
          <>
            <span>{t('devTools.requirementsBoard.waitingOn')}</span>
            {item.hardDeps.map((dep) => (
              <DepBadge key={dep} id={dep} actions={actions} />
            ))}
          </>
        ) : item.blocking === '可开工' ? (
          <Badge variant='secondary'>
            {t('devTools.requirementsBoard.reasonReady')}
          </Badge>
        ) : item.lastEntry ? (
          <span className='inline-flex items-center gap-1 tabular-nums'>
            <ClockIcon className='size-3' aria-hidden='true' />
            {t('devTools.requirementsBoard.lastFollowUpAt', {
              at: shortTime(item.lastEntry.at),
            })}
          </span>
        ) : (
          <span>{t('devTools.requirementsBoard.noRecord')}</span>
        )}
      </span>
    </article>
  );
}

/** 迷你卡的宽与间距（与样式里的 `w-64`、`gap-2` 对应），用来算一行放得下几张。 */
const MINI_CARD_WIDTH = 256;
const TRACK_GAP = 8;
/** 还没量到宽度时（首帧、测试环境）先按这个数显示。 */
const FALLBACK_CAPACITY = 3;

/**
 * 一条轨道：默认只显示一行，放不下的收起，行末一个「还有 N 个」；点开才在轨道内换行。
 * 展开状态只在组件里，不写浏览器本地存储。
 */
function Track({
  track,
  actions,
  expanded,
  onToggle,
}: {
  readonly track: TrackItem;
  readonly actions: ItemActions;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const capacity =
    width > 0
      ? Math.max(
          2,
          Math.floor((width + TRACK_GAP) / (MINI_CARD_WIDTH + TRACK_GAP)),
        )
      : FALLBACK_CAPACITY;
  const overflow = track.items.length > capacity;
  const shown =
    expanded || !overflow ? track.items : track.items.slice(0, capacity - 1);
  const rest = track.items.length - shown.length;

  return (
    <div
      data-testid={`track-${track.key}`}
      data-expanded={expanded ? '' : undefined}
      className='grid gap-2 sm:grid-cols-[calc(var(--spacing)*32)_minmax(0,1fr)] sm:items-start'
    >
      <div className='flex min-w-0 items-center gap-2 pl-1 sm:pt-2.5'>
        <Dot color={track.color} />
        <span className='truncate text-sm font-medium'>{track.label}</span>
        <Badge variant='secondary'>{track.items.length}</Badge>
      </div>
      {track.items.length > 0 ? (
        <div
          ref={rowRef}
          data-testid={`track-row-${track.key}`}
          className={cn(
            'flex min-w-0 gap-2',
            expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden',
          )}
        >
          {shown.map((item) => (
            <MiniCard key={item.id} item={item} actions={actions} />
          ))}
          {overflow ? (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              data-testid={`track-more-${track.key}`}
              aria-expanded={expanded}
              className={cn('shrink-0 self-center', !expanded && 'ml-auto')}
              onClick={onToggle}
            >
              {expanded
                ? t('devTools.requirementsBoard.showLess')
                : t('devTools.requirementsBoard.moreItems', { count: rest })}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className='flex min-h-16 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground'>
          {t('devTools.requirementsBoard.emptyTrack')}
        </div>
      )}
    </div>
  );
}

function DetailBlock({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className='flex min-w-0 flex-col gap-2'>
      <h3 className='text-sm font-semibold'>{title}</h3>
      {children}
    </section>
  );
}

export default function RequirementsBoardPage(): ReactElement {
  const api = useApiClient();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState<string>('all');
  const [onlyUnfinished, setOnlyUnfinished] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<BoardItem | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  // 展开了的轨道；只在组件里，不写浏览器本地存储。
  const [expandedTracks, setExpandedTracks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  // 泳道总宽超过容器时要让人知道可以横向滚动：这个主题下的滚动条几乎看不见（界面检查 10：整板 16558 像素宽，滚动条 0 像素）。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = (): void => {
      setScrollable(element.scrollWidth > element.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [snapshot]);

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

  // 跳转：等 DOM 更新完再滚到目标并高亮，一会儿后熄灭。
  useEffect(() => {
    if (!flash) return;
    const prefix = flash.kind === 'column' ? 'column' : 'card';
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-testid="${prefix}-${flash.id}"]`,
    );
    target?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

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

  const order = useMemo(() => suggestedOrder(visible), [visible]);

  /** 点依赖编号：被筛选藏起来的先清掉筛选，再关抽屉滚过去。 */
  const jumpTo = (id: string): void => {
    setSelected(null);
    if (!visible.some((item) => item.id === id)) {
      setCategory('all');
      setOnlyUnfinished(false);
      setQuery('');
    }
    setFlash({ kind: 'card', id });
  };
  // 每次渲染给一份新的：jumpTo 读的是当前筛选后的 visible，不能缓存。
  const actions: ItemActions = {
    onOpen: setSelected,
    isOnBoard: (id) =>
      Boolean(snapshot?.requirements.some((item) => item.id === id)),
    onJump: jumpTo,
  };

  if (failed) {
    return (
      <PageContainer>
        <p role='alert'>{t('devTools.requirementsBoard.loadFailed')}</p>
      </PageContainer>
    );
  }
  if (!snapshot) {
    return (
      <PageContainer>
        <PageHeader title={t('devTools.requirementsBoard.title')} />
        <span className='sr-only'>
          {t('devTools.requirementsBoard.loading')}
        </span>
        <div
          className='grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9'
          aria-hidden='true'
        >
          {Array.from({ length: 9 }, (_, index) => (
            <Skeleton key={index} className='h-20 rounded-lg' />
          ))}
        </div>
      </PageContainer>
    );
  }

  const counts = new Map(
    STATUS_COLUMNS.map((status) => [
      status,
      snapshot.requirements.filter((item) => item.status === status).length,
    ]),
  );
  const all = suggestedOrder(snapshot.requirements);
  const counters = [
    {
      key: 'ready',
      label: t('devTools.requirementsBoard.ready'),
      count: all.ready.length,
      icon: RocketIcon,
      tone: 'bg-(--chart-2)/10 text-(--chart-2)',
    },
    {
      key: 'blocked',
      label: t('devTools.requirementsBoard.blocked'),
      count: all.blocked.length,
      icon: Link2Icon,
      tone: 'bg-(--status-warning)/10 text-(--status-warning)',
    },
  ] as const;
  const tracks: readonly TrackItem[] = [
    {
      key: 'inProgress',
      label: t('devTools.requirementsBoard.inProgress'),
      items: order.inProgress,
      color: 'bg-primary',
    },
    {
      key: 'ready',
      label: t('devTools.requirementsBoard.ready'),
      items: order.ready,
      color: 'bg-(--chart-2)',
    },
    {
      key: 'blocked',
      label: t('devTools.requirementsBoard.blocked'),
      items: order.blocked,
      color: 'bg-(--status-warning)',
    },
  ];
  const toggleTrack = (key: string): void =>
    setExpandedTracks((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <PageContainer>
      <PageHeader
        title={t('devTools.requirementsBoard.title')}
        description={
          <>
            <span>
              {t('devTools.requirementsBoard.total', {
                count: snapshot.totals.pool,
              })}
            </span>
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
          </>
        }
      />

      <div className='flex min-w-0 flex-col gap-6'>
        <section
          aria-label={t('devTools.requirementsBoard.byStatus')}
          className='grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9'
        >
          {STATUS_COLUMNS.map((status) => (
            <Button
              key={status}
              type='button'
              variant='outline'
              data-testid={`tile-${status}`}
              className='relative flex h-auto min-w-0 flex-col items-start gap-2 overflow-hidden rounded-lg p-3 text-left whitespace-normal'
              onClick={() => setFlash({ kind: 'column', id: status })}
            >
              <span className='flex w-full items-center gap-2'>
                <Dot color={STATUS_COLOR[status]} />
                <span className='min-w-0 text-sm whitespace-normal break-words'>
                  {status}
                </span>
              </span>
              <span className='font-heading text-2xl font-semibold tabular-nums'>
                {counts.get(status) ?? 0}
              </span>
              <span
                aria-hidden='true'
                className={cn(
                  'absolute inset-x-0 bottom-0 h-1',
                  STATUS_COLOR[status],
                )}
              />
            </Button>
          ))}
          {counters.map((counter) => (
            <div
              key={counter.key}
              data-testid={`counter-${counter.key}`}
              className='flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border bg-card p-3'
            >
              <span className='flex w-full min-w-0 items-center gap-3'>
                <span
                  aria-hidden='true'
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    counter.tone,
                  )}
                >
                  <counter.icon className='size-4' />
                </span>
                <span className='font-heading text-2xl leading-none font-semibold tabular-nums'>
                  {counter.count}
                </span>
              </span>
              {/* 与状态磁贴一致：标签允许换行、不省略（放大 150% 时窄列里只剩图标的那个问题）。 */}
              <span
                data-testid={`counter-label-${counter.key}`}
                className='min-w-0 text-xs break-words text-muted-foreground whitespace-normal'
              >
                {counter.label}
              </span>
            </div>
          ))}
        </section>

        <Card
          data-testid='suggested-order'
          role='region'
          aria-label={t('devTools.requirementsBoard.suggestedOrder')}
        >
          <CardHeader>
            <CardTitle>
              {t('devTools.requirementsBoard.suggestedOrder')}
            </CardTitle>
            <CardDescription>
              {t('devTools.requirementsBoard.suggestedOrderHint')}
            </CardDescription>
          </CardHeader>
          <CardContent className='flex min-w-0 flex-col gap-3'>
            {tracks.map((track) => (
              <Track
                key={track.key}
                track={track}
                actions={actions}
                expanded={expandedTracks.has(track.key)}
                onToggle={() => toggleTrack(track.key)}
              />
            ))}
          </CardContent>
        </Card>

        <section
          aria-label={t('devTools.requirementsBoard.filters')}
          className='flex flex-wrap items-center gap-2'
        >
          <ToggleGroup
            variant='outline'
            spacing={0}
            aria-label={t('devTools.requirementsBoard.category')}
            value={[category]}
            onValueChange={(value) => setCategory(value[0] ?? 'all')}
          >
            {CATEGORIES.map((option) => (
              <ToggleGroupItem key={option} value={option} className='px-3'>
                {t(CATEGORY_KEY[option] ?? option)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <label className='flex cursor-pointer items-center gap-2 text-sm'>
            <Switch
              checked={onlyUnfinished}
              onCheckedChange={(checked) => setOnlyUnfinished(checked)}
            />
            {t('devTools.requirementsBoard.onlyUnfinished')}
          </label>
          <Input
            aria-label={t('devTools.requirementsBoard.search')}
            placeholder={t('devTools.requirementsBoard.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className='w-full sm:ml-auto sm:w-64'
          />
        </section>

        <section aria-label={t('devTools.requirementsBoard.board')}>
          <div
            ref={scrollRef}
            data-testid='board-scroll'
            className='w-full overflow-x-auto pb-2'
          >
            <div className='flex w-max gap-3'>
              {STATUS_COLUMNS.map((status) => {
                const items = visible.filter((item) => item.status === status);
                const highlighted =
                  flash?.kind === 'column' && flash.id === status;
                return (
                  <section
                    key={status}
                    data-testid={`column-${status}`}
                    data-highlighted={highlighted ? '' : undefined}
                    className={cn(
                      'flex w-96 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 ring-1 ring-border transition-shadow dark:bg-muted/20',
                      highlighted && 'ring-2 ring-ring',
                    )}
                  >
                    <div className='flex items-center gap-2 px-1 py-1'>
                      <Dot color={STATUS_COLOR[status]} />
                      <h3 className='min-w-0 flex-1 truncate text-sm font-semibold'>
                        {status}
                      </h3>
                      <Badge variant='secondary'>{items.length}</Badge>
                    </div>
                    {items.length > 0 ? (
                      items.map((item) => (
                        <BoardCard
                          key={item.id}
                          item={item}
                          actions={actions}
                          highlighted={
                            flash?.kind === 'card' && flash.id === item.id
                          }
                        />
                      ))
                    ) : (
                      <Empty className='min-h-32 gap-0 border border-dashed py-6'>
                        <EmptyHeader>
                          <EmptyMedia variant='icon'>
                            <InboxIcon />
                          </EmptyMedia>
                          <EmptyTitle>
                            {t('devTools.requirementsBoard.emptyLane')}
                          </EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
          {scrollable ? (
            <p
              data-testid='board-scroll-hint'
              className='mt-2 text-xs text-muted-foreground'
            >
              {t('devTools.requirementsBoard.scrollHint')}
            </p>
          ) : null}
        </section>
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className='w-full gap-0 data-[side=right]:sm:max-w-xl'>
          <SheetHeader className='gap-2 pr-12'>
            <SheetTitle className='flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words'>
              {selected ? (
                <>
                  <span className='font-mono text-sm font-bold'>
                    {selected.id}
                  </span>
                  <span className='min-w-0 flex-1'>{selected.name}</span>
                </>
              ) : (
                ''
              )}
            </SheetTitle>
            <SheetDescription className='flex flex-wrap items-center gap-1.5'>
              {selected ? (
                <>
                  <Badge variant='outline'>{selected.status}</Badge>
                  <Badge variant='outline'>{selected.category}</Badge>
                  <WeightBadge weight={selected.weight} />
                  <span className='inline-flex items-center gap-1'>
                    <Dot color={BLOCKING_COLOR[selected.blocking]} />
                    <BlockingName blocking={selected.blocking} />
                  </span>
                </>
              ) : null}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <div
              data-testid='board-detail-body'
              className='flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6 text-sm'
            >
              <DetailBlock title={t('devTools.requirementsBoard.stuckAt')}>
                <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
                  <Dot color={BLOCKING_COLOR[selected.blocking]} />
                  <BlockingName blocking={selected.blocking} />
                  {selected.blocking === '在途' && selected.blockingDetail ? (
                    <span className='text-muted-foreground'>
                      {t('devTools.requirementsBoard.lastFollowUpAt', {
                        at: longTime(selected.blockingDetail),
                      })}
                    </span>
                  ) : null}
                  {selected.blocking === '等依赖'
                    ? selected.hardDeps
                        .filter((dep) =>
                          selected.blockingDetail.split(', ').includes(dep),
                        )
                        .map((dep) => (
                          <DepBadge key={dep} id={dep} actions={actions} />
                        ))
                    : null}
                </div>
              </DetailBlock>
              <DetailBlock title={t('devTools.requirementsBoard.dependencies')}>
                {(['hardDeps', 'softDeps'] as const).map((kind) => (
                  <div
                    key={kind}
                    className='flex min-w-0 flex-wrap items-center gap-1.5'
                  >
                    <span className='text-xs text-muted-foreground'>
                      {t(
                        kind === 'hardDeps'
                          ? 'devTools.requirementsBoard.hardDeps'
                          : 'devTools.requirementsBoard.softDeps',
                      )}
                    </span>
                    {selected[kind].length > 0 ? (
                      selected[kind].map((dep) => (
                        <DepBadge key={dep} id={dep} actions={actions} />
                      ))
                    ) : (
                      <span className='text-muted-foreground'>
                        {t('devTools.requirementsBoard.none')}
                      </span>
                    )}
                  </div>
                ))}
              </DetailBlock>
              <DetailBlock title={t('devTools.requirementsBoard.note')}>
                <p className='break-words'>
                  {selected.note || t('devTools.requirementsBoard.none')}
                </p>
              </DetailBlock>
              <DetailBlock title={t('devTools.requirementsBoard.followUps')}>
                {selected.entries.length > 0 ? (
                  <Timeline
                    data-testid='board-timeline'
                    size='sm'
                    className='pt-0'
                  >
                    {[...selected.entries].reverse().map((entry, index) => (
                      <TimelineItem
                        key={`${entry.at}·${entry.text}`}
                        date={longTime(entry.at)}
                        description={entry.text}
                        status={index === 0 ? 'in-progress' : 'completed'}
                        iconColor={index === 0 ? 'primary' : 'muted'}
                      />
                    ))}
                  </Timeline>
                ) : (
                  <Empty className='min-h-24 gap-0 border border-dashed py-4'>
                    <EmptyHeader>
                      <EmptyMedia variant='icon'>
                        <InboxIcon />
                      </EmptyMedia>
                      <EmptyTitle>
                        {t('devTools.requirementsBoard.noEntries')}
                      </EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </DetailBlock>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
