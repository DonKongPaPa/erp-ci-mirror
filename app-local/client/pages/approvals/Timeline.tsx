import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { type ReactElement } from 'react';

import { StatusBadge } from '#components/status-badge';

import type { ApprovalDetail, RecordRow } from './client.js';
import { formatTime, originLabel, recordStatusLabel } from './model.js';

/**
 * 时间线按轮分组：详情端点的记录行带 roundId，按轮的 id 归位；
 * 每组内保持服务端的 seq 顺序，转交与加签的行也落在产生的那一轮。
 */
export function ApprovalTimeline({
  detail,
}: {
  readonly detail: ApprovalDetail;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const rounds = [...detail.rounds].sort((a, b) => b.round - a.round);
  const records = [...detail.records].sort((a, b) => a.seq - b.seq);
  const grouped = rounds.map((round) => ({
    round,
    rows: records.filter((record) => record.roundId === round.id),
  }));
  const roundIds = new Set(rounds.map((round) => round.id));
  const orphans = records.filter(
    (record) => typeof record.roundId !== 'string' || !roundIds.has(record.roundId),
  );
  return (
    <div data-testid='approval-timeline' className='flex flex-col gap-5'>
      {grouped.map(({ round, rows }) => (
        <section
          key={round.id}
          data-testid={`approval-round-group-${round.round}`}
          className='flex flex-col gap-2'
        >
          <div data-testid='approval-round'>
            <StatusBadge tone='neutral' size='sm'>
              {t('approvals.detail.round', { round: round.round })}
            </StatusBadge>
          </div>
          <ol className='flex flex-col gap-2 border-l pl-4'>
            {rows.length === 0 ? (
              <li className='text-sm text-muted-foreground'>
                {t('approvals.timeline.noRecords')}
              </li>
            ) : (
              rows.map((record) => (
                <TimelineRow key={record.id} record={record} locale={locale} />
              ))
            )}
          </ol>
        </section>
      ))}
      {orphans.length > 0 ? (
        <section data-testid='approval-round-group-other' className='flex flex-col gap-2'>
          <ol className='flex flex-col gap-2 border-l pl-4'>
            {orphans.map((record) => (
              <TimelineRow key={record.id} record={record} locale={locale} />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function TimelineRow({
  record,
  locale,
}: {
  readonly record: RecordRow;
  readonly locale: string;
}): ReactElement {
  const { t } = useTranslation();
  const weak = record.origin === 'delegated' || record.origin === 'added';
  return (
    <li
      data-testid='approval-record'
      data-origin={record.origin}
      className={weak ? 'text-sm text-muted-foreground' : 'text-sm'}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <StatusBadge tone='neutral' size='sm'>
          {recordStatusLabel(t, record.status)}
        </StatusBadge>
        {weak ? (
          <span className='font-medium'>
            {record.origin === 'delegated'
              ? t('approvals.timeline.delegated')
              : t('approvals.timeline.added')}
          </span>
        ) : null}
        <span>{record.assigneeName ?? t('approvals.timeline.unknownPerson')}</span>
        <span className='text-xs text-muted-foreground'>
          {formatTime(record.actedAt, locale)}
        </span>
        <span className='text-xs text-muted-foreground'>
          {originLabel(t, record.origin)}
        </span>
      </div>
      {record.comment ? <p className='whitespace-pre-wrap'>{record.comment}</p> : null}
    </li>
  );
}
