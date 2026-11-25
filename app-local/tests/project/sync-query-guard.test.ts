import { Linter } from 'eslint';
import rule from '../../eslint-rules/no-sync-query-after-action.js';
import { describe, expect, it } from 'vitest';

/**
 * 同步查询守门的回归样例（R-047）。
 *
 * 五段坏写法分别提炼自 2026-11-25 夜里让远端单测线变红的五处：行菜单 Revoke（8c72c4d）、
 * 状态文字 Inactive（084d151）、投递区占位没让位（6c10c24）、重放提示（9649115），
 * 外加一例 fireEvent 之后同步查。样例取的是「触发动作 → 没等到稳态就同步查」这一形态，
 * 不是逐字拷贝修前源码 —— 规则按语句顺序判稳态，不做数据流分析。
 *
 * 先有这份测试、规则还是空实现时它必须红；把规则关掉时五段样例必须不再报错。
 */

const linter = new Linter();
const config = {
  files: ['tests/client/**/*.{ts,tsx}'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: {
    'app-local': {
      rules: { 'no-sync-query-after-action': rule },
    },
  },
  rules: { 'app-local/no-sync-query-after-action': 'error' },
};

const lint = (source: string) =>
  linter.verify(source, config, 'tests/client/sample.test.tsx');

const cases = [
  {
    name: '行菜单 Revoke：点开动作菜单后立刻查菜单项',
    source: [
      'await user.click(rowActions);',
      "expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeVisible();",
    ].join('\n'),
    line: 2,
  },
  {
    name: 'Inactive：等对话框消失不等于等到状态文字更新',
    source: [
      "await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));",
      'await dialogClosed();',
      "expect(within(childRow).getByText('Inactive')).toBeVisible();",
    ].join('\n'),
    line: 3,
  },
  {
    name: '占位没让位就断言它不在',
    source: [
      'await user.click(screen.getByRole("button", { name: "Apply" }));',
      "expect(screen.queryByTestId('intake-placeholder')).not.toBeInTheDocument();",
    ].join('\n'),
    line: 2,
  },
  {
    name: '重放的提示：提交后同步查提示文案',
    source: [
      'await user.click(retry);',
      'expect(screen.getByText(replayed)).toBeVisible();',
    ].join('\n'),
    line: 2,
  },
  {
    name: 'fireEvent 之后同步查',
    source: [
      'fireEvent.click(submit);',
      "expect(screen.getByText('Saved')).toBeVisible();",
    ].join('\n'),
    line: 2,
  },
];

describe('sync query guard', () => {
  for (const sample of cases) {
    it(`reports the sync query with its line: ${sample.name}`, () => {
      const messages = lint(sample.source);
      expect(messages.map((message) => message.messageId)).toEqual([
        'syncQueryAfterAction',
      ]);
      expect(messages[0].line).toBe(sample.line);
      expect(messages[0].message).toContain('findBy');
      expect(messages[0].message).toContain('waitFor');
    });
  }

  it('does not report any of them when the rule is off', () => {
    const off = {
      ...config,
      rules: { 'app-local/no-sync-query-after-action': 'off' },
    };
    for (const sample of cases)
      expect(
        linter.verify(sample.source, off, 'tests/client/sample.test.tsx'),
        `规则关掉后 ${sample.name} 不应该再报错`,
      ).toEqual([]);
  });

  it('leaves steady state alone before the first action and around real waits', () => {
    const safe = [
      "expect(screen.getByRole('heading')).toBeVisible();",
      'await user.click(button);',
      'await waitFor(() => expect(screen.getByText("ready")).toBeVisible());',
      'await user.click(next);',
      'await screen.findByRole("menuitem", { name: "Revoke" });',
      'expect(screen.getByText("done")).toBeVisible();',
    ].join('\n');
    expect(lint(safe)).toEqual([]);
  });

  it('treats a query inside a waitFor callback as correct', () => {
    const source = [
      'await user.click(button);',
      'await waitFor(() =>',
      '  expect(screen.getByText("ready")).toBeVisible(),',
      ');',
    ].join('\n');
    expect(lint(source)).toEqual([]);
  });

  it('does not count queryBy outside an assertion as a violation', () => {
    const source = [
      'await user.click(button);',
      "const missing = screen.queryByText('gone');",
    ].join('\n');
    expect(lint(source)).toEqual([]);
  });

  it('honours an inline disable with a reason', () => {
    const source = [
      'await user.click(button);',
      '// eslint-disable-next-line app-local/no-sync-query-after-action -- local state only, no fetch',
      "expect(screen.getByText('toggled')).toBeVisible();",
    ].join('\n');
    expect(lint(source)).toEqual([]);
  });
});
