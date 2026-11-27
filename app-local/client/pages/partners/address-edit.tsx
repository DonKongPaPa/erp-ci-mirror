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

import { AddressFields } from './address-form.js';
import { PartnersClient, type PartnerDetail } from './client.js';
import { validateAddress, type AddressFormValues } from './model.js';
import { CUSTOMERS_RESOURCE } from './page-id.js';

/** 编辑交货地址（`/partners/:partnerId/addresses/:addressId/edit`）：只改地址文本，设默认与停用是列表上的动作。 */
export default function PartnerAddressEditPage(): ReactElement {
  const { partnerId = '', addressId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const customerView = useCan({ resource: CUSTOMERS_RESOURCE, action: 'view' });
  const customerUpdate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'update',
  });
  const pending = customerUpdate.isPending || customerView.isPending;
  const record = useRecord<PartnerDetail>(
    `partners/${encodeURIComponent(partnerId)}`,
    pending ? undefined : customerView.can,
  );
  const title = t('partners.address.editTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={customerUpdate.can}>
      <RecordRoute title={title} record={record}>
        {(detail) => {
          const address = detail.addresses?.find(
            (entry) => entry.id === addressId,
          );
          if (!address)
            return (
              <OverlayNote title={title}>{t('erp.errors.notFound')}</OverlayNote>
            );
          if (!detail.isCustomer || !customerUpdate.can)
            return (
              <OverlayNote title={title}>
                {t('partners.address.notCustomer')}
              </OverlayNote>
            );
          const initialValues: AddressFormValues = {
            address: address.address,
            isDefault: false,
          };
          return (
            <FormDialog
              key={address.updatedAt}
              title={title}
              description={t('partners.address.editDescription', {
                name: detail.name,
              })}
              submitLabel={t('erp.actions.save')}
              initialValues={initialValues}
              validate={(values) => validateAddress(values, t)}
              save={(values) =>
                client.updateAddress(detail.id, address.id, {
                  address: values.address.trim(),
                })
              }
              onSuccess={() =>
                toaster.show({
                  type: 'success',
                  title: t('partners.address.savedToast'),
                })
              }
            >
              {(form) => <AddressFields form={form} showDefault={false} />}
            </FormDialog>
          );
        }}
      </RecordRoute>
    </FormRoute>
  );
}
