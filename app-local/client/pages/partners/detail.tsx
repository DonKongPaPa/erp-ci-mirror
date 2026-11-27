import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Link, Outlet, useParams } from 'react-router';

import { DataTable } from '#components/data-table';
import { ConfirmDialog } from '#components/erp/confirm';
import {
  ActiveBadge,
  DetailFields,
  DetailSection,
  RecordDrawer,
  TypeBadge,
} from '#components/erp/detail';
import { errorText } from '#components/erp/messages';
import { RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';
import { RowActions } from '#components/row-actions';
import { StatusBadge } from '#components/status-badge';
import { Button } from '#components/ui/button';

import {
  PartnersClient,
  type Address,
  type Contact,
  type PartnerDetail,
} from './client.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

const DASH = <span className='text-muted-foreground'>—</span>;

/**
 * 往来单位的详情抽屉（`/partners/:partnerId`）：基本信息加一张联系人表，页脚是停用与编辑。
 * 联系人只能加、不能删；电话、邮箱、地址不进列表，只在这里看。
 */
export default function PartnerDetailPage(): ReactElement {
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
  const pending = customerView.isPending || supplierView.isPending;
  const record = useRecord<PartnerDetail>(
    `partners/${encodeURIComponent(partnerId)}`,
    pending ? undefined : customerView.can || supplierView.can,
  );
  return (
    <>
      {/* 编辑与联系人的路由对话框叠在抽屉上，从这个出口出来；直接敲它们的地址时抽屉还在读，也要先有这个出口。 */}
      <Outlet />
      <RecordRoute title={t('partners.title')} record={record} drawer>
        {(detail) => (
          <PartnerDrawer
            detail={detail}
            client={client}
            reload={record.reload}
            notify={toaster}
            canUpdate={
              (detail.isCustomer && customerUpdate.can) ||
              (detail.isSupplier && supplierUpdate.can)
            }
            canUpdateAddresses={customerUpdate.can}
          />
        )}
      </RecordRoute>
    </>
  );
}

function PartnerDrawer({
  detail,
  client,
  reload,
  notify,
  canUpdate,
  canUpdateAddresses,
}: {
  readonly detail: PartnerDetail;
  readonly client: PartnersClient;
  readonly reload: () => void;
  readonly notify: ReturnType<typeof useToaster>;
  readonly canUpdate: boolean;
  readonly canUpdateAddresses: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const base = `/partners/${encodeURIComponent(detail.id)}`;
  const active = detail.status === 'active';
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const changeStatus = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await client.update(detail.id, {
        status: active ? 'inactive' : 'active',
      });
      notify.show({
        type: 'success',
        title: active
          ? t('partners.deactivatedToast', { name: detail.name })
          : t('partners.activatedToast', { name: detail.name }),
      });
      setStopping(false);
      reload();
    } catch (next) {
      // 停用有确认框，错写在框里；启用没有，错用提示说。
      const text = errorText(next, t);
      if (active) setError(text);
      else notify.show({ type: 'error', title: text });
    } finally {
      setBusy(false);
    }
  };

  const contactColumns = useMemo<ColumnDef<Contact>[]>(
    () => [
      {
        id: 'name',
        header: t('erp.fields.name'),
        cell: ({ row }) => (
          <span className='font-medium'>{row.original.name}</span>
        ),
      },
      {
        id: 'title',
        header: t('partners.contact.title'),
        cell: ({ row }) => row.original.title ?? DASH,
      },
      {
        id: 'phone',
        header: t('erp.fields.phone'),
        cell: ({ row }) => row.original.phone ?? DASH,
      },
      {
        id: 'email',
        header: t('erp.fields.email'),
        cell: ({ row }) => row.original.email ?? DASH,
      },
      {
        id: 'primary',
        header: t('partners.contact.isPrimary'),
        cell: ({ row }) =>
          row.original.isPrimary ? (
            <StatusBadge size='sm' tone='info'>
              {t('partners.contact.primary')}
            </StatusBadge>
          ) : (
            DASH
          ),
      },
      ...(canUpdate && active
        ? [
            {
              id: 'actions',
              header: () => (
                <span className='sr-only'>{t('erp.fields.actions')}</span>
              ),
              cell: ({ row }: CellContext<Contact, unknown>) => (
                <RowActions
                  label={t('erp.fields.actionsFor', {
                    name: row.original.name,
                  })}
                  actions={[
                    {
                      key: 'edit',
                      label: t('erp.actions.edit'),
                      render: (
                        <Link
                          to={`${base}/contacts/${encodeURIComponent(row.original.id)}/edit`}
                        />
                      ),
                    },
                  ]}
                />
              ),
            },
          ]
        : []),
    ],
    [t, canUpdate, active, base],
  );

  return (
    <RecordDrawer
      title={detail.name}
      badges={
        <>
          {detail.isCustomer ? (
            <TypeBadge>{t('partners.kind.customer')}</TypeBadge>
          ) : null}
          {detail.isSupplier ? (
            <TypeBadge>{t('partners.kind.supplier')}</TypeBadge>
          ) : null}
          <ActiveBadge active={active} />
        </>
      }
      description={t('partners.codeLabel', { code: detail.code })}
      wide
      footer={
        canUpdate ? (
          <>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => (active ? setStopping(true) : void changeStatus())}
            >
              {active ? t('erp.actions.deactivate') : t('erp.actions.activate')}
            </Button>
            <Button nativeButton={false} render={<Link to={`${base}/edit`} />}>
              {t('erp.actions.edit')}
            </Button>
          </>
        ) : undefined
      }
    >
      <DetailSection title={t('erp.detail.basic')}>
        <DetailFields
          fields={[
            { label: t('erp.fields.name'), value: detail.name },
            { label: t('erp.fields.code'), value: detail.code },
            {
              label: t('erp.fields.type'),
              value: [
                detail.isCustomer ? t('partners.kind.customer') : '',
                detail.isSupplier ? t('partners.kind.supplier') : '',
              ]
                .filter(Boolean)
                .join('、'),
            },
            {
              label: t('erp.fields.status'),
              value: active ? t('erp.status.active') : t('erp.status.inactive'),
            },
            { label: t('erp.fields.contact'), value: detail.contactName },
            { label: t('erp.fields.phone'), value: detail.phone },
            { label: t('erp.fields.email'), value: detail.email },
            { label: t('erp.fields.taxId'), value: detail.taxId },
            {
              label: t('erp.fields.address'),
              value: detail.address,
              wide: true,
            },
            { label: t('erp.fields.note'), value: detail.note, wide: true },
            ...('customerGroupCode' in detail
              ? [
                  {
                    label: t('partners.fields.customerGroup'),
                    value: detail.customerGroupCode,
                  },
                  {
                    label: t('partners.fields.salesperson'),
                    value: detail.salesperson?.name ?? null,
                  },
                ]
              : []),
            ...('supplierGroupCode' in detail
              ? [
                  {
                    label: t('partners.fields.supplierGroup'),
                    value: detail.supplierGroupCode,
                  },
                  {
                    label: t('partners.fields.buyer'),
                    value: detail.buyer?.name ?? null,
                  },
                  {
                    label: t('partners.fields.payeeAccountNo'),
                    value: detail.payeeAccountNo,
                  },
                  {
                    label: t('partners.fields.payeeBankName'),
                    value: detail.payeeBankName,
                  },
                  {
                    label: t('partners.fields.payeeBankCode'),
                    value: detail.payeeBankCode,
                  },
                ]
              : []),
          ]}
        />
      </DetailSection>
      <DetailSection
        title={t('partners.contacts')}
        actions={
          canUpdate && active ? (
            <Button
              size='sm'
              nativeButton={false}
              render={<Link to={`${base}/contacts/new`} />}
            >
              <PlusIcon aria-hidden='true' />
              {t('partners.contact.add')}
            </Button>
          ) : undefined
        }
      >
        <DataTable<Contact>
          columns={contactColumns}
          data={detail.contacts}
          getRowId={(contact) => contact.id}
          pagination={false}
          showSelectedCount={false}
          sortableColumns={[]}
          emptyMessage={t('partners.contact.empty')}
        />
      </DetailSection>
      {'addresses' in detail && detail.isCustomer && canUpdateAddresses ? (
        <AddressSection
          detail={detail}
          client={client}
          notify={notify}
          reload={reload}
        />
      ) : null}
      <ConfirmDialog
        open={stopping}
        title={t('partners.deactivateTitle', { name: detail.name })}
        description={t('partners.deactivateDescription')}
        confirmLabel={t('erp.actions.deactivate')}
        error={error ? <span role='alert'>{error}</span> : undefined}
        busy={busy}
        onCancel={() => setStopping(false)}
        onConfirm={() => void changeStatus()}
      />
    </RecordDrawer>
  );
}


