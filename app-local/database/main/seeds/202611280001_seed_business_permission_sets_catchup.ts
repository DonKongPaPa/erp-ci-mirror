import { defineSeed } from '@nocobase/db';

import { ensureBusinessPermissionSets } from './202611240001_seed_business_permission_sets.ts';

/**
 * R-075：补齐后来加进原种子、但执行过原种子的环境里没有的业务角色。
 *
 * 原种子 202611240001 已经被执行过，改它的源文件只会得到框架的校验和警告，不会重跑。
 * 这一颗用与原种子同一个「逐个确保权限集存在」的函数：全新安装时它紧跟着原种子执行，
 * 七个角色都已存在，全部跳过；已有环境执行 `pnpm nocobase db apply` 时只跑这一颗，
 * 补出后来加的角色。已经存在的 key 一律跳过，管理员改过的角色不被覆盖。
 *
 * 角色的定义仍只在原种子那一份里，不在这份文件复制 —— 两份定义分叉比缺角色更难查。
 */
export default defineSeed({
  name: '202611280001_seed_business_permission_sets_catchup',
  async run({ query }) {
    await ensureBusinessPermissionSets(query);
  },
});
