import { useApiClient, useSubmission, useToaster } from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangle,
  Check,
  Inbox,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Input } from '#components/ui/input';
import { Skeleton } from '#components/ui/skeleton';
import { Textarea } from '#components/ui/textarea';

import {
  QualityClient,
  type QualityDraftingStats,
  type QualityMessage,
  type QualityScreening,
  type QualityScreeningReview,
  type QualityTicket,
} from './client.js';

type Tone = 'neutral' | 'info' | 'warning' | 'success';

function severityTone(severity: string | null): Tone {
  switch (severity) {
    case 'critical':
      return 'warning';
    case 'major':
      return 'warning';
    case 'minor':
      return 'neutral';
    default:
      return 'info';
  }
}

function outcomeTone(outcome: string): Tone {
  if (outcome === 'auto') return 'success';
  if (outcome === 'needs-review') return 'warning';
  if (outcome === 'reviewed') return 'info';
  return 'neutral';
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * 客户端解析不出知识文档的标题，显示引用里能拿到的标识（`kb:` 后面的部分）；
 * 解析不出（引用不带前缀或前缀后为空）就原样显示。
 */
function knowledgeRefLabel(ref: string): string {
  return ref.startsWith('kb:') && ref.length > 'kb:'.length
    ? ref.slice('kb:'.length)
    : ref;
}

const FQC_RESOURCE = { type: 'composite', id: 'fqc' } as const;

/** 质量工单看板：左侧统计与投递，右侧工单列表与初筛明细。 */
export default function QualityPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new QualityClient(api), [api]);
  const { session } = useAuthentication();

  // 按钮按权限显隐。等待权限结果期间 `can` 是 false，所以按钮先不显示、后出现，
  // 不会先闪一下再消失。等待期用占位顶住同样的高度，免得下面的卡片被顶下去。
  const intakeAccess = useCan({ resource: FQC_RESOURCE, action: 'intake' });
  const handleAccess = useCan({ resource: FQC_RESOURCE, action: 'handle' });
  // 投递的提交状态每身份一份，幂等键由钩子生成；scope 不与他人共享。
  const intakeSubmission = useSubmission({
    scope: `${session?.user.id}:quality:intake`,
  });

  const [tickets, setTickets] = useState<QualityTicket[]>([]);
  const [messages, setMessages] = useState<QualityMessage[]>([]);
  const [screenings, setScreenings] = useState<QualityScreening[]>([]);
  // R-002 的「代填效果」与确认记录：统计是只读的汇总数字；列表已确认的行随行带
  // 最近一次确认。本地这份只用来让「确认之后当场显示」不等重取，重取后以列表为准。
  const [draftStats, setDraftStats] = useState<QualityDraftingStats>();
  const [statsError, setStatsError] = useState<string>();
  const [statsReloadToken, setStatsReloadToken] = useState(0);
  const [reviews, setReviews] = useState<Record<string, QualityScreeningReview>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [sender, setSender] = useState(() => t('quality.intake.defaultSender'));
  const [reloadToken, setReloadToken] = useState(0);

  const fetchAll = useCallback(async () => {
    const [ticketResult, messageResult, screeningResult] = await Promise.all([
      client.listTickets({ pageSize: 50 }),
      client.listMessages(),
      client.listScreenings(),
    ]);
    return {
      tickets: ticketResult.items,
      messages: messageResult.items,
      screenings: screeningResult.items,
    };
  }, [client]);

  const fetchStats = useCallback(async () => {
    const to = new Date();
    // 端点允许的最大跨度是 365 天：页面固定取最近一年，存量数据也进得了对照。
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    return client.draftingStats({
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }, [client]);

  useEffect(() => {
    let active = true;
    fetchAll().then(
      (data) => {
        if (!active) return;
        setTickets(data.tickets);
        setMessages(data.messages);
        setScreenings(data.screenings);
        // 列表带回的确认记录是新的；本会话刚确认时暂存的那一列到此让位，
        // 免得别人后来再确认时页面一直显示旧的那一行。
        setReviews({});
        setError(undefined);
        setLoading(false);
      },
      (next: unknown) => {
        if (!active) return;
        setError(next instanceof Error ? next.message : String(next));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [fetchAll, reloadToken]);

  useEffect(() => {
    let active = true;
    fetchStats().then(
      (next) => {
        if (!active) return;
        setDraftStats(next);
        setStatsError(undefined);
      },
      (next: unknown) => {
        if (!active) return;
        // 有上一轮的数字就继续显示它们，但失败要亮在卡片上（stale 提示），
        // 不能让旧数字悄悄装成当前值；一个数字都没有才显示整卡的读取失败。
        setStatsError(next instanceof Error ? next.message : String(next));
      },
    );
    return () => {
      active = false;
    };
  }, [fetchStats, reloadToken, statsReloadToken]);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((value) => value + 1);
  }, []);

  /** 只重取统计：卡片上「重试」的入口，不牵动整页的刷新。 */
  const retryStats = useCallback(() => {
    setStatsReloadToken((value) => value + 1);
  }, []);

  /** 确认成功：把响应里的确认记录按初筛 id 收好，再刷新列表。 */
  const handleReviewed = useCallback(
    (screeningId: string, review?: QualityScreeningReview | null) => {
      if (review) {
        setReviews((previous) => ({ ...previous, [screeningId]: review }));
      }
      refresh();
    },
    [refresh],
  );

  const submit = async () => {
    const content = draft.trim();
    if (!content || intakeSubmission.submitting || intakeSubmission.pending) {
      return;
    }
    try {
      // 幂等键由 useSubmission 生成；返回 undefined 表示已有一个提交在途，
      // 忽略这次点击，不提示失败。超时会抛 SubmissionTimeoutError，钩子保留原操作
      // 供重试，页面按普通失败提示即可。
      const result = await intakeSubmission.run(
        { channel: 'wechat', senderName: sender.trim() || undefined, content },
        (idempotencyKey, _signal, snapshot) =>
          client.intake(snapshot, idempotencyKey),
      );
      if (!result) return;
      toaster.show({
        type: 'success',
        title: t('quality.intake.created', { code: result.ticket.code }),
        description: `${t(
          `quality.categories.${result.screening.category ?? 'other'}`,
          {
            defaultValue:
              result.screening.category ?? t('quality.uncategorized'),
          },
        )} / ${t(`quality.severities.${result.screening.severity ?? 'info'}`, {
          defaultValue: result.screening.severity ?? '-',
        })}`,
      });
      setDraft('');
      refresh();
    } catch (next) {
      toaster.show({
        type: 'error',
        title: t('quality.intake.failed'),
        description: next instanceof Error ? next.message : String(next),
      });
    }
  };

  const stats = useMemo(() => {
    const open = tickets.filter((ticket) => ticket.state === 'open').length;
    const critical = tickets.filter(
      (ticket) => ticket.severity === 'critical',
    ).length;
    const review = screenings.filter(
      (item) => item.outcome === 'needs-review',
    ).length;
    return { open, critical, review, total: tickets.length };
  }, [tickets, screenings]);

  const byDepartment = useMemo(() => {
    const map = new Map<string, number>();
    for (const ticket of tickets) {
      const key = ticket.ownerDepartment ?? 'unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [tickets]);

  return (
    <PageContainer>
      <PageHeader
        title={t('navigation.quality')}
        description={t('quality.page.description')}
        eyebrow={t('quality.page.eyebrow')}
        actions={
          <Button
            variant='outline'
            size='sm'
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw
              data-icon='inline-start'
              className={loading ? 'animate-spin' : undefined}
            />
            {t('quality.page.refresh')}
          </Button>
        }
      />

      {error ? (
        <Card className='border-destructive/40'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <AlertTriangle className='size-4' />
              {t('quality.page.loadFailed')}
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard label={t('quality.stats.total')} value={stats.total} />
        <StatCard
          label={t('quality.stats.open')}
          value={stats.open}
          tone='info'
        />
        <StatCard
          label={t('quality.stats.critical')}
          value={stats.critical}
          tone='warning'
        />
        <StatCard
          label={t('quality.stats.review')}
          value={stats.review}
          tone='warning'
        />
      </div>

      <div className='grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]'>
        <div className='flex flex-col gap-4'>
          {/* 四个业务角色都不持有「投递」，业务用户默认看不到这个表单。权限没回来
              之前不占位：给大多数人（无投递）先占一块再塌掉，会把「部门分流」
              「代填效果」顶得上下跳（界面点验 2026-11-26，首屏上移 302px）。持有
              「投递」的人在权限回来时看到表单插入到这一格。 */}
          {intakeAccess.can ? (
            <Card data-testid='intake-form' className='min-h-80'>
              <CardHeader>
                <CardTitle className='flex items-center gap-2 text-sm'>
                  <Send className='size-4' />
                  {t('quality.intake.title')}
                </CardTitle>
                <CardDescription>
                  {t('quality.intake.description')}
                </CardDescription>
              </CardHeader>
              <CardContent className='flex flex-col gap-3'>
                {intakeSubmission.pending ? (
                  <Alert
                    variant='destructive'
                    data-testid='intake-outcome-unknown'
                  >
                    <AlertTriangle className='size-4' />
                    <AlertDescription className='flex flex-col items-start gap-2'>
                      <p>{t('quality.intake.outcomeUnknown')}</p>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => {
                          // 钩子清掉 pending 后不会自己通知订阅者，借刷新列表再渲染
                          // 一次；列表也正是用户刚核对过的地方。
                          intakeSubmission.acknowledgeOutcome('not-committed');
                          refresh();
                        }}
                      >
                        {t('quality.intake.acknowledge')}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <Input
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  placeholder={t('quality.intake.senderPlaceholder')}
                />
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t('quality.intake.contentPlaceholder')}
                  rows={4}
                  className='resize-y'
                />
                <Button
                  onClick={() => void submit()}
                  disabled={
                    !draft.trim() ||
                    intakeSubmission.submitting ||
                    intakeSubmission.pending
                  }
                >
                  {intakeSubmission.submitting ? (
                    <Loader2
                      data-icon='inline-start'
                      className='animate-spin'
                    />
                  ) : (
                    <Sparkles data-icon='inline-start' />
                  )}
                  {t('quality.intake.submit')}
                </Button>
              </CardContent>
            </Card>
          ) : intakeAccess.isPending ? null : intakeAccess.error ? (
            <Alert variant='destructive' data-testid='intake-permission-error'>
              <AlertTriangle className='size-4' />
              <AlertDescription>
                {t('quality.permissionFailed')}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className='text-sm'>
                {t('quality.department.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className='flex flex-col gap-2'>
              {byDepartment.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {t('quality.empty')}
                </p>
              ) : (
                byDepartment.map(([department, count]) => (
                  <div
                    key={department}
                    className='flex items-center justify-between text-sm'
                  >
                    <span className='font-mono text-xs text-muted-foreground'>
                      {department}
                    </span>
                    <span className='tabular-nums'>{count}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <DraftingOutcomesCard
            stats={draftStats}
            error={statsError}
            onRetry={retryStats}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <Inbox className='size-4' />
              {t('quality.tickets.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.tickets.count', { count: tickets.length })}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            {loading && tickets.length === 0 ? (
              // 占位与真实列表同量级：加载时下方卡片不在视口内，数据到了也不会被
              // 一个约 5000 像素长的列表顶出去（首屏那一次 0.12 的位移）。
              <div
                data-testid='ticket-loading'
                aria-busy='true'
                className='min-h-96'
              >
                <div className='flex items-center gap-2 p-6 text-sm text-muted-foreground'>
                  <Loader2 className='size-4 animate-spin' />
                  {t('quality.loading')}
                </div>
                <div aria-hidden='true' className='divide-y divide-border'>
                  {Array.from({ length: 8 }, (_, index) => (
                    <div
                      key={index}
                      data-testid='ticket-loading-row'
                      className='flex flex-col gap-2 p-4'
                    >
                      <Skeleton className='h-5 w-2/3' />
                      <Skeleton className='h-4 w-full' />
                      <Skeleton className='h-4 w-1/2' />
                    </div>
                  ))}
                </div>
              </div>
            ) : tickets.length === 0 ? (
              <p className='p-6 text-sm text-muted-foreground'>
                {t('quality.tickets.empty')}
              </p>
            ) : (
              <ul className='divide-y divide-border'>
                {tickets.map((ticket) => (
                  <li key={ticket.id} className='flex flex-col gap-2 p-4'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-mono text-xs text-muted-foreground'>
                        {ticket.code}
                      </span>
                      <StatusBadge
                        tone={severityTone(ticket.severity)}
                        size='sm'
                      >
                        {t(`quality.severities.${ticket.severity}`, {
                          defaultValue: ticket.severity,
                        })}
                      </StatusBadge>
                      <StatusBadge tone='neutral' size='sm'>
                        {ticket.category
                          ? t(`quality.categories.${ticket.category}`, {
                              defaultValue: ticket.category,
                            })
                          : t('quality.uncategorized')}
                      </StatusBadge>
                      <span className='ml-auto text-xs text-muted-foreground'>
                        {formatTime(ticket.createdAt, locale)}
                      </span>
                    </div>
                    <p className='text-sm leading-6'>{ticket.description}</p>
                    <div className='flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
                      <span>
                        {t('quality.tickets.department', {
                          department:
                            ticket.ownerDepartment ?? t('quality.unassigned'),
                        })}
                      </span>
                      <span>
                        {t('quality.tickets.state', {
                          state: t(`quality.states.${ticket.state}`, {
                            defaultValue: ticket.state,
                          }),
                        })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm'>
              {t('quality.messages.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.messages.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            <ul className='divide-y divide-border'>
              {messages.slice(0, 10).map((message) => (
                <li key={message.id} className='flex flex-col gap-1 p-4'>
                  <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                    <span>
                      {message.senderName ??
                        t('quality.messages.unknownSender')}
                    </span>
                    <span>·</span>
                    <span>
                      {t(`quality.channels.${message.channel}`, {
                        defaultValue: message.channel,
                      })}
                    </span>
                    <span className='ml-auto'>
                      {formatTime(message.receivedAt, locale)}
                    </span>
                  </div>
                  <p className='text-sm leading-6'>{message.content}</p>
                </li>
              ))}
              {messages.length === 0 ? (
                <li className='p-4 text-sm text-muted-foreground'>
                  {t('quality.messages.empty')}
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='text-sm'>
              {t('quality.screenings.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.screenings.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            <ul className='divide-y divide-border'>
              {screenings.slice(0, 10).map((item) => (
                <ScreeningItem
                  key={item.id}
                  item={item}
                  review={reviews[item.id] ?? item.review}
                  canHandle={handleAccess.can}
                  handlePending={handleAccess.isPending}
                  handleError={Boolean(handleAccess.error)}
                  onReviewed={handleReviewed}
                />
              ))}
              {screenings.length === 0 ? (
                <li className='p-4 text-sm text-muted-foreground'>
                  {t('quality.screenings.empty')}
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

/**
 * 一条初筛。按钮的显示条件是「这一行的状态可以确认」（端点算好的 `canReview`）
 * 与「调用的人有处理权限」（页面的 useCan）都为真；只做「确认」，不做改判。
 *
 * 每行一份提交状态：scope 带初筛 id，幂等键由 useSubmission 管。
 * 出处（R-002）：这一行是「规则」还是「模型」出的，没跑模型或回落过的带着原因；
 * `knowledgeRefs` 里 `kb:` 的知识引用显示标识、`case:` 的相似案例只显示条数，
 * 不把案例的初筛标识渲染成能点开的链接（范围外的读者点了是 404）。
 * 确认之后草稿的这些值原样不动，下方追加「谁在何时确认成什么」。
 */
function ScreeningItem({
  item,
  review,
  canHandle,
  handlePending,
  handleError,
  onReviewed,
}: {
  readonly item: QualityScreening;
  /** 这一行最近一次确认的记录：列表随行带来的，或本会话刚确认的。 */
  readonly review?: QualityScreeningReview | null;
  readonly canHandle: boolean;
  readonly handlePending: boolean;
  readonly handleError: boolean;
  readonly onReviewed: (
    screeningId: string,
    review?: QualityScreeningReview | null,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const { session } = useAuthentication();
  const client = useMemo(() => new QualityClient(api), [api]);
  const submission = useSubmission({
    scope: `${session?.user.id}:quality:review:${item.id}`,
  });

  const knowledgeRefs = (item.knowledgeRefs ?? []).filter((ref) =>
    ref.startsWith('kb:'),
  );
  const similarCaseCount = (item.knowledgeRefs ?? []).filter((ref) =>
    ref.startsWith('case:'),
  ).length;
  const degradeLabel = item.degradeReason
    ? t(`quality.screenings.degrade.${item.degradeReason}`, {
        defaultValue: item.degradeReason,
      })
    : null;

  const confirm = async () => {
    if (submission.submitting) return;
    try {
      const updated = await submission.run({ screeningId: item.id }, () =>
        client.review(item.id),
      );
      if (!updated) return;
      toaster.show({ type: 'success', title: t('quality.review.saved') });
      onReviewed(item.id, updated.review);
    } catch (next) {
      toaster.show({
        type: 'error',
        title: t('quality.review.failed'),
        description: next instanceof Error ? next.message : String(next),
      });
    }
  };

  return (
    <li className='flex flex-col gap-1 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusBadge tone='neutral' size='sm'>
          {item.category
            ? t(`quality.categories.${item.category}`, {
                defaultValue: item.category,
              })
            : t('quality.uncategorized')}
        </StatusBadge>
        <StatusBadge tone={severityTone(item.severity)} size='sm'>
          {item.severity
            ? t(`quality.severities.${item.severity}`, {
                defaultValue: item.severity,
              })
            : '-'}
        </StatusBadge>
        <StatusBadge tone={outcomeTone(item.outcome)} size='sm'>
          {t(`quality.outcomes.${item.outcome}`, {
            defaultValue: item.outcome,
          })}
        </StatusBadge>
        <StatusBadge
          tone={item.engine === 'model' ? 'info' : 'neutral'}
          size='sm'
        >
          {item.engine === 'model'
            ? t('quality.screenings.engines.model')
            : t('quality.screenings.engines.rules')}
        </StatusBadge>
        {degradeLabel ? (
          <StatusBadge tone={item.degraded ? 'warning' : 'neutral'} size='sm'>
            {item.degraded
              ? t('quality.screenings.degraded', { reason: degradeLabel })
              : degradeLabel}
          </StatusBadge>
        ) : null}
        <span className='ml-auto text-xs tabular-nums text-muted-foreground'>
          {t('quality.screenings.confidence', {
            value: Number(item.confidence ?? 0).toFixed(2),
          })}
        </span>
      </div>
      <p className='text-xs text-muted-foreground'>{item.summary}</p>
      {knowledgeRefs.length > 0 || similarCaseCount > 0 ? (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {knowledgeRefs.length > 0 ? (
            <p>
              {t('quality.screenings.knowledge', {
                refs: knowledgeRefs.map(knowledgeRefLabel).join(' · '),
              })}
            </p>
          ) : null}
          {similarCaseCount > 0 ? (
            <p>
              {t('quality.screenings.similarCases', { count: similarCaseCount })}
            </p>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <p data-testid='review-record' className='text-xs text-muted-foreground'>
          {t('quality.review.record', {
            actor: review.actorName,
            time: formatTime(review.createdAt, locale),
            category: t(`quality.categories.${review.category}`, {
              defaultValue: review.category,
            }),
            severity: t(`quality.severities.${review.severity}`, {
              defaultValue: review.severity,
            }),
          })}
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <p className='text-xs text-muted-foreground'>
          {t('quality.screenings.ownerAndModel', {
            owner: item.suggestedOwner ?? '-',
            model: item.modelName ?? '-',
          })}
        </p>
        {item.canReview && handlePending ? (
          <Skeleton
            data-slot='review-placeholder'
            className='ml-auto h-7 w-24'
          />
        ) : item.canReview && canHandle ? (
          <Button
            variant='outline'
            size='sm'
            className='ml-auto'
            onClick={() => void confirm()}
            disabled={submission.submitting}
          >
            {submission.submitting ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <Check data-icon='inline-start' />
            )}
            {t('quality.screenings.review')}
          </Button>
        ) : item.canReview && handleError ? (
          <span
            data-testid='review-permission-error'
            className='ml-auto text-xs text-destructive'
          >
            {t('quality.permissionFailed')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
}): ReactElement {
  return (
    <Card>
      <CardHeader className='gap-1'>
        <CardDescription className='text-xs'>{label}</CardDescription>
        <CardTitle className='flex items-center gap-2 text-2xl tabular-nums'>
          {value}
          {tone === 'warning' && value > 0 ? (
            <AlertTriangle className='size-4 text-(--status-warning)' />
          ) : null}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

/**
 * 「代填效果」（R-002）：草稿与人工确认的对照，数据来自统计端点，页面只看不存。
 *
 * 数字是「近一年」（端点允许的最大跨度）内出的草稿，全是规则版、没有模型版数据时
 * 也如实显示：模型草稿是 0、各回落原因各一行，不空白也不报错。骨架行直接渲染
 * 真实的行标签（14 行的标签都是静态的），只有数字的位置放一块不撑高行盒的骨架
 * （`h-3` 小于文本行盒）：行里有真实文本，行盒与加载完成后的数字行完全一致，
 * 高度差为 0。不要用固定高度的块去猜行高 —— `h-5` 在运行态的 `--spacing` 标度下
 * 解析成 18px，而 `text-sm` 的行盒是 19.19px，量过（重量报告 2026-11-26）。
 *
 * 刷新失败时保留上一轮的数字，但把失败亮出来（stale 提示加重试），不把旧数字
 * 悄悄当成当前值；第一次就没读到时整卡显示读取失败，同样给重试。
 */
function DraftingOutcomesCard({
  stats,
  error,
  onRetry,
}: {
  readonly stats?: QualityDraftingStats;
  readonly error?: string;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // 14 行的标签是静态的，骨架态也照实渲染；数字只有读到之后才有，两个数组按下标一一对应。
  const labels: readonly string[] = [
    t('quality.drafting.total'),
    t('quality.drafting.rules'),
    t('quality.drafting.model'),
    t('quality.drafting.confirmed'),
    t('quality.drafting.categoryMatched'),
    t('quality.drafting.categoryMismatched'),
    t('quality.drafting.severityMatched'),
    t('quality.drafting.severityMismatched'),
    t('quality.drafting.redacted'),
    t('quality.screenings.degrade.model-disabled'),
    t('quality.screenings.degrade.model-not-configured'),
    t('quality.screenings.degrade.model-error'),
    t('quality.screenings.degrade.timeout'),
    t('quality.screenings.degrade.invalid-output'),
  ];
  const values: readonly number[] | undefined = stats
    ? [
        stats.total,
        stats.engines.rules,
        stats.engines.model,
        stats.confirmed,
        stats.agreement.category.matched,
        stats.agreement.category.mismatched,
        stats.agreement.severity.matched,
        stats.agreement.severity.mismatched,
        stats.redacted,
        stats.degradeReasons['model-disabled'],
        stats.degradeReasons['model-not-configured'],
        stats.degradeReasons['model-error'],
        stats.degradeReasons.timeout,
        stats.degradeReasons['invalid-output'],
      ]
    : undefined;

  return (
    <Card data-testid='drafting-stats'>
      <CardHeader>
        <CardTitle className='text-sm'>{t('quality.drafting.title')}</CardTitle>
        <CardDescription>
          {t('quality.drafting.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {stats && error ? (
          <div className='flex items-center gap-2 text-xs text-(--status-warning)'>
            <AlertTriangle className='size-4 shrink-0' />
            <p className='flex-1'>{t('quality.drafting.stale')}</p>
            <Button variant='outline' size='sm' onClick={onRetry}>
              {t('quality.drafting.retry')}
            </Button>
          </div>
        ) : null}
        {values ? (
          labels.map((label, index) => (
            <div
              key={label}
              className='flex items-center justify-between text-sm'
            >
              <span className='text-muted-foreground'>{label}</span>
              <span className='tabular-nums'>{values[index]}</span>
            </div>
          ))
        ) : error ? (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <p className='flex-1'>{t('quality.page.loadFailed')}</p>
            <Button variant='outline' size='sm' onClick={onRetry}>
              {t('quality.drafting.retry')}
            </Button>
          </div>
        ) : (
          // 骨架行渲染真实的行标签，只有数字的位置放骨架；`h-3` 小于文本行盒，
          // 不会把行撑高 —— 行盒来自标签文本，与加载完成后的数字行完全一致。
          labels.map((label) => (
            <div
              key={label}
              aria-hidden='true'
              className='flex items-center justify-between text-sm'
            >
              <span className='text-muted-foreground'>{label}</span>
              <Skeleton className='h-3 w-8' />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
