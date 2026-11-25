import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 样式守门的测试（R-039 第一道门）。
 *
 * 界面规范的四类写法在这里变成机器检查：写死的颜色、任意值、`space-y-*` / `space-x-*`、
 * 不是从 `lucide-react` 引的图标。范围是应用自己的客户端文件 —— `client/` 下除了
 * `client/components/ui/`。那是 shadcn 的 primitive，按 CLI 生成的样子原样保留，是例外。
 *
 * 为什么是测试而不是 ESLint 规则：这四类在本机没有现成的插件，自己写规则要动框架的
 * lint 配置；守门测试有先例、不加依赖、跑在快信道（设计文档「理由」一节）。
 *
 * 已有的违例列在 `frontend-style-allowlist.json` 里，每条带理由、带数量：数量对不上
 * 也要红，免得豁免悄悄留着、或者悄悄扩大。
 */

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const clientRoot = path.join(appRoot, 'client');
const primitiveDirectory = path.join(clientRoot, 'components', 'ui');
const allowlistFile = path.join(
  import.meta.dirname,
  'frontend-style-allowlist.json',
);

type Rule = 'color' | 'arbitrary-value' | 'space' | 'icon';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
  readonly token: string;
}

interface AllowlistEntry {
  readonly file: string;
  readonly rule: Rule;
  readonly reason: string;
  /** 这条豁免覆盖的写法与处数：数量对不上时测试变红。 */
  readonly tokens: Readonly<Record<string, number>>;
}

/**
 * 注释换成空格，换行保留 —— 注释里提到 `bg-white` 是说明，不是用法。
 * 字符串里的写法要保留：类名全在字符串里。
 */
export function maskComments(source: string): string {
  const out = [...source];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
    } else if (char === '/' && next === '*') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      if (index < source.length) {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 2;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      // Skip the literal's body, so a `//` inside a URL or a class is not a comment.
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      index += 1;
    } else {
      index += 1;
    }
  }
  return out.join('');
}

const paletteNames = [
  'white',
  'black',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

/** `bg-white`、`text-gray-900`、`dark:bg-slate-800/50`：调色板色名都是写死的颜色。 */
const paletteColor = new RegExp(
  `(?:[\\w-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|shadow|decoration|accent|caret|placeholder)-(?:${paletteNames.join('|')})(?:-\\d{2,3})?(?:/\\d+)?\\b`,
  'gu',
);
/** `#fff`、`#1a2b3c`：十六进制色值。`#components/...` 不是色值，色值至少三位十六进制。 */
const hexColor =
  /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/gu;
/** `rgb(…)`、`hsl(…)`、`oklch(…)` 这些函数式颜色。 */
const functionColor =
  /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(\s*[0-9.]/gu;
/**
 * 一个任意值：`text-[13px]`、`mt-[7px]`。
 *
 * 引用令牌的写法不算 —— `max-w-[min(var(--container-sm),var(--available-width))]`、
 * `-mx-[calc(--spacing(3)+1px)]` 这类是框架文档自己示范的写法，写死的只是一个修正量。
 * 跟在 `]` 后面的 `:`（含 `@min-[26rem]/permissions:` 这种命名容器查询）是变体，不是值。
 */
const arbitraryValue = /[A-Za-z][\w:/-]*-\[[^\]\n]+\]/gu;
/** 值里出现带单位的数字，才算写死了字号、间距、尺寸或视口限制。 */
const literalLength =
  /\d+(?:\.\d+)?(?:px|rem|em|%|vh|dvh|svh|lh|vmin|vmax)(?![a-z])/u;
/** `space-y-4` 这类工具的写法本身，不把引号、反引号带进报告。 */
const spaceUtility = /\bspace-[xy]-[^\s'"`]+/gu;

function applicationClientFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      if (entryPath === primitiveDirectory) continue;
      if (statSync(entryPath).isDirectory()) visit(entryPath);
      else if (/\.tsx?$/u.test(entry)) files.push(entryPath);
    }
  };
  visit(clientRoot);
  return files;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** 扫一份源码文本，报出四类写法。`file` 只用于报告。 */
export function scanSource(source: string, file: string): Finding[] {
  const masked = maskComments(source);
  const findings: Finding[] = [];
  const collect = (rule: Rule, pattern: RegExp): void => {
    for (const match of masked.matchAll(pattern)) {
      findings.push({
        file,
        line: lineAt(masked, match.index ?? 0),
        rule,
        token: match[0],
      });
    }
  };
  collect('color', paletteColor);
  collect('color', hexColor);
  collect('color', functionColor);
  collect('space', spaceUtility);
  for (const match of masked.matchAll(arbitraryValue)) {
    const token = match[0];
    const end = (match.index ?? 0) + token.length;
    // 变体：`data-[state=open]:`、`group-data-[size=sm]:`、`@min-[26rem]/permissions:`。
    if (/^(?:\/[\w-]+)?:/u.test(masked.slice(end))) continue;
    const value = token.slice(token.indexOf('[') + 1, -1);
    // 引用令牌的任意值不是写死的值。
    if (value.includes('var(') || /--[a-z][\w-]*\(/iu.test(value)) continue;
    if (!literalLength.test(value)) continue;
    findings.push({
      file,
      line: lineAt(masked, match.index ?? 0),
      rule: 'arbitrary-value',
      token,
    });
  }
  const imported =
    /import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of masked.matchAll(imported)) {
    const module = match[3];
    if (module === 'lucide-react' || module.startsWith('.')) continue;
    const names = [
      ...(match[1] ? [match[1]] : []),
      ...(match[2] ?? '')
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/u)[0])
        .filter(Boolean),
    ];
    for (const name of names) {
      if (!/Icon$/u.test(name)) continue;
      findings.push({
        file,
        line: lineAt(masked, match.index ?? 0),
        rule: 'icon',
        token: `${name} from '${module}'`,
      });
    }
  }
  return findings;
}

