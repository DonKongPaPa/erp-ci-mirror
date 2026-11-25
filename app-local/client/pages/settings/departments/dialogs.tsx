import { useTranslation } from '@nocobase/i18n/client';
import { useId, useState, type ReactElement } from 'react';
import { Search } from 'lucide-react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import type {
  CandidateRow,
  DepartmentNode,
  DepartmentRecord,
} from './client.js';
import type { DepartmentsClient } from './client.js';
import { ruleMessageKey } from './messages.js';
import { flattenTree, personLabel, subtreeIds } from './model.js';

/** 四十种选择项的公共形状。 */
type Option = { readonly value: string; readonly label: string };

const KIND_KEYS = ['company', 'center', 'department', 'team'] as const;

function kindOptions(t: (key: string) => string): Option[] {
  return KIND_KEYS.map((kind) => ({
    value: kind,
    label: t(`departments.kind.${kind}`),
  }));
}

/** 上级、继任者与合并目标共用：只列未停用的部门，跳过给定的子树。 */
function activeDepartments(
  nodes: readonly DepartmentNode[],
  skip: ReadonlySet<string>,
): Option[] {
  return flattenTree(nodes)
    .filter(({ node }) => node.active && !skip.has(node.id))
    .map(({ node, depth }) => ({
      value: node.id,
      label: `${'　'.repeat(depth)}${node.title} (${node.code})`,
    }));
}

/** 一个复选框一行，点击整行切换。 */
function CheckRow({
  checked,
  label,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <Label className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-normal hover:bg-muted'>
      <Checkbox
        aria-label={label}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className='min-w-0 break-words'>{label}</span>
    </Label>
  );
}

