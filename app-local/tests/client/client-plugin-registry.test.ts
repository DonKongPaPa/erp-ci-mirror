import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import clientPlugins from '../../client/plugins.js';

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
