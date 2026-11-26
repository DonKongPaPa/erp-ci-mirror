/**
 * 反馈单页的页面授权 id。seed、路由与守门测试共用这一个值：它只管「能不能打开这一页」，
 * 打开之后能做什么由 `fqc` 的 `submit` / `maintain` 两个动作决定（见 R-026「页面」）。
 * 改名是存量授权的数据迁移，不是重构。
 */
export const FEEDBACK_PAGE_ID = 'feedback' as const;

/** 页面里的两个业务动作，与 `server/fqc-resources.ts` 的动作名一致。 */
export const FQC_RESOURCE = { type: 'composite', id: 'fqc' } as const;
