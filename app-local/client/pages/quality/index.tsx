import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle, Plus, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { Button } from '#components/ui/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';

import {
  QualityClient,
  type QualityDraftingStats,
  type QualityMessage,
  type QualityScreening,
  type QualityTicket,
} from './client.js';
import { ByDepartmentCard } from './Departments.js';
import { DraftingOutcomesCard } from './DraftingOutcomesCard.js';
import { MessagesCard } from './Messages.js';
import { FQC_RESOURCE } from './page-id.js';
import { RoutingRulesCard } from './RoutingRules.js';
import { ScreeningsCard } from './Screenings.js';
import { StatsRow } from './Stats.js';
import { TicketsCard } from './Tickets.js';

/**
 * 质量页（R-003 第九片）：只做装配。
 * - 投递初筛明细（Screenings）：确认，以及每份未派单草稿的「确认并派单」；
 * - 「代填效果」（DraftingOutcomesCard，R-002）与部门分流（Departments）；
 * - 工单（Tickets）：筛选、详情、按服务端 `canTransition` 显隐的流转按钮、帮手；
 * - 派单规则（RoutingRules）：七个类别一次写全，编辑入口只给持「维护派单规则」的人。
 * 取数也在这里：统计、部门分流与工单列表共用同一份页面级数据，不发重复请求；
 * 筛选后的工单列表由工单块自己取，不回写这份共享数据。
 */

/** 质量工单看板：左侧统计与投递，右侧工单列表与初筛明细。 */
export default function QualityPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const client = useMemo(() => new QualityClient(api), [api]);

  // 按钮按权限显隐。等待权限结果期间 `can` 是 false，所以按钮先不显示、后出现，
  // 不会先闪一下再消失。等待期用占位顶住同样的高度，免得下面的卡片被顶下去。
  const submitAccess = useCan({ resource: FQC_RESOURCE, action: 'submit' });
  const handleAccess = useCan({ resource: FQC_RESOURCE, action: 'handle' });
  const [tickets, setTickets] = useState<QualityTicket[]>([]);
  const [messages, setMessages] = useState<QualityMessage[]>([]);
  const [screenings, setScreenings] = useState<QualityScreening[]>([]);
  // R-002 的「代填效果」：统计是只读的汇总数字。确认记录由初筛列表随行带
  // （派单也是确认的一种），页面不再自留一份本会话的副本。
  const [draftStats, setDraftStats] = useState<QualityDraftingStats>();
  const [statsError, setStatsError] = useState<string>();
  const [statsReloadToken, setStatsReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
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

  /** 派单成功：重取整页数据，新工单与确认记录都吃这份新数据。 */
  const handleDispatched = useCallback(() => {
    refresh();
  }, [refresh]);

  // 已经派过单的草稿：从已加载的工单里算（工单带着 screeningId）。
  // 工单要持「查看」才看得到，所以只持「处理」的人这里可能是空集 ——
  // 那些行仍显示派单按钮，重复派单由服务端的 409 挡下并说明原因。
  const dispatchedScreeningIds = useMemo(
    () =>
      new Set(
        tickets
          .map((ticket) => ticket.screeningId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    [tickets],
  );

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

      <StatsRow tickets={tickets} screenings={screenings} />

      <div className='grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]'>
        <div className='flex flex-col gap-4'>
          {/* R-026：演示投递表单已删。这里只留「新建反馈」入口（持 submit 的人才看得到）。
              槽位固定高度：权限没回来时占位不塌、落定后按钮插入也不把下面的卡片顶下去。 */}
          <div data-testid='feedback-entry' className='flex min-h-11 items-center'>
            {submitAccess.can ? (
              <Button
                nativeButton={false}
                render={<Link to='/feedbacks/new' />}
                size='sm'
              >
                <Plus data-icon='inline-start' className='size-4' />
                {t('quality.newFeedback')}
              </Button>
            ) : submitAccess.error ? (
              <span role='alert' className='text-xs text-destructive'>
                {t('quality.permissionFailed')}
              </span>
            ) : null}
          </div>

          <ByDepartmentCard tickets={tickets} />

          <DraftingOutcomesCard
            stats={draftStats}
            error={statsError}
            onRetry={retryStats}
          />
        </div>

        <TicketsCard rows={tickets} loading={loading} onChanged={refresh} />
      </div>

      <div className='grid gap-4 lg:grid-cols-2'>
        <MessagesCard messages={messages} locale={locale} />

        <ScreeningsCard
          screenings={screenings}
          canHandle={handleAccess.can}
          handlePending={handleAccess.isPending}
          handleError={Boolean(handleAccess.error)}
          dispatchedScreeningIds={dispatchedScreeningIds}
          onDispatched={handleDispatched}
        />
      </div>

      <RoutingRulesCard />
    </PageContainer>
  );
}
