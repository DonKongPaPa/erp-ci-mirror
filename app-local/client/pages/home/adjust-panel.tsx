import { useTranslation } from '@nocobase/i18n/client';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';

import {
  DEFAULT_ROLE,
  ROLE_DEFAULTS,
  ROLE_WIDGETS,
  WIDGETS,
  resolveWidgets,
  type DashboardPreference,
  type WidgetId,
} from './dashboard-config.js';

interface Row {
  readonly id: WidgetId;
  readonly checked: boolean;
  readonly collapsed: boolean;
}

function rowsFor(
  roleKey: string,
  preference: DashboardPreference | undefined,
): readonly Row[] {
  const allowed = ROLE_WIDGETS[roleKey] ?? ROLE_WIDGETS[DEFAULT_ROLE] ?? [];
  const effective = resolveWidgets(roleKey, preference, allowed);
  const ordered = [
    ...effective.map((entry) => entry.id),
    ...allowed.filter((id) => !effective.some((entry) => entry.id === id)),
  ];
  return ordered.map((id) => ({
    id,
    checked: effective.some((entry) => entry.id === id),
    collapsed: effective.find((entry) => entry.id === id)?.collapsed ?? false,
  }));
}

function defaultRows(roleKey: string): readonly Row[] {
  const fallback = ROLE_DEFAULTS[DEFAULT_ROLE] ?? [];
  return (ROLE_DEFAULTS[roleKey] ?? fallback).map((id) => ({
    id,
    checked: true,
    collapsed: false,
  }));
}

export function AdjustPanel({
  open,
  onOpenChange,
  roleKey,
  preference,
  onChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly roleKey: string;
  readonly preference: DashboardPreference | undefined;
  readonly onChange: (next: DashboardPreference | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly Row[]>(() => rowsFor(roleKey, preference));
  // 每次打开面板现取一次当前偏好；关闭期间外部改动不会带进正在编辑的草稿。
  const changeOpen = (next: boolean) => {
    if (next) setRows(rowsFor(roleKey, preference));
    onOpenChange(next);
  };

  const emit = (next: readonly Row[]) => {
    setRows(next);
    onChange({
      widgets: next
        .filter((row) => row.checked)
        .map((row) => ({ id: row.id, collapsed: row.collapsed })),
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    emit(next);
  };

  const title = (id: WidgetId) =>
    t(WIDGETS.find((widget) => widget.id === id)?.titleKey ?? '');

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dashboard.adjustTitle')}</DialogTitle>
          <DialogDescription>{t('dashboard.adjustDescription')}</DialogDescription>
        </DialogHeader>
        <ul className='flex flex-col gap-1'>
          {rows.map((row, index) => (
            <li key={row.id} className='flex items-center gap-2 rounded-md border border-border px-2 py-1.5'>
              <Checkbox
                aria-label={title(row.id)}
                checked={row.checked}
                onCheckedChange={(checked) =>
                  emit(
                    rows.map((item) =>
                      item.id === row.id ? { ...item, checked } : item,
                    ),
                  )
                }
              />
              <span className='min-w-0 flex-1 text-sm'>{title(row.id)}</span>
              <Button
                aria-label={t('dashboard.moveUp')}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                size='icon'
                variant='ghost'
              >
                <ArrowUp />
              </Button>
              <Button
                aria-label={t('dashboard.moveDown')}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
                size='icon'
                variant='ghost'
              >
                <ArrowDown />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          variant='outline'
          onClick={() => {
            const next = defaultRows(roleKey);
            setRows(next);
            onChange(undefined);
          }}
        >
          {t('dashboard.reset')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
