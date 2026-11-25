import { resolveAppRuntime } from '@nocobase/app-client/runtime';
import { expect, it } from 'vitest';
import appRuntime from '../../client/runtime.js';
import {
  capabilityExpectations,
  type CapabilityStatus,
} from '../helpers/capability-expectations.js';
// 状态怎么算是框架的规则，而这两个判定函数它没有公开导出。直接引它的实现，不另抄一份：
// 抄的那份不会跟着框架升级变。
import { findApiKeysManagement } from '../../node_modules/@nocobase/app-plugin-foundation/dist/client/capability-guide/details/capability-management.js';
import { findCapabilityPage } from '../../node_modules/@nocobase/app-plugin-foundation/dist/client/capability-guide/details/find-capability-page.js';

/**
 * R-031：「功能与扩展」页上每项能力项的状态，与《前端与地基配置规划》里的处置一致。
 *
 * 用户靠这一页看 NocoBase 的地基还缺什么。状态是客户端拿路由表现算的，没有任何接口能导出，
 * 所以钉一张写死的表：登记了一个页面、或者不小心把某个页面的登记弄丢了，这里都会红。
 *
 * 这里只断言客户端能判的部分。要服务端发布的东西才能判的五项
 * （密码登录、自助注册、找回密码、消息与通知语言、数据库连接）在
 * `tests/server/capability-status.test.ts` 里；这里只查它们依赖的页面还在。
 */

/** 管理员看这一页：没有任何页面被拒。被拒只影响「能不能打开」，不影响状态。 */
const DENIED = new Set<string>();

const PROVIDED: CapabilityStatus = '已提供';
const UNCONFIGURED: CapabilityStatus = '未配置';

it('R-031: keeps every route-decided capability item at the status the plan decided', async () => {
  const runtime = await resolveAppRuntime(appRuntime);
  const { routes } = runtime;
  const locales = runtime.i18n
    .getLocaleDefinitions()
    .map((definition) => definition.locale);
  const defaultLocale = runtime.i18n.getDefaultLocale();

  const actual = new Map<string, CapabilityStatus>();
  const serverItems: string[] = [];
  for (const item of capabilityExpectations) {
    const { decidedBy } = item;
    if (decidedBy.kind === 'page') {
      actual.set(
        item.title,
        findCapabilityPage(routes, DENIED, decidedBy.names, decidedBy.paths)
          ? PROVIDED
          : UNCONFIGURED,
      );
    } else if (decidedBy.kind === 'apiKeyPage') {
      actual.set(
        item.title,
        findApiKeysManagement(routes, DENIED, decidedBy.scope)
          ? PROVIDED
          : UNCONFIGURED,
      );
    } else if (decidedBy.kind === 'clientLocales') {
      const configured =
        decidedBy.rule === 'any'
          ? locales.length > 0
          : decidedBy.rule === 'moreThanOne'
            ? locales.length > 1
            : locales.includes(defaultLocale);
      actual.set(item.title, configured ? PROVIDED : UNCONFIGURED);
    } else if (decidedBy.kind === 'server') {
      // 最终状态在服务端测试里断言。这里只查前提：它依赖的页面都还在。
      for (const page of decidedBy.pages) {
        expect(
          findCapabilityPage(routes, DENIED, page.names),
          // 这条规则只认单个字符串字面量做提示，所以不拆成两行拼接。
          `「${item.title}」依赖的页面（路由名 ${page.names.join('、')}）不在了，服务端那一半的断言会因此失去意义，先查这里。`,
        ).toBeDefined();
      }
      serverItems.push(item.title);
    }
    // notByRoute（待确认的五项）框架不按路由判，登记了页面状态也不变，这里没有可算的东西。
  }

  // 表里的每一项都要么在这里被判了，要么归服务端测试管。漏掉哪一项，这一条会红。
  const decidedHere = capabilityExpectations
    .filter(
      (item) =>
        item.decidedBy.kind !== 'server' &&
        item.decidedBy.kind !== 'notByRoute',
    )
    .map((item) => item.title);
  expect([...actual.keys()].sort()).toEqual([...decidedHere].sort());
  expect(serverItems.sort()).toEqual(
    capabilityExpectations
      .filter((item) => item.decidedBy.kind === 'server')
      .map((item) => item.title)
      .sort(),
  );

  const mismatches = capabilityExpectations
    .filter((item) => actual.has(item.title))
    .filter((item) => actual.get(item.title) !== item.expected)
    .map(
      (item) =>
        `「${item.title}」（${item.plugin}）：期望${item.expected}，实际${actual.get(item.title)}`,
    );
  expect(
    mismatches,
    `「功能与扩展」页上有能力项的状态变了。是有意做的就同步改 tests/helpers/capability-expectations.ts 与《前端与地基配置规划》；不是有意的，就是哪个页面的登记丢了。`,
  ).toEqual([]);
});

