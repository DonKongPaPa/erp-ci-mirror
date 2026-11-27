import { useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { ConfirmDialog } from '#components/erp/confirm';
import { errorText } from '#components/erp/messages';

import type { ItemStatus } from './client.js';

/**
 * 停用与启用（三个标签与详情抽屉共用）：停用先过确认框，被拒时服务端那句话写在框里；
 * 启用没有确认框，被拒时用提示说。成功后提示一句并重新取数。
 */
export function useStatusChange<T>({
  change,
  nameOf,
  noun,
  description,
  reload,
}: {
  readonly change: (record: T, status: ItemStatus) => Promise<unknown>;
  readonly nameOf: (record: T) => string;
  /** 提示与确认框里怎么叫这一条：物料、计量单位、物料分类。 */
  readonly noun: string;
  /** 确认框里说明停用之后会怎样。 */
  readonly description: string;
  readonly reload: () => void;
}) {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [stopping, setStopping] = useState<T>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (record: T, status: ItemStatus): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await change(record, status);
      const name = nameOf(record);
      toaster.show({
        type: 'success',
        title:
          status === 'active'
            ? t('items.activatedToast', { noun, name })
            : t('items.deactivatedToast', { noun, name }),
      });
      setStopping(undefined);
      reload();
    } catch (next) {
      // 停用有确认框，错写在框里；启用没有，错用提示说。
      const text = errorText(next, t);
      if (status === 'inactive') setError(text);
      else toaster.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
    }
  };
  // run 每次渲染都是新的；行上的操作拿到的函数要保持稳定（列定义不随重新取数重装操作格），
  // 所以经 ref 转一手。
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  const activate = useCallback((record: T) => {
    void runRef.current(record, 'active');
  }, []);
  const ask = useCallback((record: T) => setStopping(record), []);
  const cancel = useCallback(() => setStopping(undefined), []);
  const confirm = useCallback(() => {
    if (stopping !== undefined) void runRef.current(stopping, 'inactive');
  }, [stopping]);

  const dialog: ReactElement = (
    <ConfirmDialog
      open={stopping !== undefined}
      title={t('items.deactivateTitle', {
        noun,
        name: stopping === undefined ? '' : nameOf(stopping),
      })}
      description={description}
      confirmLabel={t('erp.actions.deactivate')}
      error={error ? <span role='alert'>{error}</span> : undefined}
      busy={busy}
      onCancel={cancel}
      onConfirm={confirm}
    />
  );

  return { dialog, ask, activate };
}
