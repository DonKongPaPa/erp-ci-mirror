import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import {
  resolveListState,
  useApiClient,
  useSubmission,
  useToaster,
} from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import {
  CreateApiKeyDialog,
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
import { Button } from '#components/ui/button';
import { useListData } from '#hooks/use-list-data';
import { SettingsError } from '../settings/shared.js';
import type { ColumnDef } from '@tanstack/react-table';

/**
 * R-032「我的 API 密钥」：每个登录用户自己的凭据。
 *
 * 列表、创建、轮换、吊销都走插件现成的 `/api/apiKeys/*`，只作用于当前登录的人，
 * 且只认登录会话。应用没有登记任何权限范围组，所以这里不显示范围选项 —— 密钥的
 * 权限就是本人的权限。
 *
 * 创建与轮换按 `/apiKeys/scopeOptions` 的 `mayCreate` 显示：本应用把它收紧到 root。
 * 列出与吊销不受影响，丢权限的人仍然能清理自己已有的密钥。
 */

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

interface ScopeOptions {
  groups: unknown[];
  mayCreate: boolean;
  defaultExpiresInDays: number;
  maxScopedKeyDays: number | null;
}

const statusTone: Record<ApiKeyStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  expired: 'warning',
  disabled: 'neutral',
};

export default function MyApiKeysPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { session } = useAuthentication();
  const keys = useListData<{ data: ApiKeyRow[]; meta: { total: number } }>(
    'apiKeys',
  );
  const options = useListData<{ data: ScopeOptions }>('apiKeys/scopeOptions');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const [lastDraft, setLastDraft] = useState<ApiKeyDraft>();
  const [secret, setSecret] = useState<{ title: string; value: string }>();
  const createSubmission = useSubmission({
    scope: `${session?.user.id}:account:api-keys:create`,
  });

  const mayCreate = options.data?.data.mayCreate === true;
  const defaultExpiry = options.data?.data.defaultExpiresInDays ?? 90;
  const rows = keys.data?.data ?? [];
  const listState = resolveListState(
    {
      data: keys.data,
      error: keys.error,
      isPending: keys.loading && keys.data === undefined,
    },
    rows.length,
    false,
  );

  const showSecret = useCallback((title: string, value: string) => {
    setSecret({ title, value });
  }, []);

  const create = async (draft: ApiKeyDraft) => {
    setCreateError(undefined);
    // 页面留着这一次提交的内容：「原样重试」要能原封不动再交一次，钩子才会用同一个幂等键。
    setLastDraft(draft);
    try {
      const outcome = await createSubmission.run(draft, async (key) => {
        const created = await api.request<{
          data: { key: ApiKeyRow; secret?: string };
        }>({
          path: 'apiKeys',
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          json: {
            name: draft.name,
            description: draft.description ?? null,
            expiresInDays: draft.expiresInDays,
            scope: null,
          },
        });
        return created.data;
      });
      if (!outcome) return;
      setCreating(false);
      if (outcome.secret) {
        showSecret(t('apiKeys.personal.createdTitle'), outcome.secret);
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
  const acknowledgeCreate = () => {
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
            canRotate={mayCreate}
            onSecret={(value) =>
              showSecret(t('apiKeys.common.rotatedTitle'), value)
            }
            onChanged={keys.reload}
            rotate={async () => {
              const rotated = await api.request<{
                data: { key: ApiKeyRow; secret: string };
              }>({
                path: `apiKeys/${encodeURIComponent(row.original.id)}/rotate`,
                method: 'POST',
                json: {},
              });
              return rotated.data.secret;
            }}
            revoke={async () => {
              await api.request<void>({
                path: `apiKeys/${encodeURIComponent(row.original.id)}`,
                method: 'DELETE',
              });
            }}
          />
        ),
      },
    ],
    [t, i18n.language, mayCreate, showSecret, keys.reload, api],
  );

  return (
    <PageContainer>
      <PageHeader
        title={t('apiKeys.personal.title')}
        description={t('apiKeys.personal.description')}
        actions={
          mayCreate ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('apiKeys.personal.create')}
            </Button>
          ) : undefined
        }
      />
      {!mayCreate && options.data ? (
        <p className='text-sm text-muted-foreground'>
          {t('apiKeys.personal.createForbidden')}
        </p>
      ) : null}
      <SettingsError
        error={options.error ?? keys.error}
        retry={options.error ? options.reload : keys.reload}
      />
      <DataTable<ApiKeyRow>
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        pagination={false}
        listState={listState}
        onRetry={keys.reload}
        loading={keys.loading && keys.data !== undefined}
        emptyMessage={t('apiKeys.personal.empty')}
      />
      <CreateApiKeyDialog
        open={creating}
        title={t('apiKeys.personal.createTitle')}
        description={t('apiKeys.personal.createDescription')}
        expiryRequired={false}
        defaultDays={defaultExpiry}
        busy={createSubmission.submitting}
        pending={createSubmission.pending}
        onRetry={lastDraft ? () => void create(lastDraft) : undefined}
        onAcknowledge={acknowledgeCreate}
        error={
          createError && !createSubmission.pending
            ? t('apiKeys.personal.createFailed')
            : undefined
        }
        onCancel={() => {
          setCreating(false);
          setCreateError(undefined);
        }}
        onSubmit={(draft) => void create(draft)}
      />
      <SecretDialog
        open={Boolean(secret)}
        title={secret?.title ?? ''}
        secret={secret?.value ?? ''}
        onClose={() => setSecret(undefined)}
      />
    </PageContainer>
  );
}
