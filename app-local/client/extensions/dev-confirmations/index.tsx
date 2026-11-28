import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Button } from '#components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#components/ui/collapsible';
import { Kbd } from '#components/ui/kbd';

/**
 * R-083 待确认事项页：开发区里的问题清单加可填写的答复（R-073，不进部署产物）。
 *
 * 清单来自入库的 `HANDOFF/tasks/confirmations.json`，答复从不入库的 state.json 读出；
 * 提交答复只追加一条，处理状态由主会话用脚本写。
 *
 * 这一页为「一个人、一次答很多道」排的：
 *   - 页头先给进度（已答 / 共）与三块计数，没答的按默认做，不逼人一次答完；
 *   - 选项是点一下就选中的磁贴，数字键 1–9 直接选，「自己写」选中才展开输入框；
 *   - 提交后这道收成一行留在原位，焦点自动落到下一道未答的（Ctrl/⌘+Enter 提交）；
 *   - 分组用带计数的芯片筛，状态用分段按钮切，不再用原生下拉。
 * 数据、答复的存储格式与端点语义都没变。
 *
 * R-083 性能：清单一次取回，但首屏只挂第一页（PAGE_SIZE 张）；草稿归卡片自己持有，
 * 页面上没有随打字变化的状态，卡片记忆化后 props 不变就不重渲染。页头计数、芯片计数
 * 与「已答 / 共」仍按整份清单算，分页只影响挂载多少张卡。
 */

import {
  answeredCount,
  answerPayload,
  awaitingCount,
  byTopic,
  emptyDraft,
  explainedFirst,
  isAnswered,
  topicCounts,
  type ConfirmationItem,
  type ConfirmationSnapshot,
  type Draft,
} from './model.js';
import {
  AllDone,
  AnsweredRow,
  QuestionCard,
  type QuestionCardHandle,
} from './question-card.js';
import { Progress, ProgressLabel } from './progress.js';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.js';

type StatusFilter = 'pending' | 'awaiting' | 'answered' | 'all';

/** 每页挂载的卡片数：首屏不超过 15 张，多了就页尾「加载更多」。 */
const PAGE_SIZE = 12;

/** 提交或跳过之后焦点要去的地方。 */
type FocusTarget =
  | { readonly kind: 'card'; readonly id: string }
  /** 当前范围答到了末尾：有完成态就交给完成态，没有（这个分组本来就没什么可答）就交给刚答完的那一行。 */
  | { readonly kind: 'end'; readonly id: string };

const STATUS_OPTIONS: readonly {
  readonly value: StatusFilter;
  readonly label: string;
}[] = [
  { value: 'pending', label: 'devTools.confirmations.pending' },
  { value: 'awaiting', label: 'devTools.confirmations.awaiting' },
  { value: 'answered', label: 'devTools.confirmations.answered' },
  { value: 'all', label: 'devTools.confirmations.all' },
];

/** 文字输入控件里的按键不当作快捷键（输入框里按数字不算选选项）。 */
const TEXT_INPUT = 'input, textarea, select, [contenteditable=true]';

function percent(answered: number, total: number): number {
  return total === 0 ? 0 : Math.round((answered / total) * 100);
}

/**
 * 一张卡的宿主：把页面级的稳定回调绑到这一道题上，卡片才可能在页面重渲染时比例不变、
 * 被 memo 挡住。草稿不经过这里 —— 提交时从卡片的命令式句柄读。
 */