function scanApplication(): Finding[] {
  return applicationClientFiles().flatMap((file) =>
    scanSource(
      readFileSync(file, 'utf8'),
      path.relative(appRoot, file).split(path.sep).join('/'),
    ),
  );
}

const allowlist = JSON.parse(
  readFileSync(allowlistFile, 'utf8'),
) as AllowlistEntry[];

/** 每条豁免按「文件 + 写法」核销一次，剩余的数量必须刚好被允许。 */
function unallowed(findings: readonly Finding[]): Finding[] {
  const budget = new Map<string, number>();
  for (const entry of allowlist)
    for (const [token, count] of Object.entries(entry.tokens))
      budget.set(`${entry.rule}\u0000${entry.file}\u0000${token}`, count);
  return findings.filter((finding) => {
    const key = `${finding.rule}\u0000${finding.file}\u0000${finding.token}`;
    const left = budget.get(key) ?? 0;
    if (left <= 0) return true;
    budget.set(key, left - 1);
    return false;
  });
}

const describeFinding = (finding: Finding): string =>
  `${finding.file}:${finding.line} ${finding.token}`;

const findings = scanApplication();

describe('frontend style guard', () => {
  it('scans the application-owned client files, not the shadcn primitives', () => {
    // Guards the scan itself: a path or extension mistake would turn the four checks below into no-ops.
    expect(applicationClientFiles().length).toBeGreaterThan(50);
    expect(
      findings.some(
        (finding) => finding.file === 'client/components/ui/button.tsx',
      ),
      'client/components/ui/ 是 shadcn primitive，不在守门范围内',
    ).toBe(false);
  });

  it('uses only semantic colour tokens', () => {
    const colors = findings.filter((finding) => finding.rule === 'color');
    expect(unallowed(colors).map(describeFinding)).toEqual([]);
  });

  it('keeps arbitrary values to token references, never literal sizes', () => {
    const arbitrary = findings.filter(
      (finding) => finding.rule === 'arbitrary-value',
    );
    expect(unallowed(arbitrary).map(describeFinding)).toEqual([]);
  });

  it('spaces siblings with gap, never space-y-* or space-x-*', () => {
    const spacing = findings.filter((finding) => finding.rule === 'space');
    expect(unallowed(spacing).map(describeFinding)).toEqual([]);
  });

  it('takes icons from lucide-react', () => {
    const icons = findings.filter((finding) => finding.rule === 'icon');
    expect(unallowed(icons).map(describeFinding)).toEqual([]);
  });

  it('explains every allowlisted exception and keeps its count honest', () => {
    for (const entry of allowlist)
      expect(
        entry.reason.trim().length,
        `允许清单条目缺少理由：${entry.file}`,
      ).toBeGreaterThan(0);
    const observed = new Map<string, number>();
    for (const finding of findings)
      observed.set(
        `${finding.rule}\u0000${finding.file}\u0000${finding.token}`,
        (observed.get(
          `${finding.rule}\u0000${finding.file}\u0000${finding.token}`,
        ) ?? 0) + 1,
      );
    for (const entry of allowlist)
      for (const [token, count] of Object.entries(entry.tokens)) {
        const key = `${entry.rule}\u0000${entry.file}\u0000${token}`;
        expect(
          observed.get(key) ?? 0,
          `允许清单过期：${entry.file} ${token} 允许 ${count} 处，实际只剩 ${observed.get(key) ?? 0} 处`,
        ).toBeGreaterThanOrEqual(count);
      }
  });

  it('reports a hardcoded colour with its file and line', () => {
    // The mutation self-check of the design, kept as a test: one added `bg-white` must be a
    // finding naming the file and the line, not a silent pass.
    const directory = mkdtempSync(path.join(tmpdir(), 'nb3-style-guard-'));
    try {
      mkdirSync(path.join(directory, 'client'), { recursive: true });
      writeFileSync(
        path.join(directory, 'client', 'demo.tsx'),
        [
          'export function Demo() {',
          "  return <div className='bg-white' />;",
          '}',
        ].join('\n'),
      );
      const file = path.join(directory, 'client', 'demo.tsx');
      expect(
        scanSource(readFileSync(file, 'utf8'), 'client/demo.tsx').map(
          describeFinding,
        ),
      ).toContain('client/demo.tsx:2 bg-white');
      // A comment explaining the rule is not the rule being broken.
      writeFileSync(
        file,
        ['// Never write bg-white.', "const name = 'card';"].join('\n'),
      );
      expect(scanSource(readFileSync(file, 'utf8'), 'client/demo.tsx')).toEqual(
        [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
