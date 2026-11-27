import { defineCliPlugin } from '@nocobase/app-cli';

import AuthzExport from './export.js';
import AuthzImport from './import.js';
import AuthzUpgradeR002 from './upgrade-r002.js';
import AuthzUpgradeR003 from './upgrade-r003.js';
import AuthzUpgradeR026 from './upgrade-r026.js';
import AuthzUpgradeR025 from './upgrade-r025.js';

/**
 * `authz export` / `authz import`（R-013 验收第 8 条）。
 *
 * 本应用自己的命令放在 `cli/commands/` 时挂在 `app` 主题下（`pnpm nocobase app …`），
 * 而设计把这两个命令定成 `pnpm nocobase authz export`。所以这里用 CLI 插件的形式
 * 登记一个本地主题：`pluginTopicFor()` 把包名 `@app-local/authz-cli` 变成 `authz`，
 * 命令由 `cli/plugins.ts` 一并注册。包名只是主题的来源与冲突提示用的名字。
 */
const authzCli = defineCliPlugin({
  packageName: '@app-local/authz-cli',
  description: 'Export and import authorization data.',
  commands: {
    export: AuthzExport,
    import: AuthzImport,
    // R-002：给两个质量角色补上确认记录表的全量范围、知识库页面与 kb.knowledge 档位。可单独跑、可重跑。
    'upgrade-r002': AuthzUpgradeR002,
    // R-003：给已有环境补「处理工单」与「维护派单规则」，可单独跑、可重跑。
    'upgrade-r003': AuthzUpgradeR003,
    // R-026：给三个角色补反馈单页与两个新动作，给存量的人补 staff。可单独跑、可重跑。
    'upgrade-r026': AuthzUpgradeR026,
    // R-025：给已有环境的 staff 补班次只读授权。可单独跑、可重跑。
    'upgrade-r025': AuthzUpgradeR025,
  },
});

export default authzCli;