function QuestionCardSlot({
  item,
  busy,
  hasNext,
  registerCard,
  registerHandle,
  onActivate,
  submit,
  skipToNext,
  clarify,
}: {
  readonly item: ConfirmationItem;
  readonly busy: boolean;
  readonly hasNext: boolean;
  readonly registerCard: (id: string, node: HTMLElement | null) => void;
  readonly registerHandle: (
    id: string,
    handle: QuestionCardHandle | null,
  ) => void;
  readonly onActivate: (id: string) => void;
  readonly submit: (item: ConfirmationItem, draft: Draft) => void;
  readonly skipToNext: (item: ConfirmationItem) => void;
  readonly clarify: (item: ConfirmationItem, note: string) => void;
}): ReactElement {
  // React 19 的 ref 可以作为普通 prop 传；ref 仍只绑这一道题，回调身份稳定。
  const handleRef = useRef<QuestionCardHandle | null>(null);
  const setHandle = useCallback(
    (next: QuestionCardHandle | null) => {
      handleRef.current = next;
      registerHandle(item.id, next);
    },
    [item.id, registerHandle],
  );
  const setNode = useCallback(
    (node: HTMLElement | null) => registerCard(item.id, node),
    [item.id, registerCard],
  );
  const submitHere = useCallback(
    () => submit(item, handleRef.current?.getDraft() ?? emptyDraft),
    [item, submit],
  );
  const skipHere = useCallback(() => skipToNext(item), [item, skipToNext]);
  const clarifyHere = useCallback(
    (note: string) => clarify(item, note),
    [item, clarify],
  );
  return (
    <QuestionCard
      ref={setHandle}
      item={item}
      busy={busy}
      hasNext={hasNext}
      cardRef={setNode}
      onActivate={onActivate}
      onSubmit={submitHere}
      onSkip={skipHere}
      onClarify={clarifyHere}
    />
  );
}

