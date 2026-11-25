import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import {
  ApiClientError,
  resolveListState,
  useApiClient,
  useSubmission,
  useToaster,
} from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon, UserRoundCog } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import {
  CreateApiKeyDialog,
  OutcomeUnknownAlert,
  SecretDialog,
  type ApiKeyDraft,
} from '#components/api-keys/dialogs';
import {
  apiKeyStatus,
  formatTimestamp,
  type ApiKeyStatus,
} from '#components/api-keys/format';
import { ApiKeyRowActions } from '#components/api-keys/row-actions';
import { DataTable } from '#components/data-table';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { StatusBadge } from '#components/status-badge';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { useListData } from '#hooks/use-list-data';
import { SettingsError } from './shared.js';
import type { ColumnDef } from '@tanstack/react-table';

/**
 * R-032「应用 API 密钥」：给服务账号签发密钥，并给它分配角色。
 *
 * 应用密钥代表服务账号，不代表签发它的管理员。这一页能决定服务账号能做什么：
 * 角色只在这一页给，范围由服务端限定为不含 root 与任何不受限制的权限集 —— 这是一处
 * 授权面的扩大，所以入口只在系统设置，页面授权 `application.api-keys` 不在任何角色的
 * seed 里，默认只有 root 能进。
 */

interface ServiceAccount {
  id: string;
  name: string;
  disabledAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  description: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** 权限集的名称：库里可能存成字符串，也可能是 `{ key, ns }` 的词条描述符。 */
interface PermissionSetView {
  key: string;
  title: string | { key: string; ns: string } | null;
}

interface RolesView {
  roles: PermissionSetView[];
  options: PermissionSetView[];
}

const statusTone: Record<ApiKeyStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  expired: 'warning',
  disabled: 'neutral',
};

const ACCOUNTS = 'application-api-keys/accounts';

