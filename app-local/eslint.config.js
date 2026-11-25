import { createApplicationConfig } from '@nocobase/dev-config/eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import noSyncQueryAfterAction from './eslint-rules/no-sync-query-after-action.js';

/**
 * 可访问性的静态规则（R-039 第二道门）：`eslint-plugin-jsx-a11y` 的推荐配置，
 * 只对应用自己的客户端文件生效。`client/components/ui/` 是 shadcn 的 primitive，
 * 按 CLI 生成的样子原样保留，所以和框架的其它豁免一样不套这一层。
 *
 * 现有的违例逐条用行内禁用写明理由，不整体调弱规则。
 */
const accessibility = {
  ...jsxA11y.flatConfigs.recommended,
  name: 'app-local/accessibility',
  files: ['client/**/*.{js,jsx,ts,tsx}'],
  ignores: ['client/components/ui/**'],
  rules: {
    ...jsxA11y.flatConfigs.recommended.rules,
    // 推荐配置把这条关掉了，验收要求「没有可访问名的图标按钮」必须报错。打开时沿用插件
    // 自己给这条规则写的选项（忽略的组合控件与 aria 角色），不自己发明一套。
    'jsx-a11y/control-has-associated-label': [
      'error',
      jsxA11y.flatConfigs.recommended.rules[
        'jsx-a11y/control-has-associated-label'
      ][1],
    ],
  },
};

/**
 * 同步查询守门（R-047）：只在客户端测试里生效。触发动作之后、没等到 findBy/waitFor
 * 就同步查一个可能还没出现的元素，是本机绿远端红的头号来源。规则本体在 eslint-rules/，
 * 误报用行内禁用写明理由，不放宽规则。
 */
const syncQueryGuard = {
  name: 'app-local/sync-query-guard',
  files: ['tests/client/**/*.{js,jsx,ts,tsx}'],
  plugins: {
    'app-local': {
      rules: { 'no-sync-query-after-action': noSyncQueryAfterAction },
    },
  },
  rules: {
    'app-local/no-sync-query-after-action': 'error',
  },
};

export default [
  ...createApplicationConfig({
    tsconfigRootDir: import.meta.dirname,
    ignores: [
      '.extension-state/**',
      'client-old/**',
      'public/r/**',
      'storage/**',
      // Internal workspace packages own their lint and TypeScript configurations.
      'packages/**',
    ],
  }),
  // After the framework's config on purpose: this block only adds rules, scoped to the app's own files.
  accessibility,
  syncQueryGuard,
];
