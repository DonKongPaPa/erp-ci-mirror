import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useLocale } from '@nocobase/i18n/client';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';

import { QualityClient, type TicketAssist } from './client.js';
import { formatTime } from './format.js';
import { severityTone } from './tones.js';

/**
 * 帮手（R-003 验收 17）：详情里的一块「相似的工单」与一段处理建议。
 * 只给持「处理工单」的人看（由父级按权限决定是否挂载与发请求）。
 * 相似工单只有编号、标题、类别、严重度、处理说明、关闭时间六列 ——
 * 不显示描述（那里面是客户的正文）。处理建议要等模型接入：没有就如实说，
 * 不造假数据，也不显示 `engine` 这样的内部字段。
 */
export function AssistSection({
  ticketId,
  client: providedClient,
}: {
  readonly ticketId: string;
  readonly client?: QualityClient;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const [assist, setAssist] = useState<TicketAssist>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    client.assist(ticketId).then(
      (next) => {
        if (active) setAssist(next);
      },
      (next: unknown) => {
        if (active) setError(next instanceof Error ? next.message : String(next));
      },
    );
    return () => {
      active = false;
    };
  }, [client, ticketId]);

  return (
    <section data-testid='assist-section' className='flex flex-col gap-2'>
      <h4 className='text-sm font-medium'>{t('quality.assist.title')}</h4>
      {error ? (
        <p role='alert' className='text-xs text-destructive'>
          {error}
        </p>
      ) : assist === undefined ? (
        <div aria-busy='true' className='flex flex-col gap-2'>
          <Loader2 className='size-4 animate-spin text-muted-foreground' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-2/3' />
        </div>
      ) : (
        <>
          <div className='flex flex-col gap-1'>
            <p className='text-xs font-medium text-muted-foreground'>
              {t('quality.assist.similar')}
            </p>
            {assist.similar.length === 0 ? (
              <p className='text-xs text-muted-foreground'>
                {t('quality.assist.similarEmpty')}
              </p>
            ) : (
              <ul className='flex flex-col divide-y divide-border'>
                {assist.similar.map((item) => (
                  <li
                    key={item.code}
                    data-testid='assist-similar-row'
                    className='flex flex-col gap-1 py-2 text-sm'
                  >
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-mono text-xs text-muted-foreground'>
                        {item.code}
                      </span>
                      <StatusBadge tone='neutral' size='sm'>
                        {item.category
                          ? t(`quality.categories.${item.category}`, {
                              defaultValue: item.category,
                            })
                          : t('quality.uncategorized')}
                      </StatusBadge>
                      <StatusBadge tone={severityTone(item.severity)} size='sm'>
                        {t(`quality.severities.${item.severity}`, {
                          defaultValue: item.severity,
                        })}
                      </StatusBadge>
                      <span className='ml-auto text-xs text-muted-foreground'>
                        {item.closedAt
                          ? t('quality.assist.closedAt', {
                              time: formatTime(item.closedAt, locale),
                            })
                          : null}
                      </span>
                    </div>
                    <p>{item.title}</p>
                    {item.resolution ? (
                      <p className='text-xs text-muted-foreground'>
                        {item.resolution}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className='flex flex-col gap-1'>
            <p className='text-xs font-medium text-muted-foreground'>
              {t('quality.assist.suggestion')}
            </p>
            {assist.suggestion ? (
              <p className='text-sm leading-6'>{assist.suggestion}</p>
            ) : (
              <p className='text-xs text-muted-foreground'>
                {t('quality.assist.suggestionPending')}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
