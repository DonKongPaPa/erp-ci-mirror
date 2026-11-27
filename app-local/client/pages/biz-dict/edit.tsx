import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { BizDictClient, type Entry } from './client.js';
import { EntryFields } from './form.js';
import {
  entryFieldErrors,
  entryFormOf,
  entryUpdateInput,
  validateEntry,
} from './model.js';
import { BIZ_DICT_RESOURCE } from './page-id.js';

/**
 * 编辑一条字典取值（`/biz-dict/:entryId/edit`）：先读最新的一条，码与类型画成只读；
 * 停用与启用在列表上做，这里只改名称、适用类型的额外列、默认与排序。
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
  const record = useRecord<Entry>(
    `biz-dict/entries/${encodeURIComponent(entryId)}`,
    pending ? undefined : view.can,
  );
  const title = t('bizDict.form.editTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
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
