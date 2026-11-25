import { randomUUID } from 'node:crypto';

import type { TestApp } from '@nocobase/app-testing/server';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';

import NotificationLogsPage from '../../client/pages/settings/notification-logs.js';
import enUS from '../../client/locales/en-US.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * R-034 第 5、6、7 条：页面只读、只调两个只读接口、不显示收件人与消息内容、
 * 没有记录时是空态。
 *
 * 造一条失败的通知：收件人与消息快照都带上好认的值，页面上一个都不该出现。
 */

beforeEach(() => window.sessionStorage.clear());

async function seedFailedNotification(server: TestApp): Promise<void> {
  const now = new Date();
  const logId = randomUUID();
  const deliveryId = randomUUID();
  await server.connection.repository('notificationDispatches').createOne({
    values: {
      id: logId,
      sourceType: 'approval',
      sourceReferenceId: 'AP-001',
      createdAt: now,
      updatedAt: now,
    },
  });
  await server.connection.repository('notificationDeliveries').createOne({
    values: {
      id: deliveryId,
      notificationId: logId,
      channelName: 'inbox',
      channelType: 'in-app',
      recipientSnapshot: { userId: 'recipient-secret-id' },
      messageSnapshot: {
        title: 'Secret message title',
        body: 'Secret message body',
      },
      providerType: 'in-app',
      attemptCount: 1,
      status: 'failed',
      nextRunAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: {
        code: 'PROVIDER_REFUSED',
        message: 'The provider refused the message',
        category: 'provider',
      },
      retryResolution: null,
      providerIdempotency: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  await server.connection.repository('notificationDeliveryAttempts').createOne({
    values: {
      id: randomUUID(),
      deliveryId,
      sequence: 1,
      providerType: 'in-app',
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      providerMessageId: null,
      errorCategory: 'provider',
      errorCode: 'PROVIDER_REFUSED',
      errorMessage: 'The provider refused the message',
      retryResolution: null,
    },
  });
}

/** 两个渠道的报错都把收件地址带在文本里：邮件带邮箱，短信带手机号。 */
async function seedRecipientErrors(server: TestApp): Promise<void> {
  const now = new Date();
  const logId = randomUUID();
  await server.connection.repository('notificationDispatches').createOne({
    values: {
      id: logId,
      sourceType: 'approval',
      sourceReferenceId: 'AP-002',
      createdAt: now,
      updatedAt: now,
    },
  });
  const deliveries = [
    {
      id: randomUUID(),
      channelName: 'email',
      channelType: 'email',
      providerType: 'smtp',
      lastError: 'Mailbox alice.wang@example.com refused the message',
      attemptError: 'SMTP refused alice.wang@example.com with 550 5.1.1',
    },
    {
      id: randomUUID(),
      channelName: 'sms',
      channelType: 'sms',
      providerType: 'sms-gateway',
      lastError: 'Gateway rejected +8613812345678',
      attemptError: 'SMS to 13812345678 failed: 550',
    },
  ];
  for (const [index, delivery] of deliveries.entries()) {
    await server.connection.repository('notificationDeliveries').createOne({
      values: {
        id: delivery.id,
        notificationId: logId,
        channelName: delivery.channelName,
        channelType: delivery.channelType,
        recipientSnapshot: { address: 'recipient-secret-address' },
        messageSnapshot: { title: 'Secret', body: 'Secret body' },
        providerType: delivery.providerType,
        attemptCount: 1,
        status: 'failed',
        nextRunAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: {
          code: 'PROVIDER_REFUSED',
          message: delivery.lastError,
          category: 'provider',
        },
        retryResolution: null,
        providerIdempotency: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await server.connection
      .repository('notificationDeliveryAttempts')
      .createOne({
        values: {
          id: randomUUID(),
          deliveryId: delivery.id,
          sequence: index + 1,
          providerType: delivery.providerType,
          status: 'failed',
          startedAt: now,
          finishedAt: now,
          providerMessageId: null,
          errorCategory: 'provider',
          errorCode: 'PROVIDER_REFUSED',
          errorMessage: delivery.attemptError,
          retryResolution: null,
        },
      });
  }
}

it('lists a failed notification read-only and never shows recipients or message content', async () => {
  const user = userEvent.setup();
  const requests: { method: string; path: string }[] = [];
  const view = await renderAuthenticatedClient(<NotificationLogsPage />, {
    route: '/settings/notifications/logs',
    locale: 'en-US',
    prepare: seedFailedNotification,
    beforeRequest: (request) =>
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
      }),
  });

  // 列表一条：来源业务、整体状态、渠道计数。
  expect(await screen.findByText('approval · AP-001')).toBeVisible();
  expect(
    screen.getAllByText(enUS.notificationLogs.statusLabel.failed).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText('inbox × 1')).toBeVisible();

  await user.click(
    screen.getByRole('button', {
      name: enUS.notificationLogs.actionsFor.replace('{{source}}', 'approval'),
    }),
  );
  await user.click(
    await screen.findByRole('menuitem', {
      name: enUS.notificationLogs.open,
    }),
  );

  const dialog = await screen.findByRole('dialog', {
    name: enUS.notificationLogs.detailTitle,
  });
  expect(await within(dialog).findByText('inbox')).toBeVisible();
  expect(within(dialog).getByText(/in-app/)).toBeVisible();
  expect(
    within(dialog).getAllByText(enUS.notificationLogs.deliveryStatus.failed)
      .length,
  ).toBeGreaterThan(0);
  expect(
    within(dialog).getAllByText(/The provider refused the message/).length,
  ).toBeGreaterThan(0);

  // 公开接口删掉了收件人与消息快照，页面里一个都不该出现。
  expect(document.body.textContent).not.toContain('recipient-secret-id');
  expect(document.body.textContent).not.toContain('Secret message title');
  expect(document.body.textContent).not.toContain('Secret message body');

  // 公开接口本身就不返回收件人与消息快照：原始响应里也不该有。
  const rawList = await (
    await view.session.fetch('/notifications/logs')
  ).text();
  expect(rawList).not.toContain('recipient-secret-id');
  expect(rawList).not.toContain('Secret message body');
  const listed = JSON.parse(rawList) as { data: { log: { id: string } }[] };
  const logId = listed.data[0]?.log.id;
  expect(logId).toBeTruthy();
  const rawDetail = await (
    await view.session.fetch(`/notifications/logs/${logId}`)
  ).text();
  expect(rawDetail).not.toContain('recipient-secret-id');
  expect(rawDetail).not.toContain('Secret message body');

  // 只读：只调用两个 GET 接口，没有任何写请求。
  expect(
    requests.filter((request) => request.method !== 'GET'),
    '通知记录页不该发写请求',
  ).toEqual([]);
  expect(
    requests.some((request) =>
      request.path.endsWith('/api/notifications/logs'),
    ),
  ).toBe(true);
  await waitFor(() =>
    expect(
      requests.some((request) =>
        /\/api\/notifications\/logs\/[^/]+$/u.test(request.path),
      ),
    ).toBe(true),
  );
  // 页面上没有发送、重发、删除的入口。
  for (const label of ['Send', 'Resend', 'Delete']) {
    expect(
      screen.queryByRole('button', { name: label }),
      `不该有「${label}」按钮`,
    ).not.toBeInTheDocument();
  }
});

it('shows no recipient address in delivery errors, masked or not at all', async () => {
  const user = userEvent.setup();
  await renderAuthenticatedClient(<NotificationLogsPage />, {
    route: '/settings/notifications/logs',
    locale: 'en-US',
    prepare: seedRecipientErrors,
  });

  expect(
    await screen.findByText('approval · AP-002', {}, { timeout: 15_000 }),
  ).toBeVisible();
  await user.click(
    screen.getByRole('button', {
      name: enUS.notificationLogs.actionsFor.replace('{{source}}', 'approval'),
    }),
  );
  await user.click(
    await screen.findByRole(
      'menuitem',
      { name: enUS.notificationLogs.open },
      { timeout: 15_000 },
    ),
  );

  const dialog = await screen.findByRole(
    'dialog',
    { name: enUS.notificationLogs.detailTitle },
    { timeout: 15_000 },
  );
  // 渠道报错里的地址都遮掉了：邮箱保留域名，手机号保留前 3 位与后 4 位。
  expect(
    await within(dialog).findByText(
      'Failure: provider · Mailbox ***@example.com refused the message',
      {},
      { timeout: 15_000 },
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      /SMTP refused \*\*\*@example\.com with 550 5\.1\.1/u,
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      'Failure: provider · Gateway rejected +86138****5678',
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByText(/SMS to 138\*{4}5678 failed: 550/u),
  ).toBeVisible();

  // 原始地址一个都不能出现在页面上，快照里的收件人也不行。
  const pageText = document.body.textContent ?? '';
  expect(pageText).not.toContain('alice.wang@example.com');
  expect(pageText).not.toContain('13812345678');
  expect(pageText).not.toContain('recipient-secret-address');
  expect(pageText).not.toContain('Secret body');
});

it('shows an empty state when the application has never sent a notification', async () => {
  await renderAuthenticatedClient(<NotificationLogsPage />, {
    route: '/settings/notifications/logs',
    locale: 'en-US',
  });
  expect(await screen.findByText(enUS.notificationLogs.empty)).toBeVisible();
  expect(document.body.textContent).not.toContain(
    enUS.notificationLogs.detailTitle,
  );
});

it('refuses the logs to a user without the notification.logs page grant', async () => {
  await renderAuthenticatedClient(<NotificationLogsPage />, {
    route: '/settings/notifications/logs',
    locale: 'en-US',
    member: true,
  });
  expect(await screen.findByText(enUS.settings.denied)).toBeVisible();
  expect(
    screen.queryByText(enUS.notificationLogs.empty),
  ).not.toBeInTheDocument();
});
