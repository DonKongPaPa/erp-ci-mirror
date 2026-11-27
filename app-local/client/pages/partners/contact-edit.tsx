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
  validateContact,
  type ContactFormValues,
} from './model.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

/** 编辑联系人（`/partners/:partnerId/contacts/:contactId/edit`）。勾上「设为首要联系人」后原来的让位。 */
export default function PartnerContactEditPage(): ReactElement {
  const { partnerId = '', contactId = '' } = useParams();
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
  const title = t('partners.contact.editTitle');
  return (
    <FormRoute
      title={title}
      pending={pending}
      allowed={customerUpdate.can || supplierUpdate.can}
    >
      <RecordRoute title={title} record={record}>
        {(detail) => {
          const contact = detail.contacts.find(
            (entry) => entry.id === contactId,
          );
          if (!contact)
            return (
              <OverlayNote title={title}>
                {t('erp.errors.notFound')}
              </OverlayNote>
            );
          if (!(
            (detail.isCustomer && customerUpdate.can) ||
            (detail.isSupplier && supplierUpdate.can)
          ))
            return (
              <OverlayNote title={title}>{t('erp.form.noWrite')}</OverlayNote>
            );
          if (detail.status !== 'active')
            return (
              <OverlayNote title={title}>
                {t('partners.errors.inactive')}
              </OverlayNote>
            );
          const initialValues: ContactFormValues = {
            name: contact.name,
            title: contact.title ?? '',
            phone: contact.phone ?? '',
            email: contact.email ?? '',
            isPrimary: contact.isPrimary,
          };
          return (
            <FormDialog
              key={contact.id}
              title={title}
              description={t('partners.contact.editDescription', {
                name: contact.name,
                partner: detail.name,
              })}
              submitLabel={t('erp.actions.save')}
              initialValues={initialValues}
              validate={(values) => validateContact(values, t)}
              save={(values) =>
                client.updateContact(
                  detail.id,
                  contact.id,
                  contactInputOf(values),
                )
              }
              onSuccess={(saved) =>
                toaster.show({
                  type: 'success',
                  title: t('partners.contact.savedToast', { name: saved.name }),
                })
              }
            >
              {(form) => <ContactFormFields form={form} />}
            </FormDialog>
          );
        }}
      </RecordRoute>
    </FormRoute>
  );
}
