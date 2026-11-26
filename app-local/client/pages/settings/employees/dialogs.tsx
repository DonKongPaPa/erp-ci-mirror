import { useToaster } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useEffect, useId, useState, type ReactElement } from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Skeleton } from '#components/ui/skeleton';

import { useSettingsData } from '../hooks.js';
import {
  EmployeesClient,
  type EmployeeChange,
  type EmployeeDetail,
  type EmployeeRow,
} from './client.js';
import { employeeMessage, rejectionReasons } from './messages.js';
import { changeDisplayValue, employeeLabel } from './model.js';

type Option = { readonly value: string; readonly label: string };

/** 兼职部门按界面语言自带的写法连接（英文是逗号，中文是顿号），一个都没有时留一道横线。 */
function listNames(names: readonly string[], locale: string): string {
  // 没有 i18n 运行时时 `locale` 是空串，`Intl` 不收；交给它按默认语言排。
  return names.length ? new Intl.ListFormat(locale || undefined).format(names) : '—';
}

interface DepartmentNode {
  readonly id: string;
  readonly title: string;
  readonly code: string;
  readonly active: boolean;
  readonly children: readonly DepartmentNode[];
}

function flatten(nodes: readonly DepartmentNode[]): readonly DepartmentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** 失败提示：先给映射后的一句话，再按行给出离职前检查的理由。 */
export function ErrorNotice({ error }: { readonly error: unknown }): ReactElement | null {
  const { t } = useTranslation();
  if (error === undefined) return null;
  const message = employeeMessage(error);
  const text = t(message.key, message.values);
  const reasons = rejectionReasons(error);
  return (
    <Alert variant='destructive' role='alert'>
      <AlertDescription>
        <span className='block'>{text}</span>
        {reasons.map((reason) => (
          <span key={reason} className='block'>
            {reason}
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** 部门选择：只列部门树里的活动节点；没有数据时留空，不挡住不带部门的入职。 */
function DepartmentPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const tree = useSettingsData<{ data: readonly DepartmentNode[] }>('departments/tree');
  const options: readonly Option[] = [
    { value: 'none', label: t('employees.none') },
    ...flatten(tree.data?.data ?? [])
      .filter((node) => node.active !== false)
      .map((node) => ({ value: node.id, label: `${node.title} (${node.code})` })),
  ];
  return (
    <Select
      items={options}
      value={value || 'none'}
      onValueChange={(next) => onChange(next === 'none' ? '' : String(next))}
    >
      <SelectTrigger aria-label={t('employees.form.primaryDepartment')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || 'none'} value={option.value || 'none'}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function reference(value: string): string | null | undefined {
  return value === '' ? undefined : value;
}

export function HireDialog({
  client,
  onClose,
  onDone,
}: {
  readonly client: EmployeesClient;
  readonly onClose: () => void;
  readonly onDone: (detail: EmployeeDetail) => void;
}): ReactElement {
  const { t } = useTranslation();
  const nameId = useId();
  const usernameId = useId();
  const hiredId = useId();
  const passwordId = useId();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [hiredOn, setHiredOn] = useState('');
  const [password, setPassword] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const detail = await client.hire({
        name: name.trim(),
        hiredOn,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
        ...(reference(departmentId) !== undefined
          ? { primaryDepartmentId: departmentId }
          : {}),
      });
      onDone(detail);
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.hireTitle')}</DialogTitle>
          <DialogDescription>{t('employees.hireDescription')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <Field label={t('employees.form.name')} htmlFor={nameId}>
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('employees.form.username')} htmlFor={usernameId}>
            <Input id={usernameId} value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label={t('employees.form.hiredOn')} htmlFor={hiredId}>
            <Input id={hiredId} placeholder='YYYY-MM-DD' value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} />
          </Field>
          <Field label={t('employees.form.password')} htmlFor={passwordId}>
            <Input id={passwordId} type='password' value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={t('employees.form.primaryDepartment')} htmlFor='employees-hire-department'>
            <span id='employees-hire-department'>
              <DepartmentPicker value={departmentId} onChange={setDepartmentId} />
            </span>
          </Field>
          <ErrorNotice error={error} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={busy}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim() || !hiredOn}>
            {busy ? t('employees.saving') : t('employees.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkDialog({
  client,
  onClose,
  onDone,
}: {
  readonly client: EmployeesClient;
  readonly onClose: () => void;
  readonly onDone: (detail: EmployeeDetail) => void;
}): ReactElement {
  const { t } = useTranslation();
  const userIdId = useId();
  const hiredId = useId();
  const [userId, setUserId] = useState('');
  const [hiredOn, setHiredOn] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await client.link({ userId: userId.trim(), hiredOn }));
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.linkTitle')}</DialogTitle>
          <DialogDescription>{t('employees.linkDescription')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <Field label={t('employees.form.userId')} htmlFor={userIdId}>
            <Input id={userIdId} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <Field label={t('employees.form.hiredOn')} htmlFor={hiredId}>
            <Input id={hiredId} placeholder='YYYY-MM-DD' value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} />
          </Field>
          <ErrorNotice error={error} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={busy || !userId.trim() || !hiredOn}>
            {busy ? t('employees.saving') : t('employees.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 调岗：岗位用按钮列表选，选中项再点一次可清空；确保 PATCH 只带真正改了的字段。 */
export function TransferDialog({
  client,
  row,
  onClose,
  onDone,
}: {
  readonly client: EmployeesClient;
  readonly row: EmployeeRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const positions = useSettingsData<{ data: readonly { id: string; title: string; active: boolean }[] }>('positions');
  const [positionId, setPositionId] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const options = (positions.data?.data ?? []).filter((item) => item.active !== false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.update(row.userId, { positionId: positionId || null });
      onDone();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.transferTitle')}</DialogTitle>
          <DialogDescription>
            {t('employees.transferDescription', { name: employeeLabel(row) })}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <Label>{t('employees.columns.position')}</Label>
          <div role='group' aria-label={t('employees.columns.position')} className='flex flex-wrap gap-2'>
            {options.map((option) => (
              <Button
                key={option.id}
                variant={positionId === option.id ? 'default' : 'outline'}
                size='sm'
                onClick={() => setPositionId(positionId === option.id ? '' : option.id)}
              >
                {option.title}
              </Button>
            ))}
          </div>
          <ErrorNotice error={error} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={busy || !positionId}>
            {busy ? t('employees.saving') : t('employees.form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveDialog({
  client,
  row,
  onClose,
  onDone,
}: {
  readonly client: EmployeesClient;
  readonly row: EmployeeRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const dateId = useId();
  const noteId = useId();
  const [leftOn, setLeftOn] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.leave(row.userId, { leftOn, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.leaveTitle')}</DialogTitle>
          <DialogDescription>{t('employees.leaveDescription', { name: employeeLabel(row) })}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <Field label={t('employees.form.leftOn')} htmlFor={dateId}>
            <Input id={dateId} placeholder='YYYY-MM-DD' value={leftOn} onChange={(e) => setLeftOn(e.target.value)} />
          </Field>
          <Field label={t('employees.form.note')} htmlFor={noteId}>
            <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <ErrorNotice error={error} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button variant='destructive' onClick={() => void submit()} disabled={busy || !leftOn}>
            {busy ? t('employees.saving') : t('employees.form.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RehireDialog({
  client,
  row,
  onClose,
  onDone,
}: {
  readonly client: EmployeesClient;
  readonly row: EmployeeRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const dateId = useId();
  const [hiredOn, setHiredOn] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.rehire(row.userId, {
        hiredOn,
        ...(reference(departmentId) !== undefined
          ? { primaryDepartmentId: departmentId }
          : {}),
      });
      onDone();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.rehireTitle')}</DialogTitle>
          <DialogDescription>{t('employees.rehireDescription', { name: employeeLabel(row) })}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <Field label={t('employees.form.hiredOn')} htmlFor={dateId}>
            <Input id={dateId} placeholder='YYYY-MM-DD' value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} />
          </Field>
          <Field label={t('employees.form.primaryDepartment')} htmlFor='employees-rehire-department'>
            <span id='employees-rehire-department'>
              <DepartmentPicker value={departmentId} onChange={setDepartmentId} />
            </span>
          </Field>
          <ErrorNotice error={error} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={busy || !hiredOn}>
            {busy ? t('employees.saving') : t('employees.form.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 详情：档案、兼职部门、上级与变动记录，全部来自详情/变动记录端点。 */
export function DetailDialog({
  client,
  row,
  onClose,
}: {
  readonly client: EmployeesClient;
  readonly row: EmployeeRow;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [detail, setDetail] = useState<EmployeeDetail | undefined>();
  const [changes, setChanges] = useState<readonly EmployeeChange[]>([]);
  const [positionTitles, setPositionTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let live = true;
    void Promise.all([
      client.detail(row.userId),
      client.changes(row.userId),
      // 岗位字典查不到时变动记录退回原代码，详情本身不受影响。
      client.positions().catch(() => []),
    ]).then(
      ([nextDetail, nextChanges, nextPositions]) => {
        if (!live) return;
        setDetail(nextDetail);
        setChanges(nextChanges);
        setPositionTitles(new Map(nextPositions.map((position) => [position.id, position.title])));
      },
      (next: unknown) => {
        if (live) setError(next);
      },
    );
    return () => {
      live = false;
    };
  }, [client, row.userId]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('employees.detailTitle')}</DialogTitle>
          <DialogDescription>{employeeLabel(row)}</DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorNotice error={error} />
        ) : detail === undefined ? (
          <div role='status' aria-busy='true'>
            <Skeleton className='h-4 w-full' />
          </div>
        ) : (
          <div className='grid gap-4'>
            <dl className='grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2'>
              <Detail label={t('employees.columns.employeeNo')} value={detail.employeeNo} />
              <Detail label={t('employees.columns.name')} value={detail.name ?? '—'} />
              <Detail label={t('employees.columns.username')} value={detail.username ?? '—'} />
              <Detail label={t('employees.columns.primaryDepartment')} value={detail.primaryDepartmentName ?? '—'} />
              <Detail label={t('employees.secondaryDepartments')} value={listNames(detail.secondaryDepartmentNames, locale)} />
              <Detail label={t('employees.reportsTo')} value={detail.reportsToName ?? '—'} />
              <Detail label={t('employees.columns.position')} value={detail.positionName ?? '—'} />
              <Detail label={t('employees.columns.grade')} value={detail.gradeName ?? '—'} />
              <Detail label={t('employees.columns.status')} value={t(detail.status === 'active' ? 'employees.active' : 'employees.left')} />
              <Detail label={t('employees.columns.hiredOn')} value={detail.hiredOn} />
              <Detail label={t('employees.leftOn')} value={detail.leftOn ?? '—'} />
            </dl>
            <section aria-label={t('employees.changes')} className='grid gap-2'>
              <Label>{t('employees.changes')}</Label>
              <ul className='grid gap-1 text-sm'>
                {changes.map((change) => {
                  const value = changeDisplayValue(change, positionTitles);
                  return (
                    <li key={`${change.kind}:${change.createdAt}:${change.toValue ?? ''}`} className='flex flex-wrap gap-2 border-b py-1'>
                      <span>{t(`employees.change.${change.kind}`, { defaultValue: change.kind })}</span>
                      <span>{value.from ?? '—'}</span>
                      <span>→</span>
                      <span>{value.to ?? '—'}</span>
                      <span className='text-muted-foreground'>{change.occurredOn}</span>
                      <span className='text-muted-foreground'>{change.actorName ?? ''}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className='break-words'>{value}</dd>
    </div>
  );
}

/** 字典小管理：停用是把 active 置 false，记录仍在列表里；改名与新建都走 PATCH / POST。 */
export function DictionaryPanel({
  client,
  kind,
  canManage,
  onChanged,
}: {
  readonly client: EmployeesClient;
  readonly kind: 'positions' | 'grades';
  readonly canManage: boolean;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const path = kind === 'positions' ? 'positions' : 'job-grades';
  const list = useSettingsData<{
    data: readonly { id: string; title: string; active: boolean }[];
  }>(path);
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const rows = list.data?.data ?? [];
  const title = kind === 'positions' ? t('employees.positions') : t('employees.grades');

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      toaster.show({ type: 'success', title: success });
      list.reload();
      onChanged();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={title} className='rounded-lg border p-4'>
      <h3 className='text-sm font-medium'>{title}</h3>
      <ul className='mt-2 grid gap-1'>
        {rows.map((row) => (
          <li key={row.id} className='flex items-center justify-between gap-2 border-b py-1 text-sm'>
            <span className='min-w-0 break-words'>
              {row.title}
              {row.active ? null : (
                <span className='ml-2 text-muted-foreground'>{t('employees.inactive')}</span>
              )}
            </span>
            {canManage ? (
              <Button
                variant='outline'
                size='sm'
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      kind === 'positions'
                        ? client.updatePosition(row.id, { active: !row.active })
                        : client.updateGrade(row.id, { active: !row.active }),
                    row.active ? t('employees.deactivated') : t('employees.activated'),
                  )
                }
              >
                {row.active ? t('employees.deactivate') : t('employees.activate')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className='mt-3 flex flex-wrap items-end gap-2'>
          <Input
            aria-label={t('employees.form.code')}
            placeholder={t('employees.form.code')}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            className='w-32'
          />
          <Input
            aria-label={t('employees.form.title')}
            placeholder={t('employees.form.title')}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Button
            size='sm'
            disabled={busy || !newId.trim() || !newTitle.trim()}
            onClick={() =>
              void run(
                () =>
                  kind === 'positions'
                    ? client.createPosition({ id: newId.trim(), title: newTitle.trim() })
                    : client.createGrade({ id: newId.trim(), title: newTitle.trim() }),
                t('employees.created'),
              ).then(() => {
                setNewId('');
                setNewTitle('');
              })
            }
          >
            {t('employees.create')}
          </Button>
        </div>
      ) : null}
      <ErrorNotice error={error} />
    </section>
  );
}
