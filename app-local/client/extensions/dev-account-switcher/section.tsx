import {
  useApiClient,
  useClientApplication,
  useToaster,
} from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useTranslation } from '@nocobase/i18n/client';
import { Check } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '#components/ui/dropdown-menu';

/**
 * R-037 头像菜单里的「切换账户 · 仅开发环境」。
 *
 * 只由开发构建登记（见 `client/extensions/development-extensions.ts`），开关由服务端发布到公开配置；关着时整段不渲染。
 * 点一个账户就是重新登录成它：服务端注销当前会话、签发新会话，然后整页刷新重新取会话与权限。
 */

interface DemoAccount {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly role: string;
}

/** 权限集 key 到词条键：服务端回 key，角色名用已有的角色词条。 */
const ROLE_TITLES: Readonly<Record<string, { readonly title: string }>> = {
  quality_manager: { title: 'permissionSets.business.qualityManager' },
  quality_inspector: { title: 'permissionSets.business.qualityInspector' },
  dept_manager: { title: 'permissionSets.business.deptManager' },
  staff: { title: 'permissionSets.business.staff' },
  warehouse: { title: 'permissionSets.business.warehouse' },
  purchase: { title: 'permissionSets.business.purchase' },
  sales: { title: 'permissionSets.business.sales' },
};

export function DevAccountSwitcher(): ReactElement | null {
  const enabled =
    useClientApplication().config.public.get(
      'devTools.accountSwitcher.enabled',
    ) === true;
  // 钩子不能放在条件后面，开关的判断留在外层。
  return enabled ? <EnabledDevAccountSwitcher /> : null;
}

function EnabledDevAccountSwitcher(): ReactElement {
  const api = useApiClient();
  const { session } = useAuthentication();
  const { t } = useTranslation();
  const toaster = useToaster();
  const [accounts, setAccounts] = useState<readonly DemoAccount[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .request<{ data: readonly DemoAccount[] }>({
        path: '/dev-tools/accounts',
        signal: controller.signal,
      })
      .then((body) => {
        if (!controller.signal.aborted) setAccounts(body.data);
      })
      // 读不到就只显示标题：开关可能刚被关掉，接口已经 404。
      .catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  const roleTitle = (role: string): string => {
    const entry = ROLE_TITLES[role];
    return entry ? t(entry.title) : role;
  };

  const switchTo = async (account: DemoAccount): Promise<void> => {
    setSwitching(true);
    try {
      await api.request({
        path: '/dev-tools/switch-account',
        method: 'POST',
        json: { userId: account.id },
      });
    } catch {
      toaster.show({
        type: 'error',
        title: t('devTools.accountSwitcher.failed', { name: account.name }),
      });
      setSwitching(false);
      return;
    }
    // 会话与权限都要重新取，整页刷新最省事。
    window.location.reload();
  };

  return (
    <>
      <DropdownMenuSeparator />
      <div className='px-2 py-1.5'>
        <p className='text-sm font-medium'>
          {t('devTools.accountSwitcher.title')}
        </p>
        <p className='text-xs text-muted-foreground'>
          {t('devTools.accountSwitcher.developmentOnly')}
        </p>
      </div>
      {accounts.map((account) => (
        <DropdownMenuItem
          key={account.id}
          disabled={switching}
          onClick={() => {
            void switchTo(account);
          }}
          className='gap-2'
        >
          <span className='min-w-0 flex-1 truncate'>{account.name}</span>
          <span className='shrink-0 text-xs text-muted-foreground'>
            {roleTitle(account.role)}
          </span>
          {account.id === session?.user.id ? (
            <Check
              className='size-4'
              aria-label={t('devTools.accountSwitcher.current')}
            />
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}
