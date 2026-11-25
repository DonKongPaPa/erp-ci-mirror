import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveAppRuntime } from '@nocobase/app-client/runtime';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import clientPlugins from '../../client/plugins.js';
import appRuntime from '../../client/runtime.js';

const appRoot = path.resolve(import.meta.dirname, '../..');

interface AppPackageJson {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const appPackage = JSON.parse(
  readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
) as AppPackageJson;

const registeredClientPackages = clientPlugins.plugins.map(
  (plugin) => plugin.packageName,
);

describe('client plugin registry consistency', () => {
  it('declares every client plugin as a dependency', () => {
    // 应用自己拥有的扩展（client/extensions/…）不是安装的包，用应用的包名登记，
    // 不需要也不该出现在依赖表里；其余每一项都必须是声明过的依赖。
    const undeclared = registeredClientPackages.filter(
      (packageName) =>
        packageName !== appPackage.name &&
        appPackage.devDependencies?.[packageName] === undefined &&
        appPackage.dependencies?.[packageName] === undefined,
    );

    expect(undeclared).toEqual([]);
  });

  it('registers no package twice', () => {
    expect(new Set(registeredClientPackages).size).toBe(
      registeredClientPackages.length,
    );
  });
});

describe('knowledge client plugin registration', () => {
  it('registers the plugin once with indexing off and its /knowledge page', async () => {
    const registrations = clientPlugins.plugins.filter(
      (plugin) => plugin.packageName === '@nocobase/app-plugin-knowledge',
    );
    expect(registrations, '知识库客户端插件没有登记').toHaveLength(1);
    // 与服务端 createKnowledgePlugin({ indexing: false }) 配套：第一版不加载原生模块，
    // 也不登记索引表单。客户端工厂把索引关掉时服务提供者是空的。
    // 空间与服务端解析器一致（R-002 只认 quality/standards），不是插件默认的 default/''。
    expect(registrations[0]!.options).toEqual({
      indexing: false,
      space: { scope: 'quality', scopeId: 'standards' },
    });
    expect(registrations[0]!.serviceProviders).toHaveLength(0);

    // 页面由客户端工厂自带；「功能与扩展」页上的「知识库界面」就靠这条路由从
    // 「未配置」变「已提供」（R-002 验收第 12 条的前提）。
    const { routes } = await resolveAppRuntime(appRuntime);
    const page = routes.find((route) => route.name === 'knowledge');
    expect(page, '知识库页面路由不在注册树里').toBeDefined();
    expect(page?.path).toBe('/knowledge');
    expect(page?.auth).toBe('required');
    expect(page?.authz).toEqual({
      resource: { type: 'page', id: 'knowledge' },
      action: 'access',
    });
  });

  it('页面第一次请求知识空间时用解析器认的 quality/standards，不用插件默认的 default', async () => {
    const { routes } = await resolveAppRuntime(appRuntime);
    const page = routes.find((route) => route.name === 'knowledge');
    expect(page?.componentLoader, '知识库页面没有组件加载器').toBeDefined();
    const Page = (await page!.componentLoader!()).default;
    const spaceCalls: ApiCall[] = [];
    // 渲染从注册树里取出的真实页面，让页面自己发第一次空间请求；不是查源码或只看 options。
    await renderWithApp(createElement(Page), {
      plugins: [
        clientPlugins.plugins.find(
          (plugin) => plugin.packageName === '@nocobase/app-plugin-knowledge',
        )!,
      ],
      fetch: answerApi((call: ApiCall) => {
        if (call.path === 'knowledge/spaces') {
          spaceCalls.push(call);
          return { data: [] };
        }
        return { data: {} };
      }),
    });

    // 真的等到页面发了第一次空间请求，再断言，避免「请求还没发」的假绿。
    await waitFor(() => expect(spaceCalls.length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    // 行为断言：首请求带的是解析器认的那一对，缺了注册的 space 就会是 default/''（400）。
    expect(spaceCalls[0]!.query).toEqual({
      scope: 'quality',
      scopeId: 'standards',
    });
  });
});