/**
 * 客户详情的交货地址（R-014 加片）：默认地址在前，能新增、编辑、设默认、停用与启用，没有删除。
 * 两条写端点只认 customers.update，所以整个分节只有 customerUpdate 才画。
 */
function AddressSection({
  detail,
  client,
  notify,
  reload,
}: {
  readonly detail: PartnerDetail;
  readonly client: PartnersClient;
  readonly notify: ReturnType<typeof useToaster>;
  readonly reload: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const base = `/partners/${encodeURIComponent(detail.id)}`;
  const active = detail.status === 'active';

  const change = async (
    address: Address,
    patch: { readonly isDefault?: boolean; readonly status?: 'active' | 'inactive' },
    message: string,
  ): Promise<void> => {
    try {
      await client.updateAddress(detail.id, address.id, patch);
      notify.show({ type: 'success', title: message });
      reload();
    } catch (next) {
      notify.show({ type: 'error', title: errorText(next, t) });
    }
  };

  const changeRef = useRef(change);
  useEffect(() => {
    changeRef.current = change;
  });
  const columns = useMemo<ColumnDef<Address>[]>(() => {
    const actions: ColumnDef<Address> = {
      id: 'actions',
      header: () => <span className='sr-only'>{t('erp.fields.actions')}</span>,
      cell: ({ row }: CellContext<Address, unknown>) => {
        const address = row.original;
        return (
          <RowActions
            label={t('erp.fields.actionsFor', { name: address.address })}
            actions={[
              {
                key: 'edit',
                label: t('erp.actions.edit'),
                render: (
                  <Link
                    to={`${base}/addresses/${encodeURIComponent(address.id)}/edit`}
                  />
                ),
              },
              ...(!address.isDefault && active
                ? [
                    {
                      key: 'setDefault',
                      label: t('partners.address.setDefault'),
                      onClick: () =>
                        void changeRef.current(
                          address,
                          { isDefault: true },
                          t('partners.address.defaultToast', {
                            address: address.address,
                          }),
                        ),
                    },
                  ]
                : []),
              address.status === 'active'
                ? {
                    key: 'deactivate',
                    label: t('erp.actions.deactivate'),
                    destructive: true,
                    onClick: () =>
                      void changeRef.current(
                        address,
                        { status: 'inactive' },
                        t('partners.address.deactivatedToast'),
                      ),
                  }
                : {
                    key: 'activate',
                    label: t('erp.actions.activate'),
                    onClick: () =>
                      void changeRef.current(
                        address,
                        { status: 'active' },
                        t('partners.address.activatedToast'),
                      ),
                  },
            ]}
          />
        );
      },
    };
    return [
      {
        id: 'address',
        header: t('partners.address.address'),
        cell: ({ row }) => row.original.address,
      },
      {
        id: 'isDefault',
        header: t('partners.address.isDefault'),
        cell: ({ row }) =>
          row.original.isDefault ? (
            <StatusBadge size='sm' tone='info'>
              {t('partners.address.default')}
            </StatusBadge>
          ) : (
            DASH
          ),
      },
      {
        id: 'status',
        header: t('erp.fields.status'),
        cell: ({ row }) => (
          <ActiveBadge active={row.original.status === 'active'} />
        ),
      },
      actions,
    ];
  }, [t, base, active]);

  return (
    <DetailSection
      title={t('partners.address.title')}
      actions={
        active ? (
          <Button
            size='sm'
            nativeButton={false}
            render={<Link to={`${base}/addresses/new`} />}
          >
            <PlusIcon aria-hidden='true' />
            {t('partners.address.add')}
          </Button>
        ) : undefined
      }
    >
      <DataTable<Address>
        columns={columns}
        data={detail.addresses ?? []}
        getRowId={(address) => address.id}
        pagination={false}
        showSelectedCount={false}
        sortableColumns={[]}
        emptyMessage={t('partners.address.empty')}
      />
    </DetailSection>
  );
}
