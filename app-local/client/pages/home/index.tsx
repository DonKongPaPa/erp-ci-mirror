import { useClientApplication } from '@nocobase/app-client';
import {
  authenticationClientToken,
  useAuthentication,
} from '@nocobase/app-plugin-authentication/client';
import { useUserPreference } from '@nocobase/app-plugin-users/client/preferences';
import { type ReactElement } from 'react';

import {
  DEFAULT_ROLE,
  PREFERENCE_KEY,
  parseDashboardPreference,
} from './dashboard-config.js';
import { Dashboard } from './dashboard.js';
import { useDashboardRole } from './use-dashboard-role.js';

/** 登录后进工作台：角色默认 + 按账户覆盖，偏好只管显示，不授予权限。 */
export default function HomePage(): ReactElement {
  const app = useClientApplication();
  // 没有认证提供者的组件测试（交付提醒原有测试）按普通员工默认渲染，不触碰偏好服务。
  const hasAccount = app.container.has(authenticationClientToken);
  return hasAccount ? <AccountHome /> : <Dashboard roleKey={DEFAULT_ROLE} />;
}

function AccountHome(): ReactElement {
  const { isPending, preparation } = useAuthentication();
  const roleKey = useDashboardRole();
  // 切换身份的瞬间，旧快照里的 can 可能还是 true：会话没落定前不挂载部件，
  // 以免待我处理与交付提醒拿着新会话去撞旧角色的授权，收到 401。
  if (isPending || preparation !== 'ready' || roleKey === undefined)
    return <></>;
  return <PreferenceDashboard roleKey={roleKey} />;
}

function PreferenceDashboard({
  roleKey,
}: {
  readonly roleKey: string;
}): ReactElement {
  const [value, setValue] = useUserPreference<unknown>(PREFERENCE_KEY, {
    defaultValue: undefined,
    // 原样交给解析函数校验：不合法的偏好一律按没有覆盖处理，不把越权的编号带进页面。
    parse: (raw) => raw,
  });
  const preference = parseDashboardPreference(value);
  return (
    <Dashboard
      roleKey={roleKey}
      preference={preference}
      // 「恢复默认」写成 widgets:null，解析时按没有覆盖处理。
      onChange={(next) =>
        setValue(next === undefined ? { widgets: null } : next)
      }
    />
  );
}
