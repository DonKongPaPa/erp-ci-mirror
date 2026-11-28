import { Check, CircleCheck, Info, Pencil } from 'lucide-react';
import { cn } from 'cn';
import { useTranslation } from '@nocobase/i18n/client';
import {
  memo,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type Ref,
  type RefObject,
} from 'react';

import { StatusBadge } from '#components/status-badge';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '#components/ui/field';
import { Kbd } from '#components/ui/kbd';
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group';
import { Textarea } from '#components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#components/ui/tooltip';

import {
  OTHER,
  choicesOf,
  emptyDraft,
  explanationBlocks,
  firstSentence,
  hasExplanation,
  toneOf,
  type Choice,
  type ConfirmationItem,
  type Draft,
  type Explanation,
  isAnswered,
  type TopicTone,
} from './model.js';
import { noteCardRender } from './perf.js';

/**
 * 待确认事项页的三块：没答的问题卡（选项磁贴 + 输入框 + 操作行）、答过的收成一行、带计数的编号徽章。
 * 选项磁贴照 shadcn 官方示例 `field-choice-card` 的结构写（FieldLabel 包 Field，里面放
 * RadioGroupItem 与文字），选中的描边、底色用 FieldLabel 自带的 `has-data-checked`；
 * 单选原语本身只留读屏与焦点（`sr-only`），选中态靠边框、底色与对勾表达。
 *
 * R-083 性能：草稿（选中的选项与「自己写」的文字）归卡片自己持有，页面上不放它的 state。
 * 这样打字只重渲染这一张卡；页面通过下面的命令式句柄在提交时读当前草稿，数字键也经它选磁贴。
 */

const STATUS_LABEL: Readonly<Record<string, string>> = {
  landed: 'devTools.confirmations.landed',
  followup: 'devTools.confirmations.followup',
  withdrawn: 'devTools.confirmations.withdrawn',
};
const STATUS_TONE: Readonly<Record<string, TopicTone>> = {
  landed: 'success',
  followup: 'warning',
  withdrawn: 'neutral',
};

/** 页面对一张卡的两个动作：数字键选磁贴、提交时读草稿。 */
export interface QuestionCardHandle {
  readonly pick: (index: number) => void;
  readonly getDraft: () => Draft;
}

export interface QuestionCardProps {
  readonly item: ConfirmationItem;
  readonly busy: boolean;
  /** 当前范围里答完还有下一道：按钮写「提交并看下一条」。 */
  readonly hasNext: boolean;
  readonly cardRef: (node: HTMLElement | null) => void;
  readonly onActivate: (id: string) => void;
  readonly onSubmit: () => void;
  readonly onSkip: () => void;
  /** 发出一条补充说明请求；note 可空，页面负责 POST 与刷新快照。 */
  readonly onClarify: (note: string) => void;
  /** React 19 的 ref 当普通 prop 传；页面据此在提交时读草稿、数字键选磁贴。 */
  readonly ref?: Ref<QuestionCardHandle>;
}

