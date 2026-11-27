import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, OverlayNote } from '#components/erp/form-route';

import { BizDictClient, DICT_TYPES } from './client.js';
import { EntryFields } from './form.js';
import {
  EMPTY_ENTRY_FORM,
  entryCreateInput,
  entryFieldErrors,
  validateEntry,
} from './model.js';
import { BIZ_DICT_RESOURCE } from './page-id.js';

/** 新建一条字典取值（`/biz-dict/new?type=…`）：码要手填，建成后不能改；额外列由类型决定。 */
export default function BizDictNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [params] = useSearchParams();
  const requested = params.get('type') ?? '';
  const dictType = (DICT_TYPES as readonly string[]).includes(requested)
    ? requested
    : '';
  const client = useMemo(() => new BizDictClient(api), [api]);
  const manage = useCan({ resource: BIZ_DICT_RESOURCE, action: 'manage' });
  const title = t('bizDict.form.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      {dictType === '' ? (
        <OverlayNote title={title}>{t('bizDict.errors.invalidType')}</OverlayNote>
      ) : (
        <FormDialog
          title={title}
          description={t('bizDict.form.codeHint')}
          submitLabel={t('erp.actions.create')}
          initialValues={EMPTY_ENTRY_FORM}
          validate={(values) => validateEntry(values, dictType, t)}
          fieldErrors={entryFieldErrors}
          save={(values) => client.create(entryCreateInput(values, dictType))}
          onSuccess={(entry) =>
            toaster.show({
              type: 'success',
              title: t('bizDict.createdToast', { name: entry.name }),
            })
          }
        >
          {(form) => <EntryFields form={form} dictType={dictType} />}
        </FormDialog>
      )}
    </FormRoute>
  );
}
