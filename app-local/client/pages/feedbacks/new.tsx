import { useApiClient, useSubmission, useToaster } from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { RouteDialog } from '#components/route-dialog';
import { useRouteOverlay } from '#components/use-route-overlay';

import { FeedbackClient, type CreateFeedbackInput } from './client.js';
import { FQC_RESOURCE } from './page-id.js';
import {
  FeedbackSheetForm,
  type FeedbackFormValues,
} from './FeedbackSheetForm.js';

/** 覆盖在列表上的新建页。幂等键由 useSubmission 生成，与投递同一个机制。 */
export default function FeedbackNewPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog title={t('feedbacks.form.titleNew')}>
      <NewFeedbackSheet />
    </RouteDialog>
  );
}

function NewFeedbackSheet(): ReactElement {
  const { t } = useTranslation();
  // useRouteOverlay 必须在 RouteDialog 提供的上下文里调用，所以这一层放在对话框内部。
  const { close } = useRouteOverlay();
  const submit = useCan({ resource: FQC_RESOURCE, action: 'submit' });
  const api = useApiClient();
  const { session } = useAuthentication();
  const toaster = useToaster();
  const client = useMemo(() => new FeedbackClient(api), [api]);
  const submission = useSubmission({
    scope: `${session?.user.id}:feedback:new`,
  });

  const onSave = async (values: FeedbackFormValues): Promise<void> => {
    const result = await submission.run(
      values,
      (idempotencyKey, _signal, snapshot) =>
        client.create(snapshot as CreateFeedbackInput, idempotencyKey),
    );
    if (!result) return;
    toaster.show({ type: 'success', title: t('feedbacks.form.created') });
    void close();
  };

  // 页面模块已随入口包就绪，对话框首帧就是这个页面；占位只在权限判定中短暂出现，不再撑满视口。
  if (submit.isPending) {
    return <p role='status' className='text-sm text-muted-foreground'>{t('feedbacks.loading')}</p>;
  }
  if (!submit.can) {
    // 页面授权只管能不能打开这一页；能不能提交是另一个动作，详情页同样这么分。
    return (
      <p role='status' className='text-sm text-muted-foreground'>
        {t('feedbacks.newNoAccess')}
      </p>
    );
  }

  return (
    <FeedbackSheetForm
      mode='create'
      client={client}
      saving={submission.submitting}
      onSave={onSave}
      onCancel={() => void close()}
    />
  );
}