export function CreateDepartmentDialog({
  client,
  nodes,
  defaultParentId,
  onClose,
  onCreated,
}: {
  readonly client: DepartmentsClient;
  readonly nodes: readonly DepartmentNode[];
  readonly defaultParentId: string | null;
  readonly onClose: () => void;
  readonly onCreated: (department: DepartmentRecord) => void;
}): ReactElement {
  const { t } = useTranslation();
  const titleId = useId();
  const codeId = useId();
  const sortId = useId();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<string>('department');
  const [parentId, setParentId] = useState<string>(defaultParentId ?? 'none');
  const [sortOrder, setSortOrder] = useState('0');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const parents: Option[] = [
    { value: 'none', label: t('departments.noParent') },
    ...activeDepartments(nodes, new Set()),
  ];

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const department = await client.create({
        title: title.trim(),
        code: code.trim(),
        kind,
        parentId: parentId === 'none' ? null : parentId,
        sortOrder: Number(sortOrder) || 0,
      });
      onCreated(department);
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('departments.createTitle')}</DialogTitle>
          <DialogDescription>
            {t('departments.createDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4'>
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
              items={kindOptions(t)}
              value={kind}
              onValueChange={(value) => setKind(String(value))}
            >
              <SelectTrigger aria-label={t('departments.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kindOptions(t).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label>{t('departments.parent')}</Label>
            <Select
              items={parents}
              value={parentId}
              onValueChange={(value) => setParentId(String(value))}
            >
              <SelectTrigger aria-label={t('departments.parent')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {parents.map((option) => (
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
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{t(ruleMessageKey(error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('departments.cancel')}
          </Button>
          <Button
            disabled={busy || !title.trim() || !code.trim()}
            onClick={() => void submit()}
          >
            {busy ? t('departments.creating') : t('departments.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeactivateDepartmentDialog({
  client,
  department,
  nodes,
  onClose,
  onDeactivated,
}: {
  readonly client: DepartmentsClient;
  readonly department: DepartmentRecord;
  readonly nodes: readonly DepartmentNode[];
  readonly onClose: () => void;
  readonly onDeactivated: (department: DepartmentRecord) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [successorId, setSuccessorId] = useState('none');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const options: Option[] = [
    { value: 'none', label: t('departments.noSuccessor') },
    ...activeDepartments(nodes, subtreeIds(nodes, department.id)),
  ];

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDeactivated(
        await client.deactivate(
          department.id,
          successorId === 'none' ? null : successorId,
        ),
      );
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('departments.deactivateTitle')}</DialogTitle>
          <DialogDescription>
            {t('departments.deactivateDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-1.5'>
            <Label>{t('departments.successor')}</Label>
            <Select
              items={options}
              value={successorId}
              onValueChange={(value) => setSuccessorId(String(value))}
            >
              <SelectTrigger aria-label={t('departments.successor')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{t(ruleMessageKey(error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('departments.cancel')}
          </Button>
          <Button
            variant='destructive'
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? t('departments.deactivating') : t('departments.deactivate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MergeDepartmentDialog({
  client,
  department,
  nodes,
  onClose,
  onMerged,
}: {
  readonly client: DepartmentsClient;
  readonly department: DepartmentRecord;
  readonly nodes: readonly DepartmentNode[];
  readonly onClose: () => void;
  readonly onMerged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState('none');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const options: Option[] = activeDepartments(
    nodes,
    subtreeIds(nodes, department.id),
  );

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.merge(department.id, targetId);
      onMerged();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('departments.mergeTitle')}</DialogTitle>
          <DialogDescription>
            {t('departments.mergeDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-1.5'>
            <Label>{t('departments.mergeTarget')}</Label>
            <Select
              items={options}
              value={targetId}
              onValueChange={(value) => setTargetId(String(value))}
            >
              <SelectTrigger aria-label={t('departments.mergeTarget')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{t(ruleMessageKey(error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('departments.cancel')}
          </Button>
          <Button
            variant='destructive'
            disabled={busy || targetId === 'none'}
            onClick={() => void submit()}
          >
            {busy ? t('departments.merging') : t('departments.merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddMembersDialog({
  client,
  department,
  onClose,
  onAdded,
}: {
  readonly client: DepartmentsClient;
  readonly department: DepartmentRecord;
  readonly onClose: () => void;
  readonly onAdded: (count: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly CandidateRow[]>();
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<ReadonlyMap<string, CandidateRow>>(
    () => new Map(),
  );
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(undefined);
    setSearched(true);
    try {
      const page = await client.candidates({
        q,
        excludeDepartmentId: department.id,
        pageSize: 50,
      });
      setResults(page.items);
    } catch (next) {
      setError(next);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toggle = (row: CandidateRow, checked: boolean) => {
    setSelected((old) => {
      const next = new Map(old);
      if (checked) {
        next.set(row.userId, row);
      } else {
        next.delete(row.userId);
      }
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.addMembers(department.id, [
        ...selected.keys(),
      ]);
      onAdded(result.added.length);
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('departments.addMembersTitle')}</DialogTitle>
          <DialogDescription>
            {t('departments.addMembersDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4'>
          <form
            className='flex items-center gap-2'
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Input
              value={query}
              aria-label={t('departments.search')}
              placeholder={t('departments.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type='submit'
              variant='outline'
              disabled={searching || !query.trim()}
            >
              <Search aria-hidden='true' />
              {t('departments.search')}
            </Button>
          </form>
          <div
            role='group'
            aria-label={t('departments.searchResults')}
            aria-busy={searching}
            className='max-h-64 overflow-y-auto rounded-md border'
          >
            {!searched ? (
              <p className='p-3 text-sm text-muted-foreground'>
                {t('departments.searchHint')}
              </p>
            ) : searching ? (
              <p className='p-3 text-sm text-muted-foreground'>
                {t('departments.loading')}
              </p>
            ) : results && results.length > 0 ? (
              results.map((row) => (
                <CheckRow
                  key={row.userId}
                  checked={selected.has(row.userId)}
                  label={
                    row.username && row.name
                      ? `${row.name} · ${row.username}`
                      : personLabel(row)
                  }
                  onCheckedChange={(checked) => toggle(row, checked)}
                />
              ))
            ) : (
              <p className='p-3 text-sm text-muted-foreground'>
                {t('departments.searchEmpty')}
              </p>
            )}
          </div>
          {selected.size > 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('departments.selectedCount', { count: selected.size })}
            </p>
          ) : null}
          {error ? (
            <Alert variant='destructive'>
              <AlertDescription>{t(ruleMessageKey(error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('departments.cancel')}
          </Button>
          <Button
            disabled={busy || selected.size === 0}
            onClick={() => void submit()}
          >
            {busy ? t('departments.adding') : t('departments.addSelected')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
