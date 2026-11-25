import { Linter } from 'eslint';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
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
  {
    name: '未 await 的 user.click 也算动作',
    source: [
      'user.click(save);',
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

  it('treats assembly and custom-wait helpers as neutral or steady', () => {
    const safe = [
      [
        'const { app, runtime } = await createRuntime([\'en-US\']);',
        'renderMenu(app, runtime);',
        "screen.getByRole('button', { name: 'Account' }).focus();",
      ],
      [
        'const runtime = await setup(<AppLayout />);',
        "expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();",
      ],
      [
        "await findSidebarLink('Home');",
        "expect(within(sidebar()).getByRole('link', { name: 'Home' })).toHaveAttribute('data-active');",
      ],
      [
        'await waitForPermissions(requests);',
        "expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();",
      ],
    ];
    for (const source of safe)
      expect(lint(source.join('\n')), `误报：${source[0]}`).toEqual([]);
  });

  it('still reports an interaction passed to a custom wait helper', () => {
    const source = [
      'await waitForPermissions(() => user.click(save));',
      "expect(screen.getByText('Saved')).toBeVisible();",
    ].join('\n');
    expect(lint(source).map((message) => message.messageId)).toEqual([
      'syncQueryAfterAction',
    ]);
  });

  // 复现验收员在 PR #50 复核表里的 A–G：名单外的自定义封装一律回落到「清稳态」。
  it('reports the review patterns A-G after narrowing the allowlist', () => {
    const patterns: Record<string, string> = {
      A: 'async function setupSave() { await user.click(save); }\nawait setupSave();\nexpect(screen.getByText("Saved")).toBeVisible();',
      B: 'async function findRow() { fireEvent.click(row); await findByText("Row"); }\nawait findRow();\nexpect(screen.getByText("Saved")).toBeVisible();',
      C: 'async function waitForCache() {}\nawait waitForCache();\nexpect(screen.getByText("Saved")).toBeVisible();',
      D: 'await waitFor(() => user.click(save));\nexpect(screen.getByText("Saved")).toBeVisible();',
      E: 'await setup(() => user.click(save));\nexpect(screen.getByText("Saved")).toBeVisible();',
      F: 'await waitForPermissions(() => user.click(save));\nexpect(screen.getByText("Saved")).toBeVisible();',
      G: 'await assemble();\nexpect(screen.getByText("Saved")).toBeVisible();',
    };
    for (const [name, source] of Object.entries(patterns))
      expect(
        lint(source).map((message) => message.messageId),
        `${name} 应报同步查询`,
      ).toEqual(['syncQueryAfterAction']);
  });

  /**
   * 已知漏报（R-047「没覆盖的」待主会话补写）：名单里的 helper 如果自己在函数体里点击，
   * 规则不进入 helper 函数体，外面的同步查询会被放过。这不是新放宽 —— 规则一直不做跨函数
   * 数据流分析 —— 但名字进名单后要在这里钉住，避免下一个人以为名单里的名字天然安全。
   */
  it('known blind spot: a listed helper that clicks inside its body hides the outer query', () => {
    const source = [
      'async function setup() { await user.click(save); }',
      'await setup();',
      "expect(screen.getByText('Saved')).toBeVisible();",
    ].join('\n');
    expect(lint(source)).toEqual([]);
  });
});

/** 行内豁免的理由按类别写，类别在 verification.md 的 2c 节里逐条解释。 */
const reasonCategories = [
  '查的是组件本地 state，交互后同步重渲染，不依赖异步请求',
  '查的是动作前就存在的节点（点击受体、静态结构或已显示的内容）',
  '装配阶段的同步查询：setup/render 之后即测试起点',
  'await 的封装结束时 DOM 已同步落地，查的是它的同步产出',
  '断言的是受控输入值或 rerender 传入的同步值',
];

describe('sync query guard inline reasons', () => {
  it('uses one of the documented categories on every exemption', () => {
    const client = fileURLToPath(new URL('../client', import.meta.url));
    const reasons = new Set<string>();
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.tsx?$/u.test(entry.name)) {
          for (const line of readFileSync(path, 'utf8').split('\n')) {
            const match = line.match(
              /eslint-disable-next-line app-local\/no-sync-query-after-action -- (.+)$/u,
            );
            if (match) reasons.add(match[1].trim());
          }
        }
      }
    };
    visit(client);
    expect(reasons.size, '不允许所有豁免共用一句模板理由').toBeGreaterThan(1);
    for (const reason of reasons)
      expect(reasonCategories, `未登记的豁免理由：${reason}`).toContain(reason);
    for (const category of reasonCategories)
      expect(reasons, `没有用到的类别：${category}`).toContain(category);

    const verification = readFileSync(
      fileURLToPath(new URL('../../../.agents/rules/verification.md', import.meta.url)),
      'utf8',
    );
    const section = verification.split('### 2c.')[1]?.split('\n### ')[0] ?? '';
    for (const category of reasonCategories)
      expect(section, `2c 节没有解释：${category}`).toContain(category);
  });
});
