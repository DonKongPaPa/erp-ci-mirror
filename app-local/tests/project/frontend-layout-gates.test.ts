import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 版式守门本身与它的变异自检：版式守门本身与它的变异自检。
 *
 * 规则实现在 `frontend-layout-check.mjs`（脚本不依赖项目依赖，不装包、不写源文件）。
 * 这里守两件事：当前主线全量扫描必须零未豁免命中；每条规则临时造一处违规必须红，改对必须绿。
 */

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const checker = path.join(import.meta.dirname, 'frontend-layout-check.mjs');

function run(root: string, args: readonly string[] = []) {
  const result = spawnSync(process.execPath, [checker, '--root', root, ...args], {
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

function tempApp(sourceFile: string, source: string, allowlist?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hs-layout-gate-'));
  mkdirSync(path.dirname(path.join(root, sourceFile)), { recursive: true });
  writeFileSync(path.join(root, sourceFile), source);
  if (allowlist !== undefined) writeFileSync(path.join(root, 'allowlist.json'), allowlist);
  return root;
}

describe('frontend layout gates', () => {
  it('passes with zero unexplained findings on the whole client tree', () => {
    const result = run(appRoot);
    expect(result.status).toBe(0);
    expect(result.output).toContain('0 个未豁免命中');
  });

  it('goes red on a hard-coded pixel width and green when it is removed', () => {
    const root = tempApp(
      'client/pages/probe.tsx',
      "export const Probe = () => <div className='w-[240px]' />;\n",
    );
    try {
      const red = run(root, ['--allowlist', path.join(root, 'empty.json'), 'client/pages/probe.tsx']);
      expect(red.status).toBe(1);
      expect(red.output).toContain('fixed-px-width');
      expect(red.output).toContain('probe.tsx:1');

      writeFileSync(
        path.join(root, 'client/pages/probe.tsx'),
        "export const Probe = () => <div className='w-full max-w-2xl' />;\n",
      );
      const green = run(root, ['--allowlist', path.join(root, 'empty.json'), 'client/pages/probe.tsx']);
      expect(green.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('goes red on an unpadded SheetContent body and green with the framework body', () => {
    const root = tempApp(
      'client/extensions/probe.tsx',
      'export const Probe = () => (\n  <SheetContent>\n    <div>正文</div>\n  </SheetContent>\n);\n',
    );
    try {
      const red = run(root, ['--allowlist', path.join(root, 'empty.json'), 'client/extensions/probe.tsx']);
      expect(red.status).toBe(1);
      expect(red.output).toContain('sheet-padding');

      writeFileSync(
        path.join(root, 'client/extensions/probe.tsx'),
        "export const Probe = () => (\n  <SheetContent>\n    <div className='min-h-0 flex-1 overflow-y-auto px-4'>正文</div>\n  </SheetContent>\n);\n",
      );
      const green = run(root, ['--allowlist', path.join(root, 'empty.json'), 'client/extensions/probe.tsx']);
      expect(green.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the nav-panel exception and requires an exact allowlist count', () => {
    const root = tempApp(
      'client/extensions/probe.tsx',
      "export const Probe = () => (\n  <SheetContent data-sidebar='sidebar' className='p-0'>正文</SheetContent>\n);\n",
    );
    try {
      writeFileSync(path.join(root, 'empty.json'), '[]\n');
      const nav = run(root, ['--allowlist', path.join(root, 'empty.json'), 'client/extensions/probe.tsx']);
      expect(nav.status).toBe(0);

      writeFileSync(
        path.join(root, 'client/extensions/probe.tsx'),
        'export const Probe = () => (\n  <SheetContent>\n    <div>正文</div>\n  </SheetContent>\n);\n',
      );
      writeFileSync(
        path.join(root, 'allowlist.json'),
        JSON.stringify([
          {
            file: 'client/extensions/probe.tsx',
            rule: 'sheet-padding',
            reason: '测试用豁免',
            count: 1,
          },
        ]),
      );
      const allowed = run(root, ['--allowlist', path.join(root, 'allowlist.json'), 'client/extensions/probe.tsx']);
      expect(allowed.status).toBe(0);

      writeFileSync(
        path.join(root, 'allowlist.json'),
        JSON.stringify([
          {
            file: 'client/extensions/probe.tsx',
            rule: 'sheet-padding',
            reason: '测试用豁免',
            count: 2,
          },
        ]),
      );
      const stale = run(root, ['--allowlist', path.join(root, 'allowlist.json'), 'client/extensions/probe.tsx']);
      expect(stale.status).toBe(1);
      expect(stale.output).toContain('allowlist 数目对不上');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly instead of passing when the scan cannot complete', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hs-layout-gate-incomplete-'));
    try {
      mkdirSync(path.join(root, 'client'));
      const result = run(root);
      expect(result.status).toBe(2);
      expect(result.output).toContain('缺目录');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
