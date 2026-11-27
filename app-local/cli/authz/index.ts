import { defineCliPlugin } from '@nocobase/app-cli';

import AuthzExport from './export.js';
import AuthzImport from './import.js';
import AuthzUpgradeR002 from './upgrade-r002.js';
import AuthzUpgradeR003 from './upgrade-r003.js';
import AuthzUpgradeR014 from './upgrade-r014.js';
import AuthzUpgradeR014Page from './upgrade-r014-page.js';
import AuthzUpgradeR019Page from './upgrade-r019-page.js';
import AuthzUpgradeR019Price from './upgrade-r019-price.js';
import AuthzUpgradeR020 from './upgrade-r020.js';
import AuthzUpgradeR020Receive from './upgrade-r020-receive.js';
import AuthzUpgradeR020Page from './upgrade-r020-page.js';
import AuthzUpgradeR021 from './upgrade-r021.js';
import AuthzUpgradeR021Price from './upgrade-r021-price.js';
import AuthzUpgradeR021Page from './upgrade-r021-page.js';
import AuthzUpgradeR026 from './upgrade-r026.js';
import AuthzUpgradeR065 from './upgrade-r065.js';
import AuthzUpgradeR064 from './upgrade-r064.js';
import AuthzUpgradeR072 from './upgrade-r072.js';
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
    // R-014：给已有环境的销售/采购补客户/供应商授权。可单独跑、可重跑。
    'upgrade-r014': AuthzUpgradeR014,
    // R-014 页面片：给已有环境的销售/采购补客户与供应商页的页面授权（先补业务授权）。可单独跑、可重跑。
    'upgrade-r014-page': AuthzUpgradeR014Page,
    // R-019 页面片：给已有环境的销售/采购补物料页的页面授权（先补订单授权与 items.view）。可单独跑、可重跑。
    'upgrade-r019-page': AuthzUpgradeR019Page,
    // R-019 加片：给已有环境的 purchase / sales 各补一个价格只读动作。可单独跑、可重跑。
    'upgrade-r019-price': AuthzUpgradeR019Price,
    // R-026：给三个角色补反馈单页与两个新动作，给存量的人补 staff。可单独跑、可重跑。
    'upgrade-r026': AuthzUpgradeR026,
    // R-025：给已有环境的 staff 补班次只读授权。可单独跑、可重跑。
    'upgrade-r025': AuthzUpgradeR025,
    // R-020：给已有环境的 warehouse 补库存授权。可单独跑、可重跑。
    'upgrade-r020': AuthzUpgradeR020,
    // R-020 加片：给已有环境的仓管补收货/发货与库存价格只读动作。可单独跑、可重跑。
    'upgrade-r020-receive': AuthzUpgradeR020Receive,
    // R-020 页面片：给已有环境的仓管补库存查询、入库单、出库单、仓库四页，给销售/采购补仓库页（先补业务授权）。可单独跑、可重跑。
    'upgrade-r020-page': AuthzUpgradeR020Page,
    // R-021/R-022：给已有环境的 purchase / sales 补订单授权与只读引用。可单独跑、可重跑。
    'upgrade-r021': AuthzUpgradeR021,
    // R-021/R-022 加片：给已有环境的采购/销售补订单价格只读动作。可单独跑、可重跑。
    'upgrade-r021-price': AuthzUpgradeR021Price,
    // R-072：给已有环境的 purchase / sales / warehouse 补字典与选项的读授权。可单独跑、可重跑。
    // R-065：给已有环境建财务角色并补三份业务授权。可单独跑、可重跑。
    'upgrade-r065': AuthzUpgradeR065,
    // R-064：建 planning 角色并补评审写动作与台账只读；只加不改，可重跑。
    'upgrade-r064': AuthzUpgradeR064,
    'upgrade-r072': AuthzUpgradeR072,
    // R-021 / R-022 页面片：给已有环境的采购/销售补订单页的页面授权（先补业务授权）。可单独跑、可重跑。
    'upgrade-r021-page': AuthzUpgradeR021Page,
  },
});

export default authzCli;
