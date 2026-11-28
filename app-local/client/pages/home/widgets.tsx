import { useApiClient } from '@nocobase/app-client';
import {
  useAuthorizationClient,
  useAuthorizationRevision,
  useCan,
  type AuthorizationRequirement,
} from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { ChartColumn, ClipboardCheck, FileText, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

import { errorText } from '#components/erp/messages';
import { Card, CardContent } from '#components/ui/card';

import {
  INVENTORY_SHORTCUTS,
  INVENTORY_SHORTCUTS_CONDITION,
  QUICK_ACTIONS,
  type InventoryShortcut,
  type QuickAction,
  type WidgetCondition,
} from './dashboard-config.js';

export interface WidgetProps {
  readonly roleKey: string;
  /** 「库存快捷入口」并入本块的按钮网格显示（编号与调整面板仍是两行，只是显示合成一块）。 */
  readonly mergedInventory?: boolean;
}

/** 显示条件这道门不过就不挂载部件，里面数据端点也就不会发请求。 */
export function WidgetGate({
  condition,
  children,
}: {
  readonly condition: WidgetCondition;
  readonly children: ReactNode;
}): ReactElement | null {
  const check: AuthorizationRequirement | undefined =
    condition === 'all'
      ? undefined
      : condition === 'unrestricted'
        ? 'unrestricted'
        : condition;
  const { can, isPending } = useCan(check);
  if (isPending || (check !== undefined && !can)) return null;
  return <>{children}</>;
}

/** 部件内容的卡片：标题行由工作台画，这里只包内容，不再重复一块标题。 */
function WidgetCard({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Card>
      <CardContent className='flex flex-col gap-3'>{children}</CardContent>
    </Card>
  );
}

/** 快捷入口的按钮网格（R-093 第 1、2 节）：两列起，随宽度加到六列。 */
const TILE_GRID =
  'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6';

type TileEntry = QuickAction | InventoryShortcut;

/**
 * 「图标 + 名称」的整块可点磁贴：图标在上、名称在下 —— 六列时一块很窄，
 * 横排会把长名称挤成几行，竖排在 88×64 的块里放得下，也更像一排入口。
 * 焦点样式用全局给 `a[href]` 的一套（styles.css），悬停与按钮一致。
 */
function ActionTile({ entry }: { readonly entry: TileEntry }): ReactElement | null {
  const { t } = useTranslation();
  const { can, isPending } = useCan(entry.requirement);
  if (isPending || !can) return null;
  const Icon = entry.icon;
  return (
    <Link
      to={entry.path}
      className='flex min-h-16 min-w-22 flex-col items-center justify-center gap-1 rounded-lg border border-border p-2 text-sm hover:bg-muted hover:text-foreground'
    >
      <Icon className='size-4 text-muted-foreground' aria-hidden />
      <span className='text-center leading-tight'>{t(entry.titleKey)}</span>
    </Link>
  );
}

export function QuickActionsWidget({
  roleKey,
  mergedInventory = false,
}: WidgetProps): ReactElement | null {
  const client = useAuthorizationClient();
  const revision = useAuthorizationRevision();
  const [visible, setVisible] = useState<readonly TileEntry[]>([]);
  useEffect(() => {
    const actions = QUICK_ACTIONS[roleKey] ?? QUICK_ACTIONS.staff ?? [];
    let alive = true;
    void Promise.all([
      Promise.all(
        actions.map(async (action) => ({
          entry: action,
          allowed: await client.can(action.requirement),
        })),
      ),
      // 并入显示时，库存快捷入口仍按部件自己的显示条件核对一遍。
      mergedInventory ? client.can(INVENTORY_SHORTCUTS_CONDITION) : Promise.resolve(false),
    ]).then(([roleResults, inventoryAllowed]) => {
      if (!alive) return;
      const quick = roleResults
        .filter((result) => result.allowed)
        .map((result) => result.entry);
      if (!inventoryAllowed) {
        setVisible(quick);
        return;
      }
      void Promise.all(
        INVENTORY_SHORTCUTS.map(async (entry) => ({
          entry,
          allowed: await client.can(entry.requirement),
        })),
      ).then((inventoryResults) => {
        if (alive)
          setVisible([
            ...quick,
            ...inventoryResults
              .filter((result) => result.allowed)
              .map((result) => result.entry),
          ]);
      });
    });
    return () => {
      alive = false;
    };
  }, [client, revision, roleKey, mergedInventory]);

  // 一块都看不到时整块不渲染。
  if (visible.length === 0) return null;
  return (
    <WidgetCard>
      <div className={TILE_GRID} data-testid='quick-access-grid'>
        {visible.map((entry) => (
          <ActionTile key={entry.id} entry={entry} />
        ))}
      </div>
    </WidgetCard>
  );
}

/** 待我处理的数字磁贴：名称在上（T5.1），大数字在下，整块可点。 */
function TaskTile({
  to,
  label,
  count,
  icon: Icon,
}: {
  readonly to: string;
  readonly label: string;
  readonly count: number;
  readonly icon: LucideIcon;
}): ReactElement {
  return (
    <Link
      to={to}
      className='flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border border-border p-3 hover:bg-muted hover:text-foreground'
    >
      <span className='flex items-center gap-1 text-sm text-muted-foreground'>
        <Icon className='size-4' aria-hidden />
        {label}
      </span>
      <span className='text-2xl font-semibold tabular-nums'>{count}</span>
    </Link>
  );
}

export function MyTasksWidget(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [counts, setCounts] = useState({ mine: 0, tasks: 0 });
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.request<{ total?: number }>({
        path: 'approvals/mine',
        signal: controller.signal,
      }),
      api.request<{ total?: number }>({
        path: 'approvals/tasks',
        signal: controller.signal,
      }),
    ])
      .then(([mine, tasks]) => {
        if (!controller.signal.aborted)
          setCounts({ mine: mine.total ?? 0, tasks: tasks.total ?? 0 });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api]);

  return (
    <WidgetCard>
      {error !== undefined ? (
        <p role='alert' className='text-sm text-destructive'>
          {errorText(error, t)}
        </p>
      ) : null}
      <div className='grid grid-cols-2 gap-3' data-testid='my-tasks-tiles'>
        <TaskTile
          to='/approvals/tasks'
          label={t('dashboard.tasks.approvals')}
          count={counts.tasks}
          icon={ClipboardCheck}
        />
        <TaskTile
          to='/approvals/mine'
          label={t('dashboard.tasks.mine')}
          count={counts.mine}
          icon={FileText}
        />
      </div>
    </WidgetCard>
  );
}

export function FavoriteReportsWidget(): ReactElement {
  const { t } = useTranslation();
  return (
    <WidgetCard>
      {/* 空态有内容（R-093 第 1 节第 6 条）：图标加一句「为什么空、下一步做什么」。
          待实现（R-078 报表中心落地后）：在说明下补一个带图标的「去报表中心」入口；
          现在没有报表中心路由，不放假链接。 */}
      <div
        data-testid='favorite-reports-empty'
        className='flex flex-col items-center gap-2 p-2 text-center'
      >
        <ChartColumn className='size-4 text-muted-foreground' aria-hidden />
        <p className='text-sm text-muted-foreground'>{t('dashboard.reports.empty')}</p>
      </div>
    </WidgetCard>
  );
}

export function InventoryShortcutsWidget(): ReactElement {
  return (
    <WidgetCard>
      <div className={TILE_GRID} data-testid='inventory-shortcuts-grid'>
        {INVENTORY_SHORTCUTS.map((entry) => (
          <ActionTile key={entry.id} entry={entry} />
        ))}
      </div>
    </WidgetCard>
  );
}
