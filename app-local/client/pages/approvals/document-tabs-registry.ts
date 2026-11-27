import type { ReactNode } from 'react';

import type { ApprovalDetail } from './client.js';

/**
 * 「单据内容」的业务页签口子。审批详情对任何流程都通用：默认只显示提交快照的键值，
 * 具体单据（例如请购单）按 `collectionName` 注册自己的页签，接手那一路只加下面这一条，
 * 不改审批页与服务端。
 */
export interface ApprovalDocumentTab {
  readonly key: string;
  /** 翻译键，必须同时存在于 client/locales/zh-CN.ts 与 en-US.ts。 */
  readonly titleKey: string;
  readonly render: (detail: ApprovalDetail) => ReactNode;
}

const registry = new Map<string, readonly ApprovalDocumentTab[]>();

export function registerApprovalDocumentTabs(
  collectionName: string,
  tabs: readonly ApprovalDocumentTab[],
): void {
  registry.set(collectionName, tabs);
}

export function approvalDocumentTabs(
  collectionName: string,
): readonly ApprovalDocumentTab[] {
  return registry.get(collectionName) ?? [];
}
