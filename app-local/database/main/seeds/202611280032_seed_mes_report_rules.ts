import { randomUUID } from 'node:crypto';

import { defineSeed, type QueryAdapter } from '@nocobase/db';

/**
 * R-023 W3-1：报工规则的四行默认值。迁移只管表结构，默认值走种子；
 * 已有环境 `db apply` 会跑这一颗，管理员改过的行不会被覆盖。
 *
 * 幂等只看这一行在不在：按 code 查，缺哪行补哪行，已有的值一律不改。
 */
export const REPORT_RULE_DEFAULTS = [
  { code: 'scanReportLimit', value: 'unrestricted' },
  { code: 'reportOrderLimit', value: 'none' },
  { code: 'miniProgramPriceDisplay', value: 'hidden' },
  { code: 'autoReport', value: 'no' },
] as const;

export interface ReportRulesSeedReport {
  readonly inserted: readonly string[];
  readonly skipped: readonly string[];
}

export async function persistReportRules(
  query: QueryAdapter,
): Promise<ReportRulesSeedReport> {
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const rule of REPORT_RULE_DEFAULTS) {
    const existing = await query
      .selectFrom('reportRules')
      .select(['code'])
      .where('code', '=', rule.code)
      .executeTakeFirst();
    if (existing !== undefined) {
      skipped.push(rule.code);
      continue;
    }
    await query
      .insertInto('reportRules')
      .values({
        id: randomUUID(),
        code: rule.code,
        value: rule.value,
        updatedById: null,
        updatedAt: new Date(),
      })
      .execute();
    inserted.push(rule.code);
  }
  return { inserted, skipped };
}

export default defineSeed({
  name: '202611280032_seed_mes_report_rules',
  async run({ query }) {
    await persistReportRules(query);
  },
});
