import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  BadgeCheck,
  Ban,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  FilePlus2,
  LogOut,
  Pencil,
  Printer,
  RotateCw,
  Send,
  Star,
  Store,
  Trash2,
  Undo2,
  UserCog,
  UserRound,
  UserRoundMinus,
  type LucideIcon,
} from 'lucide-react';

import { ACTION_ICONS } from './action-icons.js';

/**
 * 行内 ⋮ 菜单项的兜底图标：菜单项的稳定键或文案（中文/英文/i18n 键）落到同一个 lucide 图标。
 * 动作键仍在 action-icons 里；这里的键覆盖「编辑、查看、复制」这类没有动作语义的操作。
 */
export const ROW_ACTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  edit: Pencil,
  copy: Copy,
  cancel: Ban,
  cancelOrder: Ban,
  convert: ArrowRightLeft,
  complete: BadgeCheck,
  make: FilePlus2,
  setDefault: Star,
  customer: UserRound,
  supplier: Store,
  open: Eye,
  detail: Eye,
  details: Eye,
  delete: Trash2,
  remove: Trash2,
  primary: Star,
  manager: UserCog,
  transfer: ArrowRightLeft,
  leave: UserRoundMinus,
  rehire: Undo2,
  disable: Ban,
  deactivate: Ban,
  enable: Check,
  activate: Check,
  revokeSessions: LogOut,
  revoke: LogOut,
  rotate: RotateCw,
  moveUp: ArrowUp,
  moveDown: ArrowDown,
};

/** 文案兜底：同时认 i18n 键、中文与英文；顺序靠前的规则优先。 */
export const ROW_ACTION_LABEL_RULES: readonly (readonly [RegExp, LucideIcon])[] =
  [
    [/cancel.?order|cancel|取消订单|取消/u, Ban],
    [/void|作废/u, Ban],
    [/delete|remove|删除|移除/u, Trash2],
    [/deactivate|disable|停用|禁用/u, Ban],
    [/revoke|下线|注销会话|吊销|撤销/u, LogOut],
    [/rotate|轮换/u, RotateCw],
    [/leave|离职/u, UserRoundMinus],
    [/rehire|复职/u, Undo2],
    [/submit|提交/u, Send],
    [/post|过账/u, BadgeCheck],
    [/complete|confirm|确认|完成/u, BadgeCheck],
    [/review|audit|审核/u, ClipboardCheck],
    [/print|打印/u, Printer],
    [/export|download|导出|下载/u, Download],
    [/copy|复制/u, Copy],
    [/edit|编辑/u, Pencil],
    [/moveup|上移/u, ArrowUp],
    [/movedown|下移/u, ArrowDown],
    [/manager|负责人/u, UserCog],
    [/setdefault|makeprimary|默认/u, Star],
    [/customer|客户/u, UserRound],
    [/supplier|供应商/u, Store],
    [/convert|transfer|转换|调岗|转单/u, ArrowRightLeft],
    [/make|生成/u, FilePlus2],
    [/open|detail|查看|详情/u, Eye],
    [/activate|enable|启用/u, Check],
  ];

/** 按键名取图标；取不到时按文案（i18n 键或已翻译文字）兜底。 */
export function iconForRowAction(
  key: string,
  label?: unknown,
): LucideIcon | undefined {
  const byKey =
    (ACTION_ICONS as unknown as Record<string, LucideIcon | undefined>)[key] ??
    ROW_ACTION_ICONS[key];
  if (byKey) return byKey;
  if (typeof label !== 'string') return undefined;
  const text = label.toLowerCase();
  for (const [pattern, icon] of ROW_ACTION_LABEL_RULES)
    if (pattern.test(text)) return icon;
  return undefined;
}
