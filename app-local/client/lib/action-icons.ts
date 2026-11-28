import {
  BadgeCheck,
  Ban,
  ClipboardCheck,
  Download,
  Plus,
  Printer,
  Save,
  Send,
  X as XIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * 主操作的图标：同一动作全站只用一个 lucide-react 图标。
 * 按钮从这张表按动作键取，不各页各写；`data-icon='inline-start'` 由按钮自己加。
 */
export type ActionIconKey =
  | 'create'
  | 'submit'
  | 'post'
  | 'void'
  | 'print'
  | 'export'
  | 'review'
  | 'save'
  | 'cancel';

export interface ActionIconMap {
  readonly create: LucideIcon;
  readonly submit: LucideIcon;
  readonly post: LucideIcon;
  readonly void: LucideIcon;
  readonly print: LucideIcon;
  readonly export: LucideIcon;
  readonly review: LucideIcon;
  readonly save: LucideIcon;
  readonly cancel: LucideIcon;
}

export const ACTION_ICONS: ActionIconMap = {
  create: Plus,
  submit: Send,
  post: BadgeCheck,
  void: Ban,
  print: Printer,
  export: Download,
  review: ClipboardCheck,
  save: Save,
  cancel: XIcon,
};

/** RowActions 的动作键与表一致时直接取图标；其余键返回 undefined。 */
export function iconForAction(key: string): LucideIcon | undefined {
  return (ACTION_ICONS as unknown as Readonly<Record<string, LucideIcon | undefined>>)[key];
}
