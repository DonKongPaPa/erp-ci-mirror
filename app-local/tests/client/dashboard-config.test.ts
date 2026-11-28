import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE,
  ROLE_DEFAULTS,
  ROLE_WIDGETS,
  WIDGETS,
  type DashboardPreference,
  type WidgetId,
  parseDashboardPreference,
  resolveWidgets,
} from '../../client/pages/home/dashboard-config.js';
import {
  ROLE_MARKERS,
  resolveRoleKey,
} from '../../client/pages/home/use-dashboard-role.js';

const ids = WIDGETS.map((widget) => widget.id);

describe('dashboard registry and role defaults (R-086)', () => {
  it('registers every first-batch widget with a display condition', () => {
    expect(ids).toEqual([
      'quickActions',
      'myTasks',
      'deliveryReminders',
      'favoriteReports',
      'inventoryShortcuts',
    ]);
    expect(new Set(ids).size).toBe(WIDGETS.length);
    for (const widget of WIDGETS) {
      expect(widget.titleKey).toMatch(/^dashboard\.widgets\./u);
      expect(widget.condition).toBeDefined();
    }
  });

  it('keeps every role default and role allowance within the registry, without duplicates', () => {
    for (const [role, widgets] of Object.entries(ROLE_DEFAULTS)) {
      expect(widgets.length).toBeGreaterThan(0);
      expect(new Set(widgets).size).toBe(widgets.length);
      for (const id of widgets) expect(ids).toContain(id);
      expect(widgets).toContain('deliveryReminders');
      expect(ROLE_WIDGETS[role]).toBeDefined();
      for (const id of ROLE_WIDGETS[role]) expect(ids).toContain(id);
      for (const id of widgets) expect(ROLE_WIDGETS[role]).toContain(id);
    }
    expect(ROLE_DEFAULTS[DEFAULT_ROLE]).toBeDefined();
    expect(Object.keys(ROLE_MARKERS).length).toBeGreaterThan(0);
  });
});

describe('per-account overrides', () => {
  const preference = (
    widgets: readonly { id: WidgetId; collapsed: boolean }[],
  ): DashboardPreference => ({ widgets });

  it('uses the role default when no override is stored', () => {
    expect(resolveWidgets('warehouse', undefined, ROLE_WIDGETS.warehouse)).toEqual(
      ROLE_DEFAULTS.warehouse.map((id) => ({ id, collapsed: false })),
    );
  });

  it('keeps the stored order and collapse flags', () => {
    const stored = preference([
      { id: 'deliveryReminders', collapsed: true },
      { id: 'quickActions', collapsed: false },
    ]);
    expect(resolveWidgets('warehouse', stored, ROLE_WIDGETS.warehouse)).toEqual(
      stored.widgets,
    );
  });

  it('drops identifiers the role is not allowed to see (intersection)', () => {
    const stored = preference([
      { id: 'inventoryShortcuts', collapsed: false },
      { id: 'quickActions', collapsed: false },
      { id: 'deliveryReminders', collapsed: false },
    ]);
    // purchasing never gets the warehouse-only widget, even when it is in the preference.
    expect(
      resolveWidgets('purchase', stored, ROLE_WIDGETS.purchase).map(
        (entry) => entry.id,
      ),
    ).toEqual(['quickActions', 'deliveryReminders']);
  });

  it('drops unknown identifiers and duplicates', () => {
    const stored = {
      widgets: [
        { id: 'quickActions', collapsed: false },
        { id: 'not-a-widget', collapsed: false },
        { id: 'quickActions', collapsed: true },
      ],
    };
    expect(
      resolveWidgets('staff', stored as unknown as DashboardPreference, ROLE_WIDGETS.staff),
    ).toEqual([{ id: 'quickActions', collapsed: false }]);
  });

  it('accepts a valid stored value and rejects malformed or oversized ones', () => {
    const valid = {
      widgets: [{ id: 'quickActions', collapsed: false }],
    };
    expect(parseDashboardPreference(valid)).toEqual(valid);
    expect(parseDashboardPreference({ widgets: 'quickActions' })).toBeUndefined();
    expect(
      parseDashboardPreference({
        widgets: [{ id: 'unknown', collapsed: false }],
      }),
    ).toBeUndefined();
    expect(
      parseDashboardPreference({
        widgets: [
          { id: 'quickActions', collapsed: false, note: 'x'.repeat(5000) },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('role markers', () => {
  it('recognizes root first and falls back to the ordinary employee', () => {
    const all = () => true;
    expect(resolveRoleKey(all)).toBe('root');
    expect(resolveRoleKey(() => false)).toBe(DEFAULT_ROLE);
  });

  it('picks a business role from its defining page grant', () => {
    const can = (check: { resource?: { id?: string } }): boolean =>
      check.resource?.id === 'stock';
    expect(resolveRoleKey(can as Parameters<typeof resolveRoleKey>[0])).toBe(
      'warehouse',
    );
  });
});
