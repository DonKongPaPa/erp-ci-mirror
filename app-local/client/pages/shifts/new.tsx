import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { FormRoute } from '#components/erp/form-route';
import { FormDialog } from '#components/erp/form-dialog';

import { ShiftsClient } from './client.js';
import { ShiftFormFields } from './form.js';
import {
  EMPTY_SHIFT_FORM,
  inputOf,
  shiftFieldErrors,
  validateShiftForm,
} from './model.js';
import { SHIFTS_RESOURCE } from './page-id.js';

/** 新建班次（`/shifts/new`）：路由上的对话框，编码由人填，时间按时分填。 */
export default function ShiftNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ShiftsClient(api), [api]);
  const manage = useCan({ resource: SHIFTS_RESOURCE, action: 'manage' });
  const title = t('shifts.form.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <FormDialog
        title={title}
        description={t('shifts.form.newDescription')}
        submitLabel={t('erp.actions.create')}
        initialValues={EMPTY_SHIFT_FORM}
        validate={(values) => validateShiftForm(values, t, true)}
        fieldErrors={shiftFieldErrors}
        save={(values) => client.create(inputOf(values))}
        onSuccess={(shift) =>
          toaster.show({
            type: 'success',
            title: t('shifts.createdToast', { name: shift.title }),
          })
        }
      >
        {(form) => <ShiftFormFields form={form} mode='new' />}
      </FormDialog>
    </FormRoute>
  );
}
