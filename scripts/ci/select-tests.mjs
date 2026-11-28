#!/usr/bin/env node
// R-084 快速档的选测试器。只产出「跑哪些测试文件」，不跑测试。
//
// 用法：
//   node scripts/ci/select-tests.mjs --root <仓库根> [--base <基准>] [--out <json>]
//   node scripts/ci/select-tests.mjs --root <仓库根> --dry-run <base> <head>
//
// 普通模式：改动集 = git diff --name-only <base>...HEAD + 暂存的 + 未暂存/未跟踪的。
//   base 默认取与 origin/main 的合并基点，取不到就退回 HEAD（提交前后选同一份改动）。
// --dry-run：改动集只取 <base>...<head>，刻意不看工作区，供回放合并提交用。
//
// 先精确后粗：用 vitest 的 related 依赖闭包（本机 4.1.12 没有「related 只列文件」的开关，
// 改走同一份 filterTestsBySource 代码路径的 `vitest list --changed/related --filesOnly --json`）。
// 闭包超过 preciseLimit（默认 40）就回落到 scripts/ci/test-modules.json 的模块映射。
// 映射模式下遇到没有任何规则认得的非文档改动 → GATE_UNMAPPED_CHANGE 并非零退出，不许假绿。

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');

function usage(message) {
  if (message) console.error(`[select-tests] ${message}`);
  console.error(
    '用法：select-tests.mjs --root <仓库根> [--base <基准>] [--out <json>] | --root <仓库根> --dry-run <base> <head>',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, base: null, out: null, dryRun: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--dry-run') options.dryRun = [argv[++i], argv[++i]];
    else if (arg === '-h' || arg === '--help') usage();
    else usage(`未知参数：${arg}`);
  }
  for (const value of [
    options.root,
    options.base,
    options.out,
    ...(options.dryRun ?? []),
  ]) {
    if (value === undefined || value === '') usage('参数缺少取值');
  }
  options.root = path.resolve(options.root);
  return options;
}