export default function ApplicationApiKeysPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const { session } = useAuthentication();
  const accounts = useListData<{
    data: ServiceAccount[];
    meta: { total: number };
  }>(ACCOUNTS);
  const [selectedId, setSelectedId] = useState<string>();
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [accountError, setAccountError] = useState<unknown>();
  const [lastAccountName, setLastAccountName] = useState<string>();
  const createSubmission = useSubmission({
    scope: `${session?.user.id}:settings:application-api-keys:account`,
  });

  const rows = accounts.data?.data ?? [];
  // 直接打开这个地址但没有页面授权的人：服务端 403，页面不给任何管理入口。
  const denied =
    accounts.error instanceof ApiClientError && accounts.error.status === 403;
  const selected =
    rows.find((row) => row.id === selectedId) ?? rows[0] ?? undefined;

  const submitAccount = async (name: string) => {
    setAccountError(undefined);
    setLastAccountName(name);
    try {
      const outcome = await createSubmission.run({ name }, async (key) => {
        const created = await api.request<{ data: ServiceAccount }>({
          path: ACCOUNTS,
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          json: { name },
        });
        return created.data;
      });
      if (!outcome) return;
      setCreatingAccount(false);
      setAccountName('');
      setSelectedId(outcome.id);
      accounts.reload();
    } catch (error) {
      setAccountError(error);
    }
  };

  const createAccount = () => {
    const name = accountName.trim();
    if (!name) return;
    return submitAccount(name);
  };

  /** 核对过列表：清掉未知结果，表单解锁，下一次提交用新的幂等键。 */
  const acknowledgeAccount = () => {
    if (createSubmission.submitting) return;
    createSubmission.acknowledgeOutcome('not-committed');
    setAccountError(undefined);
    accounts.reload();
  };

  return (
    <PageContainer>
      <PageHeader
        title={t('apiKeys.application.title')}
        description={t('apiKeys.application.description')}
        actions={
          denied ? undefined : (
            <Button onClick={() => setCreatingAccount(true)}>
              <PlusIcon />
              {t('apiKeys.application.newAccount')}
            </Button>
          )
        }
      />
      <SettingsError error={accounts.error} retry={accounts.reload} inline />
      {accounts.data && rows.length > 0 ? (
        <div className='flex flex-wrap items-start gap-6'>
          <div className='flex w-full flex-col gap-2 sm:max-w-sm'>
            <Label htmlFor='application-api-key-account'>
              {t('apiKeys.application.account')}
            </Label>
            <Select
              items={rows.map((row) => ({
                value: row.id,
                label: row.disabledAt
                  ? t('apiKeys.application.accountDisabled', {
                      name: row.name,
                    })
                  : row.name,
              }))}
              value={selected?.id ?? ''}
              onValueChange={(value) => setSelectedId(String(value))}
            >
              <SelectTrigger
                id='application-api-key-account'
                className='w-full'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.disabledAt
                      ? t('apiKeys.application.accountDisabled', {
                          name: row.name,
                        })
                      : row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected ? (
            <AccountRoles key={selected.id} account={selected} />
          ) : null}
          <p className='flex items-center gap-1.5 py-2 text-sm text-muted-foreground'>
            <UserRoundCog aria-hidden className='size-4' />
            {t('apiKeys.application.accountHint')}
          </p>
        </div>
      ) : null}
      {accounts.data && rows.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('apiKeys.application.noAccounts')}
        </p>
      ) : null}
      {selected ? <AccountKeys key={selected.id} account={selected} /> : null}
      <Dialog
        open={creatingAccount}
        onOpenChange={(open) => {
          if (!open && !createSubmission.submitting) setCreatingAccount(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('apiKeys.application.newAccountTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('apiKeys.application.newAccountDescription')}
            </DialogDescription>
          </DialogHeader>
          {createSubmission.pending ? (
            <OutcomeUnknownAlert
              busy={createSubmission.submitting}
              onRetry={
                lastAccountName
                  ? () => void submitAccount(lastAccountName)
                  : undefined
              }
              onAcknowledge={acknowledgeAccount}
            />
          ) : null}
          <form
            id='service-account-create'
            className='flex flex-col gap-2'
            onSubmit={(event) => {
              event.preventDefault();
              void createAccount();
            }}
          >
            <Label htmlFor='service-account-name'>
              {t('apiKeys.application.accountName')}
            </Label>
            <Input
              id='service-account-name'
              // eslint-disable-next-line jsx-a11y/no-autofocus -- 服务账号对话框打开时把焦点放进首个字段，是弹层的默认焦点
              autoFocus
              maxLength={128}
              value={accountName}
              disabled={createSubmission.pending}
              placeholder={t('apiKeys.application.accountNamePlaceholder')}
              onChange={(event) => setAccountName(event.target.value)}
            />
          </form>
          {accountError && !createSubmission.pending ? (
            <p role='alert' className='text-sm text-destructive'>
              {t('apiKeys.application.newAccountFailed')}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={createSubmission.submitting}
              onClick={() => setCreatingAccount(false)}
            >
              {t('apiKeys.common.cancel')}
            </Button>
            <Button
              type='submit'
              form='service-account-create'
              disabled={
                accountName.trim().length === 0 ||
                createSubmission.submitting ||
                createSubmission.pending
              }
            >
              {createSubmission.submitting
                ? t('apiKeys.common.saving')
                : t('apiKeys.common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

/** 选中服务账号的密钥列表、签发、轮换与吊销。切换账号时整个面板重挂载。 */
function AccountKeys({
  account,
}: {
  readonly account: ServiceAccount;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { session } = useAuthentication();
  const path = `${ACCOUNTS}/${encodeURIComponent(account.id)}/keys`;
  const keys = useListData<{ data: ApiKeyRow[]; meta: { total: number } }>(
    path,
  );
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const [lastIssue, setLastIssue] = useState<ApiKeyDraft>();
  const [secret, setSecret] = useState<{ title: string; value: string }>();
  const createSubmission = useSubmission({
    scope: `${session?.user.id}:settings:application-api-keys:${account.id}`,
  });
  const showSecret = useCallback((title: string, value: string) => {
    setSecret({ title, value });
  }, []);
  const rows = keys.data?.data ?? [];
  const keysState = resolveListState(
    {
      data: keys.data,
      error: keys.error,
      isPending: keys.loading && keys.data === undefined,
    },
    rows.length,
    false,
  );

  const issue = async (draft: ApiKeyDraft) => {
    setCreateError(undefined);
    // 页面留着这一次提交的内容：「原样重试」要能原封不动再交一次，钩子才会用同一个幂等键。
    setLastIssue(draft);
    try {
      const outcome = await createSubmission.run(draft, async (key) => {
        const created = await api.request<{
          data: { key: ApiKeyRow; secret?: string };
        }>({
          path,
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          json: {
            name: draft.name,
            ...(draft.description ? { description: draft.description } : {}),
            expiresInDays: draft.expiresInDays,
          },
        });
        return created.data;
      });
      if (!outcome) return;
      setCreating(false);
      if (outcome.secret) {
        showSecret(t('apiKeys.application.issuedTitle'), outcome.secret);
      } else {
        toaster.show({
          type: 'info',
          title: t('apiKeys.common.replayed'),
        });
      }
      keys.reload();
    } catch (error) {
      setCreateError(error);
    }
  };

  /** 核对过列表：清掉未知结果，表单解锁，下一次提交用新的幂等键。 */
  const acknowledgeIssue = () => {
    if (createSubmission.submitting) return;
    createSubmission.acknowledgeOutcome('not-committed');
    setCreateError(undefined);
    keys.reload();
  };

  const columns = useMemo<ColumnDef<ApiKeyRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('apiKeys.common.name'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className='font-medium'>
            {row.original.name ?? t('apiKeys.common.unnamed')}
          </span>
        ),
      },
      {
        id: 'purpose',
        header: t('apiKeys.common.purpose'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className='block max-w-64 truncate text-muted-foreground'>
            {row.original.description ?? '—'}
          </span>
        ),
      },
      {
        id: 'validity',
        header: t('apiKeys.common.validity'),
        enableSorting: false,
        cell: ({ row }) =>
          formatTimestamp(row.original.expiresAt, i18n.language) ??
          t('apiKeys.common.neverExpires'),
      },
      {
        id: 'status',
        header: t('apiKeys.common.status'),
        enableSorting: false,
        cell: ({ row }) => {
          const status = apiKeyStatus(row.original);
          return (
            <StatusBadge tone={statusTone[status]}>
              {t(`apiKeys.common.statusLabel.${status}`)}
            </StatusBadge>
          );
        },
      },
      {
        id: 'lastUsedAt',
        header: t('apiKeys.common.lastUsedAt'),
        enableSorting: false,
        cell: ({ row }) =>
          formatTimestamp(row.original.lastUsedAt, i18n.language) ??
          t('apiKeys.common.neverUsed'),
      },
      {
        id: 'createdAt',
        header: t('apiKeys.common.createdAt'),
        enableSorting: false,
        cell: ({ row }) =>
          formatTimestamp(row.original.createdAt, i18n.language),
      },
      {
        id: 'actions',
        header: () => (
          <span className='sr-only'>{t('apiKeys.common.actions')}</span>
        ),
        enableSorting: false,
        cell: ({ row }) => (
          <ApiKeyRowActions
            keyId={row.original.id}
            keyName={row.original.name ?? t('apiKeys.common.unnamed')}
            canRotate
            onSecret={(value) =>
              showSecret(t('apiKeys.common.rotatedTitle'), value)
            }
            onChanged={keys.reload}
            rotate={async (idempotencyKey) => {
              const rotated = await api.request<{
                data: { key: ApiKeyRow; secret?: string };
              }>({
                path: `${path}/${encodeURIComponent(row.original.id)}/rotate`,
                method: 'POST',
                headers: { 'Idempotency-Key': idempotencyKey },
                json: {},
              });
              return rotated.data.secret;
            }}
            revoke={async (idempotencyKey) => {
              await api.request<void>({
                path: `${path}/${encodeURIComponent(row.original.id)}`,
                method: 'DELETE',
                headers: { 'Idempotency-Key': idempotencyKey },
              });
            }}
          />
        ),
      },
    ],
    [t, i18n.language, showSecret, keys.reload, api, path],
  );

  return (
    <>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 className='font-heading text-base font-semibold'>
          {t('apiKeys.application.keysTitle', { name: account.name })}
        </h2>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          {t('apiKeys.application.issue')}
        </Button>
      </div>
      <SettingsError error={keys.error} retry={keys.reload} inline />
      <DataTable<ApiKeyRow>
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        pagination={false}
        listState={keysState}
        onRetry={keys.reload}
        loading={keys.loading && keys.data !== undefined}
        emptyMessage={t('apiKeys.application.empty')}
      />
      <CreateApiKeyDialog
        open={creating}
        title={t('apiKeys.application.issueTitle')}
        description={t('apiKeys.application.issueDescription')}
        expiryRequired
        busy={createSubmission.submitting}
        pending={createSubmission.pending}
        onRetry={lastIssue ? () => void issue(lastIssue) : undefined}
        onAcknowledge={acknowledgeIssue}
        error={
          createError && !createSubmission.pending
            ? t('apiKeys.application.issueFailed')
            : undefined
        }
        onCancel={() => {
          setCreating(false);
          setCreateError(undefined);
        }}
        onSubmit={(draft) => void issue(draft)}
      />
      <SecretDialog
        open={Boolean(secret)}
        title={secret?.title ?? ''}
        secret={secret?.value ?? ''}
        onClose={() => setSecret(undefined)}
      />
    </>
  );
}

/** `t` 的类型只在 hook 的返回里才有，这里借它给模块级的取名函数用。 */
type Translate = ReturnType<typeof useTranslation>['t'];

/** 权限集的显示名：字符串直接用；描述符按它自己的命名空间翻译；都没有就退回键。 */
function roleName(role: PermissionSetView, t: Translate): string {
  const title = role.title;
  if (title === null) return role.key;
  if (typeof title === 'string') return title;
  return t(title.key, { ns: title.ns, defaultValue: title.key });
}

/**
 * 选中服务账号的角色：旁边列出它持有的权限集，「调整角色」打开对话框。
 * 可选项来自服务端（不含 root 与任何不受限制的权限集），页面不自己拼。
 */
function AccountRoles({
  account,
}: {
  readonly account: ServiceAccount;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { session } = useAuthentication();
  const path = `${ACCOUNTS}/${encodeURIComponent(account.id)}/roles`;
  const roles = useListData<{ data: RolesView }>(path);
  const [adjusting, setAdjusting] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  const submission = useSubmission({
    scope: `${session?.user.id}:settings:application-api-keys:${account.id}:roles`,
  });

  const held = roles.data?.data.roles ?? [];
  const options = roles.data?.data.options ?? [];

  const save = async (keys: string[]) => {
    setSaveError(undefined);
    try {
      const outcome = await submission.run({ keys }, async (key) => {
        const updated = await api.request<{ data: RolesView }>({
          path,
          method: 'PUT',
          headers: { 'Idempotency-Key': key },
          json: { keys },
        });
        return updated.data;
      });
      if (!outcome) return;
      setAdjusting(false);
      roles.replaceData({ data: outcome });
      toaster.show({
        type: 'success',
        title: t('apiKeys.application.rolesSaved'),
      });
    } catch (error) {
      setSaveError(error);
    }
  };

  return (
    <div className='flex min-w-0 flex-col gap-2'>
      <span className='text-sm font-medium'>
        {t('apiKeys.application.roles')}
      </span>
      <div className='flex flex-wrap items-center gap-2'>
        {roles.data && held.length === 0 ? (
          <span className='text-sm text-muted-foreground'>
            {t('apiKeys.application.noRoles')}
          </span>
        ) : null}
        {held.map((role) => (
          <Badge key={role.key} variant='secondary'>
            {roleName(role, t)}
          </Badge>
        ))}
        <Button
          variant='outline'
          disabled={!roles.data}
          onClick={() => {
            setSaveError(undefined);
            setAdjusting(true);
          }}
        >
          {t('apiKeys.application.adjustRoles')}
        </Button>
      </div>
      <SettingsError error={roles.error} retry={roles.reload} inline />
      <AdjustRolesDialog
        open={adjusting}
        accountName={account.name}
        options={options}
        selected={held.map((role) => role.key)}
        busy={submission.submitting}
        error={saveError ? t('apiKeys.application.rolesSaveFailed') : undefined}
        onCancel={() => {
          setAdjusting(false);
          setSaveError(undefined);
        }}
        onSubmit={(keys) => void save(keys)}
      />
    </div>
  );
}

/**
 * 调整角色的对话框。勾选的是「这个服务账号持有哪些权限集」，保存时整体替换：
 * 空选表示一个都不给。
 */
function AdjustRolesDialog({
  open,
  accountName,
  options,
  selected,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly open: boolean;
  readonly accountName: string;
  readonly options: readonly PermissionSetView[];
  readonly selected: readonly string[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onSubmit: (keys: string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('apiKeys.application.rolesTitle', { name: accountName })}
          </DialogTitle>
          <DialogDescription>
            {t('apiKeys.application.rolesDescription')}
          </DialogDescription>
        </DialogHeader>
        {/* 表单只在打开时挂载，每次打开都按当前的角色重新开始；不用 effect 重置字段。 */}
        {open ? (
          <AdjustRolesForm
            options={options}
            selected={selected}
            busy={busy}
            error={error}
            onCancel={onCancel}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AdjustRolesForm({
  options,
  selected,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly options: readonly PermissionSetView[];
  readonly selected: readonly string[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onSubmit: (keys: string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<string[]>([...selected]);
  const toggle = (key: string, on: boolean) =>
    setKeys((current) =>
      on
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((item) => item !== key),
    );
  return (
    <>
      <form
        id='service-account-roles'
        className='flex max-h-80 flex-col gap-3 overflow-y-auto'
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          onSubmit(keys);
        }}
      >
        {options.map((role) => {
          const name = roleName(role, t);
          const id = `service-account-role-${role.key}`;
          return (
            <label
              key={role.key}
              htmlFor={id}
              className='flex cursor-pointer items-start gap-2 text-sm'
            >
              <Checkbox
                id={id}
                className='mt-0.5'
                checked={keys.includes(role.key)}
                aria-label={name}
                disabled={busy}
                onCheckedChange={(on: boolean) => toggle(role.key, on)}
              />
              <span className='break-words'>{name}</span>
            </label>
          );
        })}
      </form>
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant='outline' disabled={busy} onClick={onCancel}>
          {t('apiKeys.common.cancel')}
        </Button>
        <Button type='submit' form='service-account-roles' disabled={busy}>
          {busy ? t('apiKeys.common.saving') : t('apiKeys.common.save')}
        </Button>
      </DialogFooter>
    </>
  );
}
