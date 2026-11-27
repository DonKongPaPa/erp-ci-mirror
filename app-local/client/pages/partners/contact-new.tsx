import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import {
  FormRoute,
  OverlayNote,
  RecordRoute,
} from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { ContactFormFields } from './contact-form.js';
import { PartnersClient, type PartnerDetail } from './client.js';
import {
  contactInputOf,
  EMPTY_CONTACT_FORM,
  validateContact,
} from './model.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

/** 添加联系人（`/partners/:partnerId/contacts/new`）：叠在详情抽屉上的对话框。单位停用后不能再加。 */
export default function PartnerContactNewPage(): ReactElement {
  const { partnerId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const customerView = useCan({ resource: CUSTOMERS_RESOURCE, action: 'view' });
  const supplierView = useCan({ resource: SUPPLIERS_RESOURCE, action: 'view' });
  const customerUpdate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'update',
  });
  const supplierUpdate = useCan({
    resource: SUPPLIERS_RESOURCE,
    action: 'update',
  });
  const pending = customerUpdate.isPending || supplierUpdate.isPending;
  const record = useRecord<PartnerDetail>(
    `partners/${encodeURIComponent(partnerId)}`,
    pending ? undefined : customerView.can || supplierView.can,
  );
  const title = t('partners.contact.addTitle');
  return (
    <FormRoute
      title={title}
      pending={pending}
      allowed={customerUpdate.can || supplierUpdate.can}
    >
      <RecordRoute title={title} record={record}>
        {(detail) =>
          (detail.isCustomer && customerUpdate.can) ||
          (detail.isSupplier && supplierUpdate.can) ? (
            detail.status === 'active' ? (
              <FormDialog
                title={title}
                description={t('partners.contact.addDescription', {
                  name: detail.name,
                })}
                submitLabel={t('erp.actions.add')}
                initialValues={EMPTY_CONTACT_FORM}
                validate={(values) => validateContact(values, t)}
                save={(values) =>
                  client.addContact(detail.id, contactInputOf(values))
                }
                onSuccess={() =>
                  toaster.show({
                    type: 'success',
                    title: t('partners.contact.addedToast'),
                  })
                }
              >
                {(form) => <ContactFormFields form={form} />}
              </FormDialog>
            ) : (
              <OverlayNote title={title}>
                {t('partners.errors.inactive')}
              </OverlayNote>
            )
          ) : (
            <OverlayNote title={title}>{t('erp.form.noWrite')}</OverlayNote>
          )
        }
      </RecordRoute>
    </FormRoute>
  );
}
