import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group';
import { Skeleton } from '#components/ui/skeleton';
import { cn } from 'cn';

import { useSettingsData } from '../hooks.js';
import {
  EmployeesClient,
  type EmployeeRow,
} from './client.js';
import { employeeColumns } from './columns.js';
import {
  DetailDialog,
  DictionaryPanel,
  HireDialog,
  LeaveDialog,
  LinkDialog,
  RehireDialog,
  TransferDialog,
} from './dialogs.js';
import { employeeMessage, rejectionReasons } from './messages.js';
import { EMPLOYEE_ROW_CLASS, SKELETON_WIDTHS } from './model.js';
import { EMPLOYEES_RESOURCE } from './page-id.js';

type Dialog = 'detail' | 'hire' | 'link' | 'transfer' | 'leave' | 'rehire' | null;

interface EmployeeListResult {
  readonly data: readonly EmployeeRow[];
  readonly meta?: { readonly total: number; readonly page: number; readonly pageSize: number };
}

/** R-011 员工管理页：列表、详情、入离职与两个字典。邮箱不进页面。 */
export default function EmployeesPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new EmployeesClient(api), [api]);
  const view = useCan({ resource: EMPLOYEES_RESOURCE, action: 'view' });
  const manage = useCan({ resource: EMPLOYEES_RESOURCE, action: 'manage' });
  const columns = employeeColumns();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [active, setActive] = useState<EmployeeRow | undefined>();

  const params = new URLSearchParams({ page: '1', pageSize: '20' });
  if (scope === 'active') params.set('status', 'active');
  if (q.trim()) params.set('q', q.trim());
  const list = useSettingsData<EmployeeListResult>(`employees?${params.toString()}`, {
    keepPreviousData: true,
    active: view.can,
  });
  const rows = list.data?.data ?? [];

  const done = (message: string) => {
    setDialog(null);
    setActive(undefined);
    toaster.show({ type: 'success', title: message });
    list.reload();
  };

  let body: ReactElement;
  if (view.isPending) {
    body = (
      <div role='status' aria-busy='true' className='grid gap-2'>
        <Skeleton className='h-8 w-full' />
        <Skeleton className='h-8 w-full' />
      </div>
    );
  } else if (!view.can) {
    body = (
      <Alert variant='destructive'>
        <AlertDescription>{t('employees.noView')}</AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <div className='grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,var(--container-xs))]'>
        <section className='min-w-0' aria-label={t('employees.list')}>
          <div className='mb-3 flex flex-wrap items-end gap-3'>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='employees-search'>{t('employees.search')}</Label>
              <Input
                id='employees-search'
                type='search'
                aria-label={t('employees.search')}
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder={t('employees.searchPlaceholder')}
              />
            </div>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value === 'all' ? 'all' : 'active')}
              className='flex gap-4'
            >
              <span className='flex items-center gap-2 text-sm'>
                <RadioGroupItem value='active' aria-label={t('employees.activeOnly')} />
                <Label>{t('employees.activeOnly')}</Label>
              </span>
              <span className='flex items-center gap-2 text-sm'>
                <RadioGroupItem value='all' aria-label={t('employees.includeLeft')} />
                <Label>{t('employees.includeLeft')}</Label>
              </span>
            </RadioGroup>
            {manage.can ? (
              <div className='ml-auto flex flex-wrap gap-2'>
                <Button size='sm' onClick={() => setDialog('hire')}>
                  {t('employees.hire')}
                </Button>
                <Button size='sm' variant='outline' onClick={() => setDialog('link')}>
                  {t('employees.link')}
                </Button>
              </div>
            ) : null}
          </div>
          {list.error ? (
            <Alert variant='destructive'>
              <AlertDescription>
                {t(employeeMessage(list.error).key, employeeMessage(list.error).values)}
                {rejectionReasons(list.error).map((reason) => (
                  <span key={reason} className='block'>{reason}</span>
                ))}
                <Button variant='outline' size='sm' onClick={list.reload}>
                  {t('employees.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {list.loading && list.data === undefined ? (
            <SkeletonList />
          ) : rows.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{t('employees.empty')}</p>
          ) : (
            <div data-testid='employee-list' role='table' aria-label={t('employees.list')}>
              <div role='row' className={cn(EMPLOYEE_ROW_CLASS, 'border-b-2 font-medium')}>
                {columns.map((column) => (
                  <span role='columnheader' key={column.id}>
                    {t(column.headerKey)}
                  </span>
                ))}
                <span role='columnheader' className='sr-only'>
                  {t('employees.actions')}
                </span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.userId}
                  role='row'
                  data-testid='employee-row'
                  className={EMPLOYEE_ROW_CLASS}
                >
                  {columns.map((column) => {
                    const value = column.value(row);
                    return (
                      <span role='cell' key={column.id} className='min-w-0 break-words'>
                        {value === 'employees.active'
                          ? t('employees.active')
                          : value === 'employees.left'
                            ? t('employees.left')
                            : (value ?? '—')}
                      </span>
                    );
                  })}
                  <span role='cell' className='flex flex-wrap justify-end gap-1'>
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={t('employees.detailsFor')}
                      onClick={() => {
                        setActive(row);
                        setDialog('detail');
                      }}
                    >
                      {t('employees.details')}
                    </Button>
                    {manage.can ? (
                      <>
                        <Button
                          variant='ghost'
                          size='sm'
                          aria-label={t('employees.transferFor')}
                          onClick={() => {
                            setActive(row);
                            setDialog('transfer');
                          }}
                        >
                          {t('employees.transfer')}
                        </Button>
                        {row.status === 'active' ? (
                          <Button
                            variant='ghost'
                            size='sm'
                            aria-label={t('employees.leaveFor')}
                            onClick={() => {
                              setActive(row);
                              setDialog('leave');
                            }}
                          >
                            {t('employees.leave')}
                          </Button>
                        ) : (
                          <Button
                            variant='ghost'
                            size='sm'
                            aria-label={t('employees.rehireFor')}
                            onClick={() => {
                              setActive(row);
                              setDialog('rehire');
                            }}
                          >
                            {t('employees.rehire')}
                          </Button>
                        )}
                      </>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        <div className='grid gap-4'>
          <DictionaryPanel client={client} kind='positions' canManage={manage.can} onChanged={list.reload} />
          <DictionaryPanel client={client} kind='grades' canManage={manage.can} onChanged={list.reload} />
        </div>
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('settings.employees')}
        description={t('settings.employeesDescription')}
      />
      {body}
      {dialog === 'detail' && active ? (
        <DetailDialog client={client} row={active} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'hire' ? (
        <HireDialog
          client={client}
          onClose={() => setDialog(null)}
          onDone={() => done(t('employees.hired'))}
        />
      ) : null}
      {dialog === 'link' ? (
        <LinkDialog
          client={client}
          onClose={() => setDialog(null)}
          onDone={() => done(t('employees.linked'))}
        />
      ) : null}
      {dialog === 'transfer' && active ? (
        <TransferDialog
          client={client}
          row={active}
          onClose={() => setDialog(null)}
          onDone={() => done(t('employees.transferred'))}
        />
      ) : null}
      {dialog === 'leave' && active ? (
        <LeaveDialog
          client={client}
          row={active}
          onClose={() => setDialog(null)}
          onDone={() => done(t('employees.leftToast'))}
        />
      ) : null}
      {dialog === 'rehire' && active ? (
        <RehireDialog
          client={client}
          row={active}
          onClose={() => setDialog(null)}
          onDone={() => done(t('employees.rehired'))}
        />
      ) : null}
    </PageContainer>
  );
}

/** 骨架与数据行同高：九列里只有数据位放骨架块，行标签是真实文本。 */
function SkeletonList(): ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid='employee-list' role='table' aria-busy='true' aria-label={t('employees.list')}>
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={width} data-testid='employee-skeleton-row' className={EMPLOYEE_ROW_CLASS}>
          <span className='sr-only'>
            {t('employees.loadingRow')} {index + 1}
          </span>
          {SKELETON_WIDTHS.map((cellWidth) => (
            <Skeleton
              key={cellWidth}
              aria-hidden='true'
              className={cn('h-3', cellWidth)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
