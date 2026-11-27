import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';

import type { EntityPage } from '#components/erp/list-state';
import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useListData } from '#hooks/use-list-data';

import { BizDictClient, DICT_TYPES, type Entry } from './client.js';
import { EntryFields } from './form.js';
import {
  entryFieldErrors,
  entryFormOf,
  entryUpdateInput,
  validateEntry,
} from './model.js';
import { BIZ_DICT_RESOURCE } from './page-id.js';

/**
 * 编辑一条字典取值（`/biz-dict/:entryId/edit`）：R-072 没有单条详情端点，
 * 优先用列表行经路由 state 带过来的那一行；直接敲地址或刷新时重新取该类型的在用与停用两页，
 * 按 id 找回同一行。码与类型画成只读，保存走既有的 PATCH，停用与启用在列表上做。
 */
export default function BizDictEditPage(): ReactElement {
  const { entryId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new BizDictClient(api), [api]);
  const view = useCan({ resource: BIZ_DICT_RESOURCE, action: 'view' });
  const manage = useCan({ resource: BIZ_DICT_RESOURCE, action: 'manage' });
  const pending = view.isPending || manage.isPending;
  const location = useLocation();
  const [params] = useSearchParams();
  const requested = params.get('type') ?? '';
  const dictType = (DICT_TYPES as readonly string[]).includes(requested)
    ? requested
    : '';
  const state = location.state as { entry?: Entry } | null | undefined;
  const listed = state?.entry?.id === entryId ? state.entry : undefined;
  const needFetch = listed === undefined && !pending && view.can && dictType !== '';
  const listPath = (status: 'active' | 'inactive') =>
    `biz-dict/entries?dictType=${encodeURIComponent(dictType)}&status=${status}&pageSize=100`;
  const active = useListData<EntityPage<Entry>>(listPath('active'), {
    active: needFetch,
  });
  const inactive = useListData<EntityPage<Entry>>(listPath('inactive'), {
    active: needFetch,
  });
  const entry =
    listed ??
    [...(active.data?.items ?? []), ...(inactive.data?.items ?? [])].find(
      (row) => row.id === entryId,
    );
  const title = t('bizDict.form.editTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={manage.can}>
      <RecordRoute
        title={title}
        record={{
          data: entry,
          loading: entry === undefined,
          error: needFetch ? (active.error ?? inactive.error) : undefined,
        }}
      >
        {(entry) => (
          <FormDialog
            key={entry.updatedAt}
            title={title}
            description={t('bizDict.form.editDescription', {
              code: entry.code,
            })}
            submitLabel={t('erp.actions.save')}
            initialValues={entryFormOf(entry)}
            validate={(values) => validateEntry(values, entry.dictType, t)}
            fieldErrors={entryFieldErrors}
            save={(values) =>
              client.update(entry.id, entryUpdateInput(values, entry.dictType))
            }
            onSuccess={(saved) =>
              toaster.show({
                type: 'success',
                title: t('bizDict.savedToast', { name: saved.name }),
              })
            }
          >
            {(form) => (
              <EntryFields form={form} dictType={entry.dictType} entry={entry} />
            )}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