it('R-042: marks each AI Agent plugin page as provided by name', async () => {
  const runtime = await resolveAppRuntime(appRuntime);
  // 设计第 1 条要求逐项点名，不靠计数：这五项各钉一条，哪一项的页面登记丢了都能从报错里直接读出来。
  // `/authentication/capabilities` 只发布找回密码一项，判不了这五个页面；状态由路由决定，所以钉在这里。
  const pages = [
    ['Agent 管理界面', 'agents'],
    ['模型管理界面', 'models'],
    ['技能管理界面', 'skills'],
    ['机器连接界面', 'runtimes'],
    ['用量查看界面', 'usage'],
  ] as const;
  for (const [title, name] of pages) {
    const item = capabilityExpectations.find((entry) => entry.title === title);
    expect(item, `期望表里没有「${title}」`).toBeDefined();
    expect(item?.expected, `「${title}」的期望状态应当是已提供`).toBe(PROVIDED);
    expect(
      findCapabilityPage(runtime.routes, DENIED, [name]),
      `「${title}」的路由 ${name} 不在注册树里`,
    ).toBeDefined();
  }
});

it('R-031: keeps the expectation table itself whole', () => {
  const titles = capabilityExpectations.map((item) => item.title);
  expect(new Set(titles).size, '期望表里有重名的能力项').toBe(titles.length);
  const tally = capabilityExpectations.reduce<Record<string, number>>(
    (counts, item) => ({
      ...counts,
      [item.expected]: (counts[item.expected] ?? 0) + 1,
    }),
    {},
  );
  // 盘点时是 11 / 16 / 6。第 0 步登记了用户、角色与权限、默认数据范围三组管理页，
  // 授权的 3 项与用户管理的 1 项变成已提供；R-042 登记 AI Agent 插件的五个管理页。
  // R-032 与 R-034 又登记了两个密钥页与通知记录页，模板目录随通知模块出现。
  // R-002 的知识库客户端插件登记 /knowledge 后，「知识库界面」从未配置变已提供。
  expect(tally).toEqual({ 已提供: 25, 未配置: 3, 待确认: 5 });
});

it('R-032/R-034: names the two API key pages and both notification pages as provided', async () => {
  const runtime = await resolveAppRuntime(appRuntime);
  const { routes } = runtime;

  for (const [scope, expected] of [
    ['personal', 'apiKeysManagement'],
    ['application', 'applicationApiKeysManagement'],
  ] as const) {
    const found = findApiKeysManagement(routes, DENIED, scope);
    expect(found, `「${scope}」的 API 密钥页面没有登记`).toBeDefined();
    expect(found?.route.name).toBe(expected);
    expect(found?.route.auth, `${expected} 必须要求登录`).toBe('required');
    expect(found?.route.path.startsWith('/'), `${expected} 的路径要绝对`).toBe(
      true,
    );
    expect(found?.route.path, `${expected} 的路径不能有动态段`).not.toMatch(
      /[:*?]/u,
    );
    expect(
      found?.route.componentLoader,
      `${expected} 必须有组件加载器`,
    ).toBeTypeOf('function');
  }

  // 通知记录界面的判定条件与模板目录相同：路由名 + 组件加载器 + 绝对路径 +
  // 无动态段；记录页另外要求登录。
  for (const name of ['notificationLogs', 'notificationTemplates']) {
    const found = findCapabilityPage(routes, DENIED, [name]);
    expect(found, `「${name}」没有登记`).toBeDefined();
    expect(found?.route.auth, `${name} 必须要求登录`).toBe('required');
    expect(found?.route.path.startsWith('/'), `${name} 的路径要绝对`).toBe(
      true,
    );
    expect(found?.route.path, `${name} 的路径不能有动态段`).not.toMatch(
      /[:*?]/u,
    );
  }
});
