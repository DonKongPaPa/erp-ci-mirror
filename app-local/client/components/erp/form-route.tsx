import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { RouteDialog } from '#components/route-dialog';
import { RouteDrawer } from '#components/route-drawer';
import { Alert, AlertDescription } from '#components/ui/alert';

import { errorText } from './messages.js';

export function OverlayNote({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteDialog title={title}>
      <p role='status' className='text-sm text-muted-foreground'>
        {children}
      </p>
    </RouteDialog>
  );
}

/**
 * 写操作的路由对话框的门槛：权限没落定时先等；没有写权限的人敲这个地址只看到一句说明，
 * 不渲染表单（服务端照样会拒绝，页面上只是不给无效的入口）。
 */
export function FormRoute({
  title,
  pending,
  allowed,
  children,
}: {
  readonly title: ReactNode;
  readonly pending: boolean;
  readonly allowed: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  if (pending)
    return <OverlayNote title={title}>{t('status.loading')}</OverlayNote>;
  if (!allowed)
    return <OverlayNote title={title}>{t('erp.form.noWrite')}</OverlayNote>;
  return <>{children}</>;
}

/**
 * 先读一遍最新数据再填（编辑，T3.8）：读到之前对话框已经开着；读不到时在对话框里说明原因。
 */
export function RecordRoute<T>({
  title,
  record,
  drawer = false,
  children,
}: {
  readonly title: ReactNode;
  readonly record: {
    readonly data?: T;
    readonly error?: unknown;
    readonly loading: boolean;
  };
  /** 读的是详情抽屉时传 `true`：面板从右边出，不是居中的对话框。 */
  readonly drawer?: boolean;
  readonly children: (record: T) => ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  if (record.data !== undefined) return <>{children(record.data)}</>;
  const Panel = drawer ? RouteDrawer : RouteDialog;
  const alert = (
    <Alert variant='destructive'>
      <AlertDescription>{errorText(record.error, t)}</AlertDescription>
    </Alert>
  );
  if (record.error !== undefined) return <Panel title={title}>{alert}</Panel>;
  return (
    <Panel title={title}>
      <p role='status' className='text-sm text-muted-foreground'>
        {t('status.loading')}
      </p>
    </Panel>
  );
}
