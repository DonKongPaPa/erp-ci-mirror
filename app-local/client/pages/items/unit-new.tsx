import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute } from '#components/erp/form-route';

import { ItemsClient } from './client.js';
import {
  EMPTY_UNIT_FORM,
  unitCreateInput,
  unitFieldErrors,
  validateUnit,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';
import { UnitFields } from './unit-form.js';

/** 新建计量单位（`/items/units/new`）：编码由人填，建好后不能改。 */
export default function UnitNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const title = t('items.units.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <FormDialog
        title={title}
        submitLabel={t('erp.actions.create')}
        initialValues={EMPTY_UNIT_FORM}
        validate={(values) => validateUnit(values, t, true)}
        fieldErrors={unitFieldErrors}
        save={(values) => client.createUnit(unitCreateInput(values))}
        onSuccess={(unit) =>
          toaster.show({
            type: 'success',
            title: t('items.createdToast', {
              noun: t('items.units.noun'),
              name: unit.name,
            }),
          })
        }
        size='narrow'
      >
        {(form) => <UnitFields form={form} />}
      </FormDialog>
    </FormRoute>
  );
}
