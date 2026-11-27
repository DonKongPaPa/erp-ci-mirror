import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { Card, CardDescription, CardHeader, CardTitle } from '#components/ui/card';

import type { QualityScreening, QualityTicket } from './client.js';
import type { Tone } from './tones.js';

export function StatCard({
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

/** 顶部四个统计格：从已加载的工单与初筛里数出来，不发额外的请求。 */
export function StatsRow({
  tickets,
  screenings,
}: {
  readonly tickets: readonly QualityTicket[];
  readonly screenings: readonly QualityScreening[];
}): ReactElement {
  const { t } = useTranslation();
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

  return (
    <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
      <StatCard label={t('quality.stats.total')} value={stats.total} />
      <StatCard label={t('quality.stats.open')} value={stats.open} tone='info' />
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
  );
}