export default function ConfirmationsPage(): ReactElement {
  const api = useApiClient();
  const toaster = useToaster();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ConfirmationSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [clarifyFailed, setClarifyFailed] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [topic, setTopic] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // 本次打开页面后答过的：在「待确认」里留在原位收成一行，刷新后归到「已答复」。
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cardsRef = useRef(new Map<string, HTMLElement>());
  const handlesRef = useRef(new Map<string, QuestionCardHandle>());
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const doneRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback((): (() => void) => {
    const controller = new AbortController();
    void api
      .request<{ data: ConfirmationSnapshot }>({
        path: '/dev/confirmations',
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

  useEffect(() => load(), [load]);

  /**
   * 答完或跳过之后，把焦点交给目标并滚过去：下一道未答的卡；到了末尾交给完成态，
   * 这个范围没有完成态就交给刚答完的那一行（刚提交的卡已经从页面上拿掉，
   * 不接住的话焦点会掉回 body）。下一道可能在还没加载的页里，所以 page 也进依赖，
   * 等它挂载之后再聚焦。jsdom 没有 scrollIntoView，所以先判有再调。
   */
  useEffect(() => {
    if (!focusTarget) return;
    const node =
      focusTarget.kind === 'card'
        ? cardsRef.current.get(focusTarget.id)
        : (doneRef.current ?? rowsRef.current.get(focusTarget.id));
    if (!node) return;
    node.focus();
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    setFocusTarget(null);
  }, [focusTarget, snapshot, page]);

  const answered = answeredCount(snapshot);
  const total = snapshot?.questions.length ?? 0;
  // 「待确认」里本次答过的也列出来（收成一行），其余状态只列当前状态自己的；保持清单的次序。
  const scoped = useMemo(() => {
    const all = snapshot?.questions ?? [];
    return all.filter((item) => {
      if (status === 'all') return true;
      if (status === 'pending')
        return (
          item.group === 'pending' ||
          item.group === 'awaiting' ||
          recent.has(item.id)
        );
      if (status === 'awaiting') return item.group === 'awaiting';
      // 「已答复」只看真正答过的；等补充的题还是未答，不算进来。
      return item.group === 'answered' || item.group === 'processed';
    });
  }, [snapshot, status, recent]);
  const visible = useMemo(
    () =>
      explainedFirst(
        topic === null ? scoped : scoped.filter((item) => item.topic === topic),
      ),
    [scoped, topic],
  );
  // 下一道按整个当前范围算，不受分页影响 —— 这样答完第一页末尾能跳到第二页。
  const openCards = useMemo(
    () => visible.filter((item) => item.group === 'pending'),
    [visible],
  );
  // 首屏只挂第一页；页头与芯片的计数仍来自整份 snapshot。
  const paged = useMemo(
    () => visible.slice(0, page * PAGE_SIZE),
    [visible, page],
  );
  const hasMore = paged.length < visible.length;
  // 画面上展开成卡的：没答的，加上正在「改」的那一道（它可能是已答复或已处理）。
  const cards = useMemo(
    () =>
      paged.filter(
        (item) =>
          item.group === 'pending' ||
          item.group === 'awaiting' ||
          editing === item.id,
      ),
    [paged, editing],
  );
  // 答过的收成一行；「待确认」里只列本次答过的，其余状态列全部。
  const rows = useMemo(
    () =>
      paged.filter(
        (item) =>
          item.group !== 'pending' &&
          item.group !== 'awaiting' &&
          (status !== 'pending' || recent.has(item.id)),
      ),
    [paged, status, recent],
  );
  const topics = topicCounts(snapshot);
  const chipTopics = topics
    .map((entry) => ({
      topic: entry.topic,
      // 芯片的计数口径与页头「共 N」一致：都算未关闭的全部问题，不分状态。
      count: entry.total,
    }))
    .filter((entry) => entry.count > 0);
  const sections = byTopic(paged);

  /** 当前范围里，某道之后的下一道未答的；到末尾就绕回第一道。 */
  const nextOpenAfter = useCallback(
    (id: string): string | null => {
      if (openCards.length <= 1) return null;
      const index = openCards.findIndex((item) => item.id === id);
      return openCards[(index + 1) % openCards.length]?.id ?? null;
    },
    [openCards],
  );

  /** 下一道若不在已加载的页里，需要的页码（从 1 起）。 */
  const pageOf = useCallback(
    (id: string): number => {
      const index = visible.findIndex((item) => item.id === id);
      return index < 0 ? 1 : Math.floor(index / PAGE_SIZE) + 1;
    },
    [visible],
  );

  const registerCard = useCallback(
    (id: string, node: HTMLElement | null): void => {
      if (node) cardsRef.current.set(id, node);
      else cardsRef.current.delete(id);
    },
    [],
  );
  const registerHandle = useCallback(
    (id: string, handle: QuestionCardHandle | null): void => {
      if (handle) handlesRef.current.set(id, handle);
      else handlesRef.current.delete(id);
    },
    [],
  );

  const submit = useCallback(
    (item: ConfirmationItem, draft: Draft): void => {
      if (busy !== null || !isAnswered(draft)) return;
      // 答完去哪儿：没答的卡去下一道；改的是已答复/已处理的卡，去当前范围第一道未答的。
      const next =
        item.group === 'pending'
          ? nextOpenAfter(item.id)
          : (openCards[0]?.id ?? null);
      const neededPage = next ? pageOf(next) : 1;
      setBusy(item.id);
      setSubmitFailed(false);
      // 「其他（自己写）」按固定的 OTHER 选项提交，自写内容进备注，仍满足单选校验。
      const { answer, note } = answerPayload(item, draft);
      void api
        .request<{ data: ConfirmationSnapshot }>({
          path: `/dev/confirmations/${item.id}/answers`,
          method: 'POST',
          json: { answer, note },
        })
        .then((body) => {
          // 端点返回提交后的整份快照，直接用它，不再多发一次读取。
          setSnapshot(body.data);
          setRecent((current) => new Set(current).add(item.id));
          setEditing(null);
          setBusy(null);
          toaster.show({
            type: 'success',
            title: t('devTools.confirmations.submitted', { id: item.id }),
          });
          // 下一道还没挂载就先加载它所在的页，等它出现再聚焦。
          setPage((current) => Math.max(current, neededPage));
          setFocusTarget(
            next ? { kind: 'card', id: next } : { kind: 'end', id: item.id },
          );
        })
        .catch(() => {
          setBusy(null);
          setSubmitFailed(true);
        });
    },
    [api, busy, nextOpenAfter, openCards, pageOf, toaster, t],
  );

  const skipToNext = useCallback(
    (item: ConfirmationItem): void => {
      const next = nextOpenAfter(item.id);
      if (!next) return;
      setPage((current) => Math.max(current, pageOf(next)));
      setFocusTarget({ kind: 'card', id: next });
    },
    [nextOpenAfter, pageOf],
  );

  /** 追加一条补充说明请求：端点回整份快照，这道题随即进「等补充」。 */
  const clarify = useCallback(
    (item: ConfirmationItem, note: string): void => {
      if (busy !== null) return;
      setBusy(item.id);
      setClarifyFailed(false);
      void api
        .request<{ data: ConfirmationSnapshot }>({
          path: `/dev/confirmations/${item.id}/clarifications`,
          method: 'POST',
          json: { note },
        })
        .then((body) => {
          setSnapshot(body.data);
          setBusy(null);
          toaster.show({
            type: 'success',
            title: t('devTools.confirmations.clarifySent', { id: item.id }),
          });
        })
        .catch(() => {
          setBusy(null);
          setClarifyFailed(true);
        });
    },
    [api, busy, toaster, t],
  );

  /** 数字键 1–9 选中当前这道卡的第 N 块磁贴；Ctrl/⌘+Enter 提交它。 */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null;
    const cardId =
      target
        ?.closest?.('[data-question-card]')
        ?.getAttribute('data-question-card') ??
      activeId ??
      cards[0]?.id;
    if (!cardId) return;
    const handle = handlesRef.current.get(cardId);
    if (!handle) return;
    const item = visible.find((candidate) => candidate.id === cardId);
    if (!item) return;
    const command = event.ctrlKey || event.metaKey;
    if (event.key === 'Enter' && command && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(item, handle.getDraft());
      return;
    }
    if (command || event.altKey || target?.closest?.(TEXT_INPUT)) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
    event.preventDefault();
    handle.pick(digit - 1);
  };

  if (failed) {
    return (
      <PageContainer>
        <p role='alert'>{t('devTools.confirmations.loadFailed')}</p>
      </PageContainer>
    );
  }
  if (!snapshot) {
    return (
      <PageContainer>
        <p>{t('devTools.confirmations.loading')}</p>
      </PageContainer>
    );
  }

  const progressText = t('devTools.confirmations.progress', {
    answered,
    total,
  });
  const tiles = [
    {
      key: 'pending',
      label: t('devTools.confirmations.pending'),
      value: snapshot.counts.pending,
    },
    {
      key: 'awaiting',
      label: t('devTools.confirmations.awaiting'),
      value: awaitingCount(snapshot),
    },
    {
      key: 'answered',
      label: t('devTools.confirmations.answered'),
      value: snapshot.counts.answered,
    },
    {
      key: 'processed',
      label: t('devTools.confirmations.processed'),
      value: snapshot.counts.processed,
    },
  ] as const;
  const nothingLeftInView = status === 'pending' && openCards.length === 0;

  return (
    <PageContainer
      onKeyDown={onKeyDown}
      data-testid='confirmations-page'
      className='mx-auto max-w-5xl'
    >
      <PageHeader
        title={t('devTools.confirmations.title')}
        description={t('devTools.confirmations.explain')}
        actions={
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
            <span
              className='inline-flex items-center gap-1'
              data-testid='shortcut-pick'
            >
              <Kbd>1–9</Kbd>
              {t('devTools.confirmations.pickHint')}
            </span>
            <span
              className='inline-flex items-center gap-1'
              data-testid='shortcut-submit'
            >
              <Kbd>Ctrl / ⌘</Kbd>
              <Kbd>Enter</Kbd>
              {t('devTools.confirmations.submitHint')}
            </span>
          </div>
        }
      />

      <div className='flex flex-col gap-4'>
        <Progress
          value={percent(answered, total)}
          aria-label={progressText}
          className='flex-col gap-2'
        >
          <ProgressLabel className='text-muted-foreground'>
            {progressText}
          </ProgressLabel>
        </Progress>
        <div className='grid grid-cols-2 gap-3 md:grid-cols-4'>
          {tiles.map((tile) => (
            <div
              key={tile.key}
              data-testid={`count-${tile.key}`}
              className='flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-4'
            >
              <span className='truncate text-xs text-muted-foreground'>
                {tile.label}
              </span>
              <span className='text-2xl font-semibold tabular-nums'>
                {tile.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className='flex flex-col gap-3'>
        <div
          className='flex flex-wrap gap-2'
          role='group'
          aria-label={t('devTools.confirmations.topicFilter')}
        >
          <Button
            type='button'
            size='sm'
            variant={topic === null ? 'secondary' : 'outline'}
            aria-pressed={topic === null}
            onClick={() => {
              setTopic(null);
              setPage(1);
            }}
          >
            {t('devTools.confirmations.all')}{' '}
            <span className='tabular-nums text-muted-foreground'>{total}</span>
          </Button>
          {chipTopics.map((entry) => (
            <Button
              key={entry.topic}
              type='button'
              size='sm'
              variant={topic === entry.topic ? 'secondary' : 'outline'}
              aria-pressed={topic === entry.topic}
              onClick={() => {
                setTopic(entry.topic);
                setPage(1);
              }}
            >
              {entry.topic}{' '}
              <span className='tabular-nums text-muted-foreground'>
                {entry.count}
              </span>
            </Button>
          ))}
        </div>
        <ToggleGroup
          value={[status]}
          onValueChange={(value) => {
            const next = value[0];
            if (
              next === 'pending' ||
              next === 'awaiting' ||
              next === 'answered' ||
              next === 'all'
            ) {
              setStatus(next);
              setPage(1);
            }
          }}
          aria-label={t('devTools.confirmations.statusFilter')}
        >
          {STATUS_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {t(option.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {submitFailed ? (
        <p role='alert'>{t('devTools.confirmations.submitFailed')}</p>
      ) : null}
      {clarifyFailed ? (
        <p role='alert'>{t('devTools.confirmations.clarifyFailed')}</p>
      ) : null}

      {/* 当前范围（整份清单或某个分组）刚答完：显示完成态；一进来就没有的，只说一句没有。 */}
      {nothingLeftInView &&
      (snapshot.counts.pending === 0 || rows.length > 0) ? (
        <AllDone left={snapshot.counts.pending} doneRef={doneRef} />
      ) : null}
      {nothingLeftInView && snapshot.counts.pending > 0 && rows.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('devTools.confirmations.noPendingInTopic')}
        </p>
      ) : null}
      {status === 'awaiting' && visible.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('devTools.confirmations.noAwaiting')}
        </p>
      ) : null}

      {sections.map((section) => {
        const entry = topics.find(
          (candidate) => candidate.topic === section.topic,
        );
        const sectionAnswered = entry?.answered ?? 0;
        const sectionTotal = entry?.total ?? 0;
        return (
          <Collapsible
            key={section.topic}
            defaultOpen
            data-testid={`topic-section-${section.topic}`}
            className='flex min-w-0 flex-col gap-3'
          >
            <div className='flex items-center gap-3'>
              <CollapsibleTrigger
                data-testid={`topic-toggle-${section.topic}`}
                className='group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50'
              >
                <ChevronRight
                  className='size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90'
                  aria-hidden='true'
                />
                <span className='truncate'>{section.topic}</span>{' '}
                <span className='truncate text-xs font-normal text-muted-foreground tabular-nums'>
                  {t('devTools.confirmations.sectionCount', {
                    shown: section.items.length,
                    answered: sectionAnswered,
                    total: sectionTotal,
                  })}
                </span>
              </CollapsibleTrigger>
              <Progress
                data-testid={`topic-progress-${section.topic}`}
                value={percent(sectionAnswered, sectionTotal)}
                aria-label={t('devTools.confirmations.sectionProgress', {
                  answered: sectionAnswered,
                  total: sectionTotal,
                })}
                className='w-24 shrink-0 flex-col gap-0'
              />
              <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                {sectionAnswered} / {sectionTotal}
              </span>
            </div>
            <CollapsibleContent className='flex min-w-0 flex-col gap-3'>
              {section.items.map((item) => {
                if (
                  item.group === 'pending' ||
                  item.group === 'awaiting' ||
                  editing === item.id
                ) {
                  return (
                    <QuestionCardSlot
                      key={item.id}
                      item={item}
                      busy={busy === item.id}
                      hasNext={
                        item.group === 'pending' &&
                        nextOpenAfter(item.id) !== null
                      }
                      registerCard={registerCard}
                      registerHandle={registerHandle}
                      onActivate={setActiveId}
                      submit={submit}
                      skipToNext={skipToNext}
                      clarify={clarify}
                    />
                  );
                }
                return (
                  <AnsweredRow
                    key={item.id}
                    item={item}
                    rowRef={(node) => {
                      if (node) rowsRef.current.set(item.id, node);
                      else rowsRef.current.delete(item.id);
                    }}
                    onEdit={() => setEditing(item.id)}
                  />
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        );
      })}

      {hasMore ? (
        <div className='flex flex-col items-center gap-2 border-t border-border pt-4'>
          <span className='text-xs text-muted-foreground tabular-nums'>
            {t('devTools.confirmations.showing', {
              shown: paged.length,
              total: visible.length,
            })}
          </span>
          <Button
            type='button'
            variant='outline'
            onClick={() => setPage((current) => current + 1)}
          >
            <ChevronDown data-icon='inline-start' />
            {t('devTools.confirmations.loadMore')}
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}
