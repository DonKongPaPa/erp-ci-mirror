// @vitest-environment node
import { expect } from 'vitest';

import reportRulesSeed, {
  persistReportRules,
  REPORT_RULE_DEFAULTS,
} from '../../database/main/seeds/202611280032_seed_mes_report_rules.js';
import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-023 W3-1：报工规则四行默认值由种子写入，不是迁移。
 * 种子后恰好四行；重跑不写；已有的行不改值，缺的行才补。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const codes = REPORT_RULE_DEFAULTS.map((rule) => rule.code);
test('R-023 W3-1: the seed writes exactly four default rules and re-running writes nothing', async ({ connection }) => {
  expect(reportRulesSeed.name).toBe('202611280032_seed_mes_report_rules');
  expect(typeof reportRulesSeed.run).toBe('function');
  const rows = await connection.query.selectFrom('report_rules').selectAll().execute();
  expect(rows).toHaveLength(4);
  expect(Object.fromEntries(rows.map((row) => [row.code, row.value]))).toEqual({
    scanReportLimit: 'unrestricted',
    reportOrderLimit: 'none',
    miniProgramPriceDisplay: 'hidden',
    autoReport: 'no',
  });
  expect(await persistReportRules(connection.query)).toEqual({
    inserted: [], skipped: [...codes],
  });
  expect(await connection.query.selectFrom('report_rules').selectAll().execute())
    .toHaveLength(4);
});

test('R-023 W3-1: an existing rule keeps its edited value; only the missing row is inserted', async ({ connection }) => {
  // 前置条件真成立：管理员改过一行，另一行被删掉。
  await connection.query.updateTable('report_rules')
    .set({ value: 'custom-by-admin' })
    .where('code', '=', 'autoReport').execute();
  await connection.query.deleteFrom('report_rules')
    .where('code', '=', 'reportOrderLimit').execute();
  expect(await connection.query.selectFrom('report_rules').selectAll().execute())
    .toHaveLength(3);

  const report = await persistReportRules(connection.query);
  expect(report.inserted).toEqual(['reportOrderLimit']);
  expect(report.skipped.sort()).toEqual(
    codes.filter((code) => code !== 'reportOrderLimit').sort(),
  );

  const rows = await connection.query.selectFrom('report_rules').selectAll().execute();
  expect(rows).toHaveLength(4);
  const byCode = Object.fromEntries(rows.map((row) => [row.code, row.value]));
  expect(byCode.autoReport).toBe('custom-by-admin');
  expect(byCode.reportOrderLimit).toBe('none');
});
