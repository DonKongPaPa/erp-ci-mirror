import { useTranslation } from '@nocobase/i18n/client';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { PageContainer } from '#components/page-container';
import { Button } from '#components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#components/ui/collapsible';

import { AdjustPanel } from './adjust-panel.js';
import {
  DEFAULT_ROLE,
  ROLE_WIDGETS,
  WIDGETS,
  resolveWidgets,
  type DashboardPreference,
  type WidgetId,
  type WidgetState,
} from './dashboard-config.js';
import { WidgetGate } from './widgets.js';
import { WIDGET_RENDERERS } from './widget-registry.js';

export interface DashboardProps {
  /** 登录者的角色；不传时按普通员工。 */
  readonly roleKey?: string;
  /** 按账户偏好；不传时用角色默认。 */
  readonly preference?: DashboardPreference;
  /** 调整后回写偏好；undefined 表示恢复角色默认。 */
  readonly onChange?: (next: DashboardPreference | undefined) => void;
}

/**
 * 每个部件在 12 栏栅格里的跨栏（R-093 第 1 节）：窄屏整行，md 到 xl 之间半行或整行，
 * xl 起按 8/4 分栏。库存快捷入口单独显示时与快捷入口同宽；并入时占不到这一格。
 */
const CELL_SPANS: Readonly<Record<WidgetId, string>> = {
  quickActions: 'col-span-12 xl:col-span-8',
  myTasks: 'col-span-12 md:col-span-6 xl:col-span-4',
  deliveryReminders: 'col-span-12 xl:col-span-8',
  favoriteReports: 'col-span-12 md:col-span-6 xl:col-span-4',
  inventoryShortcuts: 'col-span-12 xl:col-span-8',
};

interface RenderUnit {
  /** 这一格的部件：决定位置、显示条件与收起状态。 */
  readonly anchor: WidgetState;
  /** 「库存快捷入口」并进这一格的按钮网格显示。 */
  readonly mergedInventory: boolean;
}

/**
 * 显示上的合并（首页改版）：「常用操作」与「库存快捷入口」都在有效清单时合成一块快捷入口，
 * 占两件里靠前那件的位置，收起状态也用它；靠后的那件不再单独占格。
 * 编号、显示条件与调整面板里的两行都不变，这只是显示上的合并。
 */
function renderUnits(effective: readonly WidgetState[]): readonly RenderUnit[] {
  const quickIndex = effective.findIndex((entry) => entry.id === 'quickActions');
  const inventoryIndex = effective.findIndex((entry) => entry.id === 'inventoryShortcuts');
  const merged = quickIndex >= 0 && inventoryIndex >= 0;
  const anchorIndex = merged ? Math.min(quickIndex, inventoryIndex) : -1;
  const skipIndex = merged ? Math.max(quickIndex, inventoryIndex) : -1;
  return effective.flatMap((entry, index) =>
    index === skipIndex
      ? []
      : [{ anchor: entry, mergedInventory: index === anchorIndex }],
  );
}

/** R-086 首页工作台：顶部操作条，下面按有效清单在 12 栏栅格上排部件。 */
export function Dashboard({
  roleKey,
  preference,
  onChange,
}: DashboardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [adjustOpen, setAdjustOpen] = useState(false);
  const activeRole = roleKey ?? DEFAULT_ROLE;
  const allowed = ROLE_WIDGETS[activeRole] ?? ROLE_WIDGETS[DEFAULT_ROLE] ?? [];
  const effective = resolveWidgets(activeRole, preference, allowed);
  const [today] = useState(() =>
    new Intl.DateTimeFormat(i18n.language, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date()),
  );

  const setCollapsed = (id: WidgetId, collapsed: boolean) => {
    const widgets: readonly WidgetState[] = effective.map((entry) =>
      entry.id === id ? { ...entry, collapsed } : entry,
    );
    onChange?.({ widgets });
  };

  return (
    // 页面占满外壳给的内容区，不套限宽（R-093 第 1 节第 1 条）；留白按档位显式分三档
    // （手机 16、桌面 24、大屏 32），比外壳默认的 sm:p-6 md:p-8 更贴指引的分档。
    <PageContainer className='p-4 sm:p-4 md:p-6 xl:p-8'>
      <header className='flex flex-wrap items-end justify-between gap-3'>
        <div className='flex flex-col gap-1'>
          <h1 className='font-heading text-2xl font-semibold'>
            {t('dashboard.greeting')}
          </h1>
          <p className='text-sm text-muted-foreground'>{today}</p>
        </div>
        <Button variant='outline' onClick={() => setAdjustOpen(true)}>
          <SlidersHorizontal />
          {t('dashboard.adjust')}
        </Button>
      </header>
      {effective.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{t('dashboard.empty')}</p>
      ) : (
        <div className='grid grid-cols-12 gap-4'>
          {renderUnits(effective).map((unit) => {
            const definition = WIDGETS.find((widget) => widget.id === unit.anchor.id);
            if (!definition) return null;
            const Renderer = WIDGET_RENDERERS[unit.anchor.id];
            const title = t(definition.titleKey);
            return (
              <WidgetGate key={unit.anchor.id} condition={definition.condition}>
                <div
                  data-widget-id={unit.anchor.id}
                  className={CELL_SPANS[unit.anchor.id]}
                >
                  <Collapsible
                    open={!unit.anchor.collapsed}
                    onOpenChange={(open) => setCollapsed(unit.anchor.id, !open)}
                    className='flex flex-col gap-2'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <h2 className='text-base font-medium'>{title}</h2>
                      <Button
                        aria-label={t('dashboard.toggle', { title })}
                        size='icon'
                        variant='ghost'
                        render={<CollapsibleTrigger />}
                      >
                        <ChevronDown className='transition-transform group-data-panel-open:rotate-180' />
                      </Button>
                    </div>
                    <CollapsibleContent>
                      <Renderer
                        roleKey={activeRole}
                        mergedInventory={unit.mergedInventory}
                      />
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </WidgetGate>
            );
          })}
        </div>
      )}
      <AdjustPanel
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        roleKey={activeRole}
        preference={preference}
        onChange={(next) => onChange?.(next)}
      />
    </PageContainer>
  );
}
