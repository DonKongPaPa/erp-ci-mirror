import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { ChevronRight } from 'lucide-react';
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
 */

import {
  answeredCount,
  answerPayload,
  byTopic,
  choicesOf,
  emptyDraft,
  isAnswered,
  topicCounts,
  type ConfirmationItem,
  type ConfirmationSnapshot,
  type Draft,
} from './model.js';
import { AllDone, AnsweredRow, QuestionCard } from './question-card.js';
import { Progress, ProgressLabel } from './progress.js';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.js';

type StatusFilter = 'pending' | 'answered' | 'all';

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
  { value: 'answered', label: 'devTools.confirmations.answered' },
  { value: 'all', label: 'devTools.confirmations.all' },
];

/** 文字输入控件里的按键不当作快捷键（输入框里按数字不算选选项）。 */
const TEXT_INPUT = 'input, textarea, select, [contenteditable=true]';

function percent(answered: number, total: number): number {
  return total === 0 ? 0 : Math.round((answered / total) * 100);
}

export default function ConfirmationsPage(): ReactElement {
  const api = useApiClient();
  const toaster = useToaster();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ConfirmationSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [topic, setTopic] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  // 本次打开页面后答过的：在「待确认」里留在原位收成一行，刷新后归到「已答复」。
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cardsRef = useRef(new Map<string, HTMLElement>());
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

  /** 答完或跳过之后，把焦点交给下一道卡并滚过去（jsdom 没有 scrollIntoView，所以先判有再调）。 */
  /**
   * 答完或跳过之后，把焦点交给目标并滚过去：下一道未答的卡；到了末尾交给完成态，
   * 这个范围没有完成态就交给刚答完的那一行（刚提交的卡已经从页面上拿掉，
   * 不接住的话焦点会掉回 body）。jsdom 没有 scrollIntoView，所以先判有再调。
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
  }, [focusTarget, snapshot]);

  const answered = answeredCount(snapshot);
  const total = snapshot?.questions.length ?? 0;
  // 「待确认」里本次答过的也列出来（收成一行），其余状态只列当前状态自己的；保持清单的次序。
  const scoped = useMemo(() => {
    const all = snapshot?.questions ?? [];
    return all.filter((item) =>
      status === 'all'
        ? true
        : status === 'pending'
          ? item.group === 'pending' || recent.has(item.id)
          : item.group !== 'pending',
    );
  }, [snapshot, status, recent]);
  const visible = useMemo(
    () =>
      topic === null ? scoped : scoped.filter((item) => item.topic === topic),
    [scoped, topic],
  );
  const openCards = useMemo(
    () => visible.filter((item) => item.group === 'pending'),
    [visible],
  );
  // 画面上展开成卡的：没答的，加上正在「改」的那一道（它可能是已答复或已处理）。
  const cards = useMemo(
    () =>
      visible.filter((item) => item.group === 'pending' || editing === item.id),
    [visible, editing],
  );
  // 答过的收成一行；「待确认」里只列本次答过的，其余状态列全部。
  const rows = useMemo(
    () =>
      visible.filter(
        (item) =>
          item.group !== 'pending' &&
          (status !== 'pending' || recent.has(item.id)),
      ),
    [visible, status, recent],
  );
  const topics = topicCounts(snapshot);
  const chipTopics = topics
    .map((entry) => ({
      topic: entry.topic,
      // 芯片的计数口径与页头「共 N」一致：都算未关闭的全部问题，不分状态。
      count: entry.total,
    }))
    .filter((entry) => entry.count > 0);
  const sections = byTopic(visible);

  /** 当前范围里，某道之后的下一道未答的；到末尾就绕回第一道。 */
  const nextOpenAfter = (id: string): string | null => {
    if (openCards.length <= 1) return null;
    const index = openCards.findIndex((item) => item.id === id);
    return openCards[(index + 1) % openCards.length]?.id ?? null;
  };

  const submit = (item: ConfirmationItem): void => {
    const draft = drafts[item.id] ?? emptyDraft;
    if (busy !== null || !isAnswered(draft)) return;
    // 答完去哪儿：没答的卡去下一道；改的是已答复/已处理的卡，去当前范围第一道未答的。
    const next =
      item.group === 'pending'
        ? nextOpenAfter(item.id)
        : (openCards[0]?.id ?? null);
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
        setDrafts((current) => ({ ...current, [item.id]: emptyDraft }));
        setRecent((current) => new Set(current).add(item.id));
        setEditing(null);
        setBusy(null);
        toaster.show({
          type: 'success',
          title: t('devTools.confirmations.submitted', { id: item.id }),
        });
        setFocusTarget(
          next ? { kind: 'card', id: next } : { kind: 'end', id: item.id },
        );
      })
      .catch(() => {
        setBusy(null);
        setSubmitFailed(true);
      });
  };

  const pick = (item: ConfirmationItem, index: number): void => {
    const choice = choicesOf(item)[index];
    if (!choice) return;
    setDrafts((current) => ({
      ...current,
      [item.id]: { ...(current[item.id] ?? emptyDraft), answer: choice.value },
    }));
  };

  /** 数字键 1–9 选中当前这道卡的第 N 块磁贴；Ctrl/⌘+Enter 提交它。 */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null;
    const cardId =
      target
        ?.closest?.('[data-question-card]')
        ?.getAttribute('data-question-card') ??
      activeId ??
      cards[0]?.id;
    // 在展开的卡里找（包括正在「改」的已答复 / 已处理条目），不限没答的。
    const item = cards.find((candidate) => candidate.id === cardId);
    if (!item) return;
    const command = event.ctrlKey || event.metaKey;
    if (event.key === 'Enter' && command && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(item);
      return;
    }
    if (command || event.altKey || target?.closest?.(TEXT_INPUT)) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
    event.preventDefault();
    pick(item, digit - 1);
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
        <div className='grid grid-cols-3 gap-3'>
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
            onClick={() => setTopic(null)}
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
              onClick={() => setTopic(entry.topic)}
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
            if (next === 'pending' || next === 'answered' || next === 'all')
              setStatus(next);
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
                if (item.group === 'pending' || editing === item.id) {
                  return (
                    <QuestionCard
                      key={item.id}
                      item={item}
                      draft={drafts[item.id] ?? emptyDraft}
                      busy={busy === item.id}
                      hasNext={
                        item.group === 'pending' &&
                        nextOpenAfter(item.id) !== null
                      }
                      cardRef={(node) => {
                        if (node) cardsRef.current.set(item.id, node);
                        else cardsRef.current.delete(item.id);
                      }}
                      onActivate={setActiveId}
                      onChange={(draft) =>
                        setDrafts((current) => ({
                          ...current,
                          [item.id]: draft,
                        }))
                      }
                      onSubmit={() => submit(item)}
                      onSkip={() => {
                        const next = nextOpenAfter(item.id);
                        if (next) setFocusTarget({ kind: 'card', id: next });
                      }}
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
    </PageContainer>
  );
}
