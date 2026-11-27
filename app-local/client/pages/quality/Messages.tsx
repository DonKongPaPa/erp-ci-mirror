import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card';

import type { QualityMessage } from './client.js';
import { formatTime } from './format.js';

/** 客户消息留痕卡：正文只读，发件人两列由授权裁决，页面拿到什么显示什么。 */
export function MessagesCard({
  messages,
  locale,
}: {
  readonly messages: readonly QualityMessage[];
  readonly locale: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
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
                  {message.senderName ?? t('quality.messages.unknownSender')}
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
  );
}