export function SourceLink({
  item,
}: {
  readonly item: ConfirmationItem;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <Tooltip>
        {/* eslint-disable jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- 文字是 TooltipTrigger 的子节点、由它合并到锚点上，规则看不到合并后的内容 */}
        <TooltipTrigger
          render={
            <a
              className='rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
              href={`https://github.com/DonKongPaPa/acme-erp-project/blob/main/${item.source}`}
              target='_blank'
              rel='noreferrer'
            />
          }
        >
          {t('devTools.confirmations.source')}
        </TooltipTrigger>
        {/* eslint-enable jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label */}
        <TooltipContent>{item.source}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DefaultHint({ text }: { readonly text: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <p className='flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm break-words'>
      <Info
        className='mt-0.5 size-4 shrink-0 text-muted-foreground'
        aria-hidden='true'
      />
      <span className='min-w-0 text-muted-foreground'>
        {t('devTools.confirmations.default', { default: text })}
      </span>
    </p>
  );
}

function ChoiceTile({
  choice,
  item,
  index,
  groupId,
}: {
  readonly choice: Choice;
  readonly item: ConfirmationItem;
  readonly index: number;
  readonly groupId: string;
}): ReactElement {
  const { t } = useTranslation();
  const id = `${groupId}-${index}`;
  const label = choice.isOther
    ? t('devTools.confirmations.other')
    : choice.isTakeDefault
      ? t('devTools.confirmations.takeDefault')
      : choice.label;
  return (
    <FieldLabel
      htmlFor={id}
      className='*:data-[slot=field]:p-3 has-data-checked:border-primary has-data-checked:bg-primary/5'
    >
      <Field orientation='horizontal'>
        {/* 单选原语只留读屏与键盘焦点；圆点不画，选中看边框、底色和对勾。 */}
        <RadioGroupItem id={id} value={choice.value} className='sr-only' />
        <FieldContent className='gap-0.5'>
          <FieldTitle className='font-normal break-words'>
            {label}
            {choice.isDefault ? (
              <Badge variant='secondary' className='ms-2'>
                {t('devTools.confirmations.defaultBadge')}
              </Badge>
            ) : null}
          </FieldTitle>
          {choice.isTakeDefault ? (
            <FieldDescription className='break-words'>
              {firstSentence(item.default)}
            </FieldDescription>
          ) : null}
        </FieldContent>
        <Check
          aria-hidden='true'
          className='size-4 shrink-0 text-primary opacity-0 peer-aria-checked:opacity-100'
        />
        {index < 9 ? (
          <Kbd data-testid='tile-key' className='ms-auto'>
            {index + 1}
          </Kbd>
        ) : null}
      </Field>
    </FieldLabel>
  );
}

/** 一行里会被省略的文字：悬停看全文（第一行是它自己，后面是细节）。 */
function Overflow({
  lines,
  className,
  testId,
}: {
  readonly lines: readonly string[];
  readonly className?: string;
  readonly testId: string;
}): ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid={testId}
              className={cn('min-w-0 truncate', className)}
            />
          }
        >
          {lines[0]}
        </TooltipTrigger>
        <TooltipContent className='max-w-sm flex-col items-start text-left whitespace-pre-line'>
          {lines.join('\n')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** 一条说明：时刻 + 多段纯文本。空行分段，「- 」开头的连续行收成列表，HTML 原样当文字。 */
function ExplanationView({
  explanation,
}: {
  readonly explanation: Explanation;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      data-testid='explanation-block'
      className='flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3'
    >
      <p className='text-xs text-muted-foreground'>
        {t('devTools.confirmations.explanationAt', { at: explanation.at })}
      </p>
      {explanationBlocks(explanation.text).map((block) =>
        block.kind === 'list' ? (
          <ul
            key={`list:${block.items.join('\n')}`}
            className='ms-4 list-disc break-words text-sm'
          >
            {block.items.map((item) => (
              <li key={item} className='break-words'>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p
            key={`para:${block.text}`}
            className='whitespace-pre-line break-words text-sm'
          >
            {block.text}
          </p>
        ),
      )}
    </div>
  );
}

/** 等补充的卡：留着题与出处，显示请求历史（新的在上）与说明空位，不给提交通道。 */
function AwaitingCard({
  item,
  cardRef,
  onActivate,
}: {
  readonly item: ConfirmationItem;
  readonly cardRef: (node: HTMLElement | null) => void;
  readonly onActivate: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const history = [...item.clarifications].reverse();
  return (
    <article
      ref={cardRef}
      data-testid={`awaiting-${item.id}`}
      data-question-card={item.id}
      tabIndex={-1}
      onFocus={() => onActivate(item.id)}
      className='flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
    >
      <div className='flex items-start gap-3'>
        <StatusBadge
          tone={toneOf(item.topic)}
          size='sm'
          className='mt-0.5 shrink-0'
        >
          {item.id}
        </StatusBadge>
        <h3 className='min-w-0 max-w-3xl flex-1 text-base font-semibold break-words'>
          {item.question}
        </h3>
        <SourceLink item={item} />
      </div>
      <div data-testid={`clarify-history-${item.id}`} className='flex flex-col gap-1'>
        {history.map((entry) => (
          <p key={`${entry.at}-${entry.note}`} className='text-sm text-muted-foreground'>
            {t('devTools.confirmations.awaitingLabel', {
              at: entry.at,
              note:
                entry.note.length > 0
                  ? entry.note
                  : t('devTools.confirmations.noClarifyNote'),
            })}
          </p>
        ))}
      </div>
      <div
        data-testid={`explanation-placeholder-${item.id}`}
        className='rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground'
      >
        {t('devTools.confirmations.awaitingPlaceholder')}
      </div>
    </article>
  );
}

function QuestionCardBase({
  item,
  busy,
  hasNext,
  cardRef,
  onActivate,
  onSubmit,
  onSkip,
  onClarify,
  ref,
}: QuestionCardProps): ReactElement {
  noteCardRender(item.id);
  const { t } = useTranslation();
  const groupId = useId();
  // 草稿只在这张卡里：打字重渲染止于本卡，页面不参与。
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const draftRef = useRef(draft);
  const change = useCallback((next: Draft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      pick(index: number) {
        const choice = choicesOf(item)[index];
        if (!choice) return;
        change({ ...draftRef.current, answer: choice.value });
      },
      getDraft: () => draftRef.current,
    }),
    [item, change],
  );
  const choices = choicesOf(item);
  const usingOther = draft.answer === OTHER;
  const pending = item.group === 'pending';
  // 补充请求的草稿同样只在这张卡里，打字不惊动页面；发出后收起并清空。
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [clarifyNote, setClarifyNote] = useState('');
  const sendClarify = (): void => {
    onClarify(clarifyNote);
    setClarifyOpen(false);
    setClarifyNote('');
  };

  if (item.group === 'awaiting')
    return (
      <AwaitingCard item={item} cardRef={cardRef} onActivate={onActivate} />
    );

  return (
    <article
      ref={cardRef}
      data-testid={pending ? `pending-${item.id}` : `editing-${item.id}`}
      data-question-card={item.id}
      tabIndex={-1}
      onFocus={() => onActivate(item.id)}
      className='flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
    >
      <div className='flex items-start gap-3'>
        <StatusBadge
          tone={toneOf(item.topic)}
          size='sm'
          className='mt-0.5 shrink-0'
        >
          {item.id}
        </StatusBadge>
        {hasExplanation(item) ? (
          <Badge variant='secondary' className='mt-0.5 shrink-0'>
            {t('devTools.confirmations.explainedBadge')}
          </Badge>
        ) : null}
        <h3 className='min-w-0 max-w-3xl flex-1 text-base font-semibold break-words'>
          {item.question}
        </h3>
        <SourceLink item={item} />
      </div>
      {item.explanations.map((explanation) => (
        <ExplanationView
          key={`${explanation.at}-${explanation.text}`}
          explanation={explanation}
        />
      ))}
      <DefaultHint text={item.default} />

      {clarifyOpen && pending ? (
        <div
          data-testid={`clarify-form-${item.id}`}
          className='flex flex-col gap-2 rounded-lg border border-border p-3'
        >
          <Textarea
            aria-label={t('devTools.confirmations.clarifyPlaceholder')}
            placeholder={t('devTools.confirmations.clarifyPlaceholder')}
            rows={2}
            value={clarifyNote}
            onChange={(event) => setClarifyNote(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                // 这里的 Ctrl/⌘+Enter 发补充请求，不是提交答复；别冒泡到页面。
                event.preventDefault();
                event.stopPropagation();
                sendClarify();
              }
            }}
          />
          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              disabled={busy}
              onClick={sendClarify}
            >
              {t('devTools.confirmations.clarifySend')}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        className='flex flex-col gap-3'
        data-testid={`answer-form-${item.id}`}
      >
        {choices.length > 0 ? (
          <RadioGroup
            value={draft.answer}
            onValueChange={(value: unknown) =>
              change({
                ...draftRef.current,
                answer: typeof value === 'string' ? value : '',
              })
            }
            aria-label={t('devTools.confirmations.yourAnswer')}
            className='gap-3 xl:grid-cols-2'
          >
            {choices.map((choice, index) => (
              <ChoiceTile
                key={choice.value}
                choice={choice}
                item={item}
                index={index}
                groupId={groupId}
              />
            ))}
          </RadioGroup>
        ) : null}
        {usingOther ? (
          <Textarea
            aria-label={t('devTools.confirmations.yourAnswer')}
            placeholder={t('devTools.confirmations.writeHint')}
            rows={2}
            value={draft.note}
            onChange={(event) =>
              change({ ...draftRef.current, note: event.target.value })
            }
          />
        ) : null}
        <div className='flex justify-end gap-2'>
          {pending ? (
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              onClick={onSkip}
            >
              {t('devTools.confirmations.skip')}
            </Button>
          ) : null}
          {pending ? (
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              aria-expanded={clarifyOpen}
              onClick={() => setClarifyOpen((open) => !open)}
            >
              {t('devTools.confirmations.askClarify')}
            </Button>
          ) : null}
          <Button
            type='button'
            disabled={busy || !isAnswered(draft)}
            onClick={onSubmit}
          >
            {busy
              ? t('devTools.confirmations.submitting')
              : t(
                  pending && hasNext
                    ? 'devTools.confirmations.submitNext'
                    : 'devTools.confirmations.submit',
                )}
          </Button>
        </div>
      </div>
    </article>
  );
}

export const QuestionCard = memo(QuestionCardBase);

/**
 * 答过的收成一行：编号、问题、已答内容（超出省略，悬停看全文与细节）、处理状态、行尾「改」。
 * 手机上拆成两行（问题一行、答复与「改」一行），宽屏上是一行。
 */
export function AnsweredRow({
  item,
  rowRef,
  onEdit,
}: {
  readonly item: ConfirmationItem;
  readonly rowRef: (node: HTMLElement | null) => void;
  readonly onEdit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const answer = item.latestAnswer;
  const details = [
    answer?.note
      ? t('devTools.confirmations.withNote', { note: answer.note })
      : '',
    item.processed
      ? t('devTools.confirmations.ref', { ref: item.processed.ref })
      : '',
    item.processed?.note ?? '',
    t('devTools.confirmations.answeredAt', { at: answer?.at ?? '' }),
  ].filter((line) => line.length > 0);
  return (
    <article
      ref={rowRef}
      tabIndex={-1}
      data-testid={`${item.group}-${item.id}`}
      className='flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-row sm:items-center sm:gap-3'
    >
      <StatusBadge tone={toneOf(item.topic)} size='sm' className='shrink-0'>
        {item.id}
      </StatusBadge>
      <Overflow
        testId='row-question'
        lines={[item.question]}
        className='flex-1 font-medium'
      />
      <Overflow
        testId='row-answer'
        lines={[
          `${answer?.answer ?? ''}${details[0] ?? ''}`,
          ...details.slice(1),
        ]}
        className='max-w-md text-muted-foreground'
      />
      {item.processed ? (
        <StatusBadge
          tone={STATUS_TONE[item.processed.status] ?? 'neutral'}
          size='sm'
          className='shrink-0'
        >
          {t(
            STATUS_LABEL[item.processed.status] ??
              'devTools.confirmations.landed',
          )}
        </StatusBadge>
      ) : null}
      <Button
        type='button'
        variant='outline'
        size='sm'
        className='sm:ms-auto'
        onClick={onEdit}
      >
        <Pencil data-icon='inline-start' />
        {t('devTools.confirmations.edit')}
      </Button>
    </article>
  );
}

export function AllDone({
  left,
  doneRef,
}: {
  readonly left: number;
  readonly doneRef: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Empty
      ref={doneRef}
      tabIndex={-1}
      data-testid='all-done'
      className='border py-10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
    >
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <CircleCheck className='size-4 text-primary' aria-hidden='true' />
        </EmptyMedia>
        <EmptyTitle>{t('devTools.confirmations.allDone')}</EmptyTitle>
        <EmptyDescription>
          {t('devTools.confirmations.leftToDefault', { count: left })}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
