import { ApiClientError, useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { GitMerge, PlusIcon, Power, Undo2, Users } from 'lucide-react';
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { DataTable } from '#components/data-table';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { RowActions } from '#components/row-actions';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';
import { cn } from 'cn';

import { useSettingsData } from '../hooks.js';
import {
  DepartmentsClient,
  type DepartmentNode,
  type DepartmentRecord,
  type CandidateRow,
  type MemberRow,
} from './client.js';
import {
  AddMembersDialog,
  CreateDepartmentDialog,
  DeactivateDepartmentDialog,
  MergeDepartmentDialog,
} from './dialogs.js';
import { ruleMessageKey } from './messages.js';
import { flattenTree, personLabel, subtreeIds } from './model.js';
import { DepartmentTree } from './tree.js';

const DEPARTMENT_RESOURCE = { type: 'composite', id: 'departments' } as const;

const KIND_KEYS = ['company', 'center', 'department', 'team'] as const;

interface MemberPage {
  readonly data: readonly MemberRow[];
  readonly meta?: { readonly total: number; readonly page: number };
}

function errorStatus(error: unknown): number | undefined {
  return error instanceof ApiClientError ? error.status : undefined;
}

/** 读取失败时的提示，带一个重试按钮：下一步是再试一次，不是揣测原因。 */
function LoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Alert variant='destructive'>
      <AlertDescription>
        {t(ruleMessageKey(error))}
        <Button variant='outline' size='sm' onClick={onRetry}>
          {t('departments.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** R-012 部门维护页：左边整棵树，右边选中部门的详情与成员。 */
export default function DepartmentsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new DepartmentsClient(api), [api]);
  const view = useCan({ resource: DEPARTMENT_RESOURCE, action: 'view' });
  const manage = useCan({
    resource: DEPARTMENT_RESOURCE,
    action: 'manage',
  });
  const canManage = manage.can;
  const tree = useSettingsData<{ data: readonly DepartmentNode[] }>(
    'departments/tree',
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<
    'create' | 'deactivate' | 'merge' | 'add' | null
  >(null);

  const nodes = useMemo(() => tree.data?.data ?? [], [tree.data]);
  const flat = useMemo(() => flattenTree(nodes), [nodes]);
  // 选中项不存在时回落到第一个根部门：写操作之后树会重读，不必把选中写成状态。
  const selected =
    flat.find(({ node }) => node.id === selectedId)?.node ?? flat[0]?.node;
  const reload = tree.reload;

  let body: ReactElement;
  if (view.isPending) {
    body = <PagePlaceholder />;
  } else if (!view.can) {
    body = (
      <Alert variant='destructive'>
        <AlertTitle>{t('departments.noViewTitle')}</AlertTitle>
        <AlertDescription>
          {t('departments.noViewDescription')}
        </AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <div className='grid items-start gap-4 lg:grid-cols-[minmax(0,var(--container-xs))_minmax(0,1fr)]'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between gap-2'>
            <CardTitle>{t('departments.tree')}</CardTitle>
            {canManage ? (
              <Button size='sm' onClick={() => setOpen('create')}>
                <PlusIcon aria-hidden='true' />
                {t('departments.new')}
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className='min-h-64'>
            {tree.loading && tree.data === undefined ? (
              <TreePlaceholder />
            ) : tree.error && tree.data === undefined ? (
              <LoadError error={tree.error} onRetry={reload} />
            ) : flat.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                {t('departments.empty')}
              </p>
            ) : (
              <DepartmentTree
                nodes={nodes}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
              />
            )}
          </CardContent>
        </Card>
        <div className='flex min-w-0 flex-col gap-4'>
          {selected ? (
            <DepartmentDetails
              key={`${selected.id}:${selected.updatedAt}`}
              client={client}
              department={selected}
              nodes={nodes}
              canManage={canManage}
              onChanged={reload}
              onDeactivate={() => setOpen('deactivate')}
              onMerge={() => setOpen('merge')}
              onActivate={async () => {
                try {
                  await client.activate(selected.id);
                  toaster.show({
                    type: 'success',
                    title: t('departments.activatedToast'),
                  });
                  reload();
                } catch (error) {
                  toaster.show({
                    type: 'error',
                    title: t(ruleMessageKey(error)),
                  });
                }
              }}
            />
          ) : tree.loading && tree.data === undefined ? (
            <DetailsPlaceholder />
          ) : (
            <Card>
              <CardContent className='text-sm text-muted-foreground'>
                {t('departments.selectPrompt')}
              </CardContent>
            </Card>
          )}
          {selected ? (
            <MembersPanel
              key={selected.id}
              client={client}
              department={selected}
              nodes={nodes}
              canManage={canManage}
              onChanged={reload}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('settings.departments')}
        description={t('settings.departmentsDescription')}
      />
      {body}
      {open === 'create' ? (
        <CreateDepartmentDialog
          client={client}
          nodes={nodes}
          defaultParentId={selected?.active ? selected.id : null}
          onClose={() => setOpen(null)}
          onCreated={(department) => {
            setOpen(null);
            setSelectedId(department.id);
            toaster.show({
              type: 'success',
              title: t('departments.created', { title: department.title }),
            });
            reload();
          }}
        />
      ) : null}
      {open === 'deactivate' && selected ? (
        <DeactivateDepartmentDialog
          client={client}
          department={selected}
          nodes={nodes}
          onClose={() => setOpen(null)}
          onDeactivated={() => {
            setOpen(null);
            toaster.show({
              type: 'success',
              title: t('departments.deactivatedToast'),
            });
            reload();
          }}
        />
      ) : null}
      {open === 'merge' && selected ? (
        <MergeDepartmentDialog
          client={client}
          department={selected}
          nodes={nodes}
          onClose={() => setOpen(null)}
          onMerged={() => {
            setOpen(null);
            setSelectedId(null);
            toaster.show({
              type: 'success',
              title: t('departments.mergedToast'),
            });
            reload();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

/** 详情的编辑与只读两态：没有 manage 的人看不到任何写按钮。 */
function DepartmentDetails({
  client,
  department,
  nodes,
  canManage,
  onChanged,
  onDeactivate,
  onMerge,
  onActivate,
}: {
  readonly client: DepartmentsClient;
  readonly department: DepartmentRecord;
  readonly nodes: readonly DepartmentNode[];
  readonly canManage: boolean;
  readonly onChanged: () => void;
  readonly onDeactivate: () => void;
  readonly onMerge: () => void;
  readonly onActivate: () => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const titleId = useId();
  const codeId = useId();
  const sortId = useId();
  const managerInputId = useId();
  // 负责人是成员，目录（最多 100 行）给出姓名；换人时用搜人端点找非成员，
  // 服务端会以 422 拒绝并提示先把他加成成员。
  const directory = useSettingsData<{ data: readonly MemberRow[] }>(
    `departments/${encodeURIComponent(department.id)}/members?page=1&pageSize=100`,
  );
  const [title, setTitle] = useState(department.title);
  const [code, setCode] = useState(department.code);
  const [kind, setKind] = useState(department.kind);
  const [parentId, setParentId] = useState(department.parentId ?? 'none');
  const [sortOrder, setSortOrder] = useState(String(department.sortOrder));
  const [managerId, setManagerId] = useState<string | null>(
    department.managerId,
  );
  const [managerQuery, setManagerQuery] = useState('');
  const [managerResults, setManagerResults] = useState<readonly CandidateRow[]>(
    [],
  );
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const parentOptions = [
    { value: 'none', label: t('departments.noParent') },
    ...flattenTree(nodes)
      .filter(
        ({ node }) =>
          node.active && !subtreeIds(nodes, department.id).has(node.id),
      )
      .map(({ node, depth }) => ({
        value: node.id,
        label: `${'　'.repeat(depth)}${node.title} (${node.code})`,
      })),
  ];
  const managerName =
    (directory.data?.data ?? []).find((row) => row.userId === managerId)
      ?.name ??
    managerResults.find((row) => row.userId === managerId)?.name ??
    null;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.update(department.id, {
        title: title.trim(),
        code: code.trim(),
        kind,
        parentId: parentId === 'none' ? null : parentId,
        sortOrder: Number(sortOrder) || 0,
        managerId,
      });
      toaster.show({ type: 'success', title: t('departments.saved') });
      onChanged();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  const searchManager = async () => {
    const q = managerQuery.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(undefined);
    try {
      const page = await client.candidates({ q, pageSize: 20 });
      setManagerResults(page.items);
    } catch (next) {
      setError(next);
      setManagerResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card role='region' aria-label={t('departments.details')}>
      <CardHeader className='flex flex-row items-center justify-between gap-2'>
        <CardTitle className='min-w-0 break-words'>
          {department.title}
          {department.active ? null : (
            <StatusBadge size='sm' tone='neutral' className='ml-2'>
              {t('departments.inactive')}
            </StatusBadge>
          )}
        </CardTitle>
        {canManage ? (
          <div className='flex flex-wrap items-center gap-2'>
            {department.active ? (
              <>
                <Button variant='outline' size='sm' onClick={onDeactivate}>
                  <Power aria-hidden='true' />
                  {t('departments.deactivate')}
                </Button>
                <Button variant='outline' size='sm' onClick={onMerge}>
                  <GitMerge aria-hidden='true' />
                  {t('departments.merge')}
                </Button>
              </>
            ) : (
              <Button
                variant='outline'
                size='sm'
                onClick={() => void onActivate()}
              >
                <Undo2 aria-hidden='true' />
                {t('departments.activate')}
              </Button>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {canManage ? (
          <>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor={titleId}>{t('departments.name')}</Label>
                <Input
                  id={titleId}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor={codeId}>{t('departments.code')}</Label>
                <Input
                  id={codeId}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label>{t('departments.type')}</Label>
                <Select
                  items={KIND_KEYS.map((value) => ({
                    value,
                    label: t(`departments.kind.${value}`),
                  }))}
                  value={kind}
                  onValueChange={(value) => setKind(String(value))}
                >
                  <SelectTrigger aria-label={t('departments.type')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_KEYS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`departments.kind.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label>{t('departments.parent')}</Label>
                <Select
                  items={parentOptions}
                  value={parentId}
                  onValueChange={(value) => setParentId(String(value))}
                >
                  <SelectTrigger aria-label={t('departments.parent')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {parentOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor={sortId}>{t('departments.sortOrder')}</Label>
                <Input
                  id={sortId}
                  type='number'
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)}
                />
              </div>
              <div className='flex flex-col gap-1.5 sm:col-span-2'>
                <Label htmlFor={managerInputId}>
                  {t('departments.manager')}
                </Label>
                <div className='flex items-center gap-2'>
                  <ManagerSummary name={managerName} id={managerId} />
                  {managerId ? (
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setManagerId(null)}
                    >
                      {t('departments.clearManager')}
                    </Button>
                  ) : null}
                </div>
                <div className='flex items-center gap-2'>
                  <Input
                    id={managerInputId}
                    value={managerQuery}
                    placeholder={t('departments.searchPlaceholder')}
                    onChange={(event) => setManagerQuery(event.target.value)}
                  />
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={searching || !managerQuery.trim()}
                    onClick={() => void searchManager()}
                  >
                    {t('departments.search')}
                  </Button>
                </div>
                {managerResults.length > 0 ? (
                  <ul className='flex max-h-40 flex-col overflow-y-auto rounded-md border'>
                    {managerResults.map((row) => (
                      <li key={row.userId}>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='w-full justify-start font-normal'
                          onClick={() => {
                            setManagerId(row.userId);
                            setManagerResults([]);
                            setManagerQuery('');
                          }}
                        >
                          {personLabel(row)}
                          {row.username ? ` · ${row.username}` : ''}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            {error ? (
              <Alert variant='destructive'>
                <AlertDescription>{t(ruleMessageKey(error))}</AlertDescription>
              </Alert>
            ) : null}
            <div className='flex justify-end'>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? t('departments.saving') : t('departments.save')}
              </Button>
            </div>
          </>
        ) : (
          <dl className='grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2'>
            <Detail label={t('departments.name')} value={department.title} />
            <Detail label={t('departments.code')} value={department.code} />
            <Detail
              label={t('departments.type')}
              value={t(`departments.kind.${department.kind}`, {
                defaultValue: department.kind,
              })}
            />
            <Detail
              label={t('departments.parent')}
              value={
                flattenTree(nodes).find(
                  ({ node }) => node.id === department.parentId,
                )?.node.title ?? t('departments.noParent')
              }
            />
            <Detail
              label={t('departments.sortOrder')}
              value={String(department.sortOrder)}
            />
            <Detail
              label={t('departments.manager')}
              value={
                (directory.data?.data ?? []).find(
                  (row) => row.userId === department.managerId,
                )?.name ??
                department.managerId ??
                t('departments.noManager')
              }
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ManagerSummary({
  name,
  id,
}: {
  readonly name: string | null;
  readonly id: string | null;
}): ReactElement {
  const { t } = useTranslation();
  if (!id) {
    return (
      <span className='text-sm text-muted-foreground'>
        {t('departments.noManager')}
      </span>
    );
  }
  return <span className='text-sm font-medium'>{name ?? id}</span>;
}

function Detail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className='break-words'>{value}</dd>
    </div>
  );
}

/** 成员区：分页列出、加成员、移出、设主部门、设负责人、批量调动。 */
function MembersPanel({
  client,
  department,
  nodes,
  canManage,
  onChanged,
}: {
  readonly client: DepartmentsClient;
  readonly department: DepartmentRecord;
  readonly nodes: readonly DepartmentNode[];
  readonly canManage: boolean;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [addOpen, setAddOpen] = useState(false);
  const request = useSettingsData<MemberPage>(
    `departments/${encodeURIComponent(department.id)}/members?page=${page}&pageSize=${pageSize}`,
    { keepPreviousData: true },
  );
  const [actionError, setActionError] = useState<unknown>();
  const [actionBusy, setActionBusy] = useState(false);
  const [targetId, setTargetId] = useState('none');
  const [transferring, setTransferring] = useState(false);

  const run = useCallback(
    async (work: () => Promise<unknown>, success: string) => {
      setActionBusy(true);
      setActionError(undefined);
      try {
        await work();
        toaster.show({ type: 'success', title: success });
        request.reload();
        onChanged();
      } catch (next) {
        setActionError(next);
      } finally {
        setActionBusy(false);
      }
    },
    [onChanged, request, toaster],
  );

  const rows = request.data?.data ?? [];
  const columns = useMemo<ColumnDef<MemberRow>[]>(() => {
    const name = (row: MemberRow) => personLabel(row);
    const select: ColumnDef<MemberRow>[] = canManage
      ? [
          {
            id: 'select',
            header: ({ table }) => (
              <Checkbox
                aria-label={t('departments.selectAll')}
                checked={table.getIsAllPageRowsSelected()}
                onCheckedChange={(checked) =>
                  table.toggleAllPageRowsSelected(checked === true)
                }
              />
            ),
            cell: ({ row }) => (
              <Checkbox
                aria-label={t('departments.selectPerson', {
                  name: name(row.original),
                })}
                checked={row.getIsSelected()}
                onCheckedChange={(checked) =>
                  row.toggleSelected(checked === true)
                }
              />
            ),
          },
        ]
      : [];
    const menu: ColumnDef<MemberRow> | null = canManage
      ? {
          id: 'actions',
          header: () => (
            <span className='sr-only'>{t('departments.actions')}</span>
          ),
          cell: ({ row }) => (
            <RowActions
              label={t('departments.actionsFor', {
                name: name(row.original),
              })}
              actions={[
                {
                  key: 'primary',
                  label: t('departments.makePrimary'),
                  disabled: actionBusy,
                  onClick: () =>
                    void run(
                      () =>
                        client.setPrimary(department.id, row.original.userId),
                      t('departments.primarySaved', {
                        name: name(row.original),
                      }),
                    ),
                },
                {
                  key: 'manager',
                  label: t('departments.makeManager'),
                  disabled: actionBusy,
                  onClick: () =>
                    void run(
                      () =>
                        client.update(department.id, {
                          managerId: row.original.userId,
                        }),
                      t('departments.managerSaved', {
                        name: name(row.original),
                      }),
                    ),
                },
                {
                  key: 'remove',
                  label: t('departments.removeMember'),
                  destructive: true,
                  disabled: actionBusy,
                  onClick: () =>
                    void run(
                      () =>
                        client.removeMember(department.id, row.original.userId),
                      t('departments.removedToast', {
                        name: name(row.original),
                      }),
                    ),
                },
              ]}
            />
          ),
        }
      : null;
    return [
      ...select,
      {
        id: 'name',
        header: t('departments.memberName'),
        cell: ({ row }) => (
          <span className='font-medium'>{name(row.original)}</span>
        ),
      },
      {
        id: 'username',
        header: t('departments.username'),
        cell: ({ row }) => row.original.username ?? '—',
      },
      {
        id: 'primary',
        header: t('departments.primaryColumn'),
        cell: ({ row }) =>
          row.original.isPrimary ? (
            <StatusBadge size='sm' tone='info'>
              {t('departments.isPrimary')}
            </StatusBadge>
          ) : null,
      },
      {
        id: 'manager',
        header: t('departments.managerColumn'),
        cell: ({ row }) =>
          row.original.userId === department.managerId ? (
            <StatusBadge size='sm' tone='info'>
              {t('departments.isManager')}
            </StatusBadge>
          ) : null,
      },
      ...(menu ? [menu] : []),
    ];
  }, [
    actionBusy,
    canManage,
    client,
    department.id,
    department.managerId,
    run,
    t,
  ]);

  const targetOptions = [
    { value: 'none', label: t('departments.chooseTarget') },
    ...flattenTree(nodes)
      .filter(({ node }) => node.active && node.id !== department.id)
      .map(({ node, depth }) => ({
        value: node.id,
        label: `${'　'.repeat(depth)}${node.title} (${node.code})`,
      })),
  ];

  return (
    <Card role='region' aria-label={t('departments.members')}>
      <CardHeader className='flex flex-row items-center justify-between gap-2'>
        <CardTitle className='flex items-center gap-2'>
          <Users aria-hidden='true' className='size-4' />
          {t('departments.members')}
        </CardTitle>
        {canManage ? (
          <Button size='sm' onClick={() => setAddOpen(true)}>
            <PlusIcon aria-hidden='true' />
            {t('departments.addMembers')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {actionError ? (
          <Alert variant='destructive'>
            <AlertDescription>
              {t(ruleMessageKey(actionError))}
            </AlertDescription>
          </Alert>
        ) : null}
        <DataTable<MemberRow>
          columns={columns}
          data={rows}
          getRowId={(row) => row.userId}
          manualPagination
          rowCount={request.data?.meta?.total ?? 0}
          paginationState={{ pageIndex: page - 1, pageSize }}
          onPaginationChange={(updater) => {
            const next =
              typeof updater === 'function'
                ? updater({ pageIndex: page - 1, pageSize })
                : updater;
            setPage(next.pageIndex + 1);
            setPageSize(next.pageSize);
          }}
          loading={request.loading}
          loadingIdentity={`${department.id}:${page}:${pageSize}`}
          listState={
            request.error
              ? errorStatus(request.error) === 403
                ? 'forbidden'
                : 'failed'
              : undefined
          }
          onRetry={request.reload}
          emptyMessage={t('departments.noMembers')}
          toolbar={(table) => {
            if (!canManage) return null;
            const ids = table
              .getSelectedRowModel()
              .rows.map((row) => row.original.userId);
            if (ids.length === 0) return null;
            return (
              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-sm text-muted-foreground'>
                  {t('departments.selectedCount', { count: ids.length })}
                </span>
                <Select
                  items={targetOptions}
                  value={targetId}
                  onValueChange={(value) => setTargetId(String(value))}
                >
                  <SelectTrigger
                    size='sm'
                    aria-label={t('departments.transferTarget')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size='sm'
                  disabled={transferring || targetId === 'none'}
                  onClick={() => {
                    if (targetId === 'none') return;
                    setTransferring(true);
                    setActionError(undefined);
                    client
                      .transfer({
                        userIds: ids,
                        fromDepartmentId: department.id,
                        toDepartmentId: targetId,
                      })
                      .then(
                        (result) => {
                          table.resetRowSelection();
                          setTargetId('none');
                          toaster.show({
                            type: 'success',
                            title: t('departments.transferredToast', {
                              moved: result.moved,
                            }),
                          });
                          request.reload();
                          onChanged();
                        },
                        (next: unknown) => setActionError(next),
                      )
                      .finally(() => setTransferring(false));
                  }}
                >
                  {transferring
                    ? t('departments.transferring')
                    : t('departments.transfer')}
                </Button>
              </div>
            );
          }}
        />
      </CardContent>
      {addOpen ? (
        <AddMembersDialog
          client={client}
          department={department}
          onClose={() => setAddOpen(false)}
          onAdded={(count) => {
            setAddOpen(false);
            toaster.show({
              type: 'success',
              title: t('departments.addedToast', { count }),
            });
            request.reload();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * 树的骨架六行的宽度。每一行就是按它当 key 的，所以必须互不相同 ——
 * 2026-11-25 有两行同宽，React 在控制台报「两个子节点同一个 key」。
 */
const TREE_PLACEHOLDER_WIDTHS = [
  'w-3/4',
  'w-2/3',
  'w-4/5',
  'w-1/2',
  'w-3/5',
  'w-1/6',
] as const;

/** 树的占位与内容同高：六行，加载完成时列表不把下面的内容顶走。 */
function TreePlaceholder(): ReactElement {
  const { t } = useTranslation();
  return (
    <div role='status' aria-busy='true' className='flex flex-col gap-2'>
      <span className='sr-only'>{t('departments.loading')}</span>
      {TREE_PLACEHOLDER_WIDTHS.map((width) => (
        <Skeleton key={width} aria-hidden='true' className={cn('h-7', width)} />
      ))}
    </div>
  );
}

function DetailsPlaceholder(): ReactElement {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent
        role='status'
        aria-busy='true'
        className='flex min-h-64 flex-col gap-3'
      >
        <span className='sr-only'>{t('departments.loading')}</span>
        <Skeleton aria-hidden='true' className='h-6 w-1/3' />
        <Skeleton aria-hidden='true' className='h-8 w-full' />
        <Skeleton aria-hidden='true' className='h-8 w-full' />
        <Skeleton aria-hidden='true' className='h-8 w-2/3' />
      </CardContent>
    </Card>
  );
}

function PagePlaceholder(): ReactElement {
  return (
    <div
      role='status'
      aria-busy='true'
      className='grid gap-4 lg:grid-cols-[minmax(0,var(--container-xs))_minmax(0,1fr)]'
    >
      <Card>
        <CardContent className='flex min-h-64 flex-col gap-2'>
          {['w-3/4', 'w-2/3', 'w-4/5', 'w-1/2'].map((width) => (
            <Skeleton
              key={width}
              aria-hidden='true'
              className={cn('h-7', width)}
            />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className='flex min-h-64 flex-col gap-3'>
          <Skeleton aria-hidden='true' className='h-6 w-1/3' />
          <Skeleton aria-hidden='true' className='h-8 w-full' />
          <Skeleton aria-hidden='true' className='h-8 w-full' />
        </CardContent>
      </Card>
    </div>
  );
}