function git(root, args, { optional = false } = {}) {
  // 非 ASCII 路径：Git 默认输出成带引号的八进制转义，带引号的名字匹配不上任何规则。
  const result = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(
      `git ${args.join(' ')} 失败：${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function splitLines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        out += `(?:${glob.slice(i + 1, end).split(',').map(escapeRegex).join('|')})`;
        i = end;
        continue;
      }
    }
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`${out}$`, 'u');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/u, '\\$&');
}

function matchesAny(file, patterns) {
  return (patterns ?? []).some((pattern) => globToRegExp(pattern).test(file));
}

function isDoc(file, table) {
  return matchesAny(file, table.docOnlyPatterns);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function listTests(root, table) {
  const files = (table.testRoots ?? []).flatMap((testRoot) =>
    walk(path.join(root, 'app-local', testRoot)),
  );
  return [...new Set(files.map((file) => toPosix(path.relative(path.join(root, 'app-local'), file))))]
    .filter((file) => /\.(?:test|spec)\.(?:ts|tsx)$/u.test(file))
    .sort();
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** 单复数归一：长度大于 3 的词才去词尾 s（orders → order，iqc 仍是 iqc）。 */
function singular(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * 「主干」：文件名去扩展名，再去掉 -resources / -schemas / -provider(s) 后缀；
 * 按 - _ . 拆词，纯数字段（迁移日期）不计，两边都做单复数归一并过停止词。
 */
function stemWords(name, table) {
  const suffixes = table.stemSuffixes ?? ['resources', 'schemas', 'provider', 'providers'];
  // 停止词也要单复数归一：否则 pages → page 会逃过 "pages" 这道停用词。
  const stopwords = new Set(
    (table.stopwords ?? []).map((word) => singular(word.toLowerCase())),
  );
  let stem = name;
  for (const suffix of suffixes) {
    const marker = `-${suffix}`;
    if (stem.endsWith(marker)) {
      stem = stem.slice(0, -marker.length);
      break;
    }
  }
  return [
    ...new Set(
      stem
        .split(/[-_.]/u)
        .filter((word) => word && !/^\d+$/u.test(word) && !suffixes.includes(word))
        .map((word) => singular(word.toLowerCase()))
        .filter((word) => word.length >= 2 && !stopwords.has(word)),
    ),
  ];
}

function stemForFile(file, table) {
  const basename = file.split('/').pop() ?? '';
  return stemWords(basename.replace(/\.[^.]+$/u, ''), table);
}

function stemForArea(file, table) {
  const marker = '/client/';
  const index = file.indexOf(marker);
  const rest = index < 0 ? '' : file.slice(index + marker.length);
  const [first = ''] = rest.split('/');
  const area = first.replace(/\.[^.]+$/u, '');
  return area && area !== 'client' ? stemWords(area, table) : [];
}

/**
 * 一个测试被选中，当且仅当它的「文件名」（目录不参与）以整词形式含有主干的全部词。
 */
function matchesStem(stem, test, table) {
  if (stem.length === 0) return false;
  const basename = test.split('/').pop() ?? '';
  const name = basename
    .replace(/\.(?:test|spec)\.[^.]+$/u, '')
    .replace(/\.[^.]+$/u, '');
  const words = new Set(stemWords(name, table));
  return stem.every((word) => words.has(word));
}

/**
 * 精确集合：把改动文件作为 vitest 的 related 源，列出依赖闭包命中的测试文件。
 * 这里只产出文件清单，不执行任何测试用例。
 */
function preciseTests(root, changed) {
  const app = path.join(root, 'app-local');
  const configName = [
    'vitest.config.mts',
    'vitest.config.ts',
    'vitest.config.mjs',
    'vitest.config.js',
  ].find((name) => existsSync(path.join(app, name)));
  if (!configName) {
    throw new Error('app-local 下找不到 vitest.config，无法取精确测试集合');
  }
  if (!existsSync(path.join(app, 'node_modules', 'vitest', 'vitest.mjs'))) {
    throw new Error('app-local/node_modules/vitest 不存在，先装依赖');
  }

  const temp = mkdtempSync(path.join(tmpdir(), 'r084-select-'));
  try {
    const configFile = path.join(temp, 'related.config.mjs');
    const related = changed.map((file) => path.resolve(root, file));
    // 用普通绝对路径 import（不是 file:// URL），Vite 才会把真仓库配置当本地配置打包。
    const basePath = path.join(app, configName);
    writeFileSync(
      configFile,
      [
        `import base from ${JSON.stringify(basePath)};`,
        `const related = ${JSON.stringify(related)};`,
        `export default { ...base, test: { ...base.test, root: ${JSON.stringify(app)}, related, changed: false } };`,
        '',
      ].join('\n'),
    );
    // 直接跑 vitest.mjs，不经 pnpm exec：临时夹具仓库没有 lockfile，pnpm exec 会试图安装。
    // 临时配置必须用普通绝对路径 import 真仓库配置（file:// URL 会让 Vite 当成外部模块，
    // 里面对 tests/setup/test-db-env 的相对 import 解析失败）。
    const result = spawnSync(
      process.execPath,
      [path.join(app, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--config', configFile, '--filesOnly', '--json'],
      { cwd: app, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `vitest list 取依赖集合失败（exit ${result.status}）：${`${result.stderr || ''}${result.stdout || ''}`.trim()}`,
      );
    }
    const files = JSON.parse(result.stdout ?? '[]');
    if (!Array.isArray(files)) throw new Error('vitest list 的输出不是数组');
    return files.map((entry) => toPosix(path.relative(app, entry.file)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** 模块映射：规则按 JSON 里的顺序取第一条命中的（共享登记文件只跑固定清单组）。 */
function mappedTests(root, changed, table, allTests) {
  const tests = new Set();
  const unmapped = [];
  const sources = {};
  const contributions = [];
  const add = (test, file, ruleId, kind) => {
    if (!allTests.includes(test)) return;
    tests.add(test);
    (sources[test] ??= []).push(`${kind}:${ruleId}`);
    let contribution = contributions.find(
      (item) => item.file === file && item.rule === ruleId && item.kind === kind,
    );
    if (!contribution) {
      contribution = { file, rule: ruleId, kind, tests: [] };
      contributions.push(contribution);
    }
    if (!contribution.tests.includes(test)) contribution.tests.push(test);
  };
  const addFixed = (file, rule) => {
    for (const test of table.fixedGroups?.[rule.group] ?? []) {
      add(test, file, rule.id, 'fixed');
    }
  };
  const addDerived = (file, rule, stem) => {
    const roots = (rule.searchRoots ?? []).map((item) => `${item}/`);
    for (const test of allTests) {
      if (roots.length && !roots.some((item) => test.startsWith(item))) continue;
      if (matchesStem(stem, test, table)) add(test, file, rule.id, 'name');
    }
  };

  for (const file of changed) {
    if (isDoc(file, table)) continue;
    const relative = file.startsWith('app-local/') ? file.slice('app-local/'.length) : file;
    const rule = (table.rules ?? []).find((item) => matchesAny(file, item.paths));
    if (!rule) {
      unmapped.push(file);
      continue;
    }
    if (rule.group) addFixed(file, rule);
    if (rule.derive === 'testFile' && /\.(?:test|spec)\.(?:ts|tsx)$/u.test(relative)) {
      add(relative, file, rule.id, 'testFile');
    }
    if (rule.derive === 'moduleTokens' || rule.derive === 'testFile') {
      addDerived(file, rule, stemForFile(file, table));
    }
    if (rule.derive === 'areaToken') addDerived(file, rule, stemForArea(file, table));
  }
  return {
    tests: [...tests].sort(),
    unmapped: [...new Set(unmapped)].sort(),
    sources,
    contributions,
  };
}

function lintFiles(root, changed) {
  return changed
    .filter((file) => file.startsWith('app-local/'))
    .map((file) => file.slice('app-local/'.length))
    .filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file))
    .filter((file) => existsSync(path.join(root, 'app-local', file)))
    .sort();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  // 映射表从给定仓库根读：临时仓库夹具必须能自带规则，不能误用脚本所在真仓库的表。
  const tableFile = path.join(options.root, 'scripts', 'ci', 'test-modules.json');
  const table = JSON.parse(readFileSync(tableFile, 'utf8'));
  const dry = Boolean(options.dryRun);
  const [dryBase, dryHead] = options.dryRun ?? [];

  let baseRef = options.base;
  let headRef = 'HEAD';
  if (dry) {
    [baseRef, headRef] = [dryBase, dryHead];
  } else if (!baseRef) {
    baseRef =
      git(options.root, ['merge-base', 'HEAD', 'origin/main'], { optional: true }) ??
      git(options.root, ['rev-parse', 'HEAD']);
  }

  const committed = git(options.root, [
    'diff',
    '--name-only',
    `${baseRef}...${headRef}`,
  ]);
  const local = dry
    ? ''
    : [
        git(options.root, ['diff', '--cached', '--name-only']),
        git(options.root, ['ls-files', '--other', '--modified', '--exclude-standard']),
      ].join('\n');
  const changed = [...new Set([...splitLines(committed), ...splitLines(local)])].sort();

  const docOnly = changed.length > 0 && changed.every((file) => isDoc(file, table));
  const allTests = listTests(options.root, table);
  let mode;
  let reason;
  let tests;
  let sources = {};
  let contributions = [];
  if (docOnly) {
    mode = 'doc-only';
    reason = `全部 ${changed.length} 个改动文件都是文档，只跑文档守门`;
    tests = [];
  } else {
    const precise = preciseTests(options.root, changed);
    const limit = table.preciseLimit ?? 40;
    if (precise.length === 0) {
      const mapped = mappedTests(options.root, changed, table, allTests);
      if (mapped.unmapped.length > 0) {
        for (const file of mapped.unmapped) {
          console.error(`[select-tests] GATE_UNMAPPED_CHANGE: ${file}`);
        }
        console.error('[select-tests] 没有规则认得这些非文档改动，先登记模块映射再跑快速档。');
        process.exit(1);
      }
      mode = 'mapping';
      reason = `依赖集合为空，已回落到模块映射（${changed.length} 个改动文件）`;
      tests = mapped.tests;
      sources = mapped.sources;
      contributions = mapped.contributions;
    } else if (precise.length > limit) {
      const mapped = mappedTests(options.root, changed, table, allTests);
      if (mapped.unmapped.length > 0) {
        for (const file of mapped.unmapped) {
          console.error(`[select-tests] GATE_UNMAPPED_CHANGE: ${file}`);
        }
        console.error('[select-tests] 没有规则认得这些非文档改动，先登记模块映射再跑快速档。');
        process.exit(1);
      }
      mode = 'mapping';
      reason = `依赖集合过大，已回落到模块映射（${precise.length} 个测试文件 > 上限 ${limit}）`;
      tests = mapped.tests;
      sources = mapped.sources;
      contributions = mapped.contributions;
    } else {
      mode = 'precise';
      reason = `依赖闭包 ${precise.length} 个测试文件，未超过上限 ${limit}`;
      tests = precise.sort();
      for (const test of tests) sources[test] = ['precise'];
    }
  }

  const selection = {
    mode,
    reason,
    base: baseRef,
    head: headRef,
    changed,
    tests,
    count: tests.length,
    lintFiles: lintFiles(options.root, changed),
    sources,
    contributions,
  };
  if (options.out) {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(selection, null, 2)}\n`);
  }
  console.log(
    `[select-tests] 改动集：${dry ? `${baseRef}...${headRef}` : `${baseRef}...HEAD + 未提交改动`}，${changed.length} 个文件`,
  );
  console.log(`[select-tests] MODE=${mode}`);
  console.log(`[select-tests] REASON=${reason}`);
  console.log(`[select-tests] COUNT=${tests.length}`);
  for (const test of tests) console.log(`  ${test}`);
}

try {
  main();
} catch (error) {
  console.error(`[select-tests] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
