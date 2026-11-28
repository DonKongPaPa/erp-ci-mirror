#!/usr/bin/env node
/**
 * 前端版式守门：清单 `app-local/.agents/rules/frontend.md` 里两条能稳定静态检查的规则。
 *
 * 1. fixed-px-width：业务页面源码不写死像素宽度（清单 19；F7 的固定值须记理由，不是随手写 240px）。
 * 2. sheet-padding：SheetContent 承载的正文必须有留白与自己的滚动区（清单 27；
 *    SheetContent 自身没有 padding，侧栏这类 data-sidebar/p-0 的全高导航面板是例外）。
 *
 * 不扫 `client/components/ui/`（shadcn primitive，生成物按 CLI 原样保留）、测试与 fixture。
 * 退出码：0 = 无未豁免命中；1 = 有命中或 allowlist 数目对不上；2 = 参数/路径/扫描不完整。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const proc = globalThis.process;

function usage(message) {
  proc.stderr.write(`frontend-layout-check: ${message}\n`);
  proc.stderr.write(
    '用法: node frontend-layout-check.mjs [--root <app-local>] [--allowlist <json>] [文件...]\n',
  );
  proc.exit(2);
}

function parseArgs(argv) {
  let root = path.resolve(HERE, '../..');
  let allowlist = path.join(HERE, 'frontend-layout-allowlist.json');
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' || argv[i] === '--allowlist') {
      const value = argv[++i];
      if (!value) usage(`${argv[i - 1]} 缺参数`);
      if (argv[i - 1] === '--root') root = path.resolve(value);
      else allowlist = path.resolve(value);
    } else if (argv[i].startsWith('--')) usage(`不认识的参数 ${argv[i]}`);
    else files.push(path.resolve(root, argv[i]));
  }
  if (!existsSync(root)) usage(`根目录不存在：${root}`);
  return { root, allowlist, files };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.vite', 'test-results', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 把块注释与行注释换成空格（换行保留），字符串原样留下：类名都写在字符串里。 */
function maskComments(source) {
  const out = [...source];
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < source.length) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

const PX_WIDTH = /\b(?:w|min-w|max-w)-\[\s*\d+(?:\.\d+)?px\s*\]|\bwidth:\s*['"]\d+(?:\.\d+)?px['"]/gu;
const SHEET_OPEN = /<SheetContent\b/gu;
const SHEET_CLOSE = '</SheetContent>';

function isBusinessPage(relative) {
  return relative.startsWith('client/pages/') || relative.startsWith('client/extensions/');
}

function isSkipped(relative) {
  return (
    relative.startsWith('client/components/ui/') ||
    /(^|\/)(__tests__|__fixtures__|fixtures)\//.test(relative) ||
    /\.(test|spec|stories)\.[jt]sx?$/.test(relative)
  );
}

function fixedWidthFindings(relative, masked) {
  if (!isBusinessPage(relative)) return [];
  const findings = [];
  masked.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PX_WIDTH)) {
      findings.push({ rule: 'fixed-px-width', line: index + 1, token: match[0] });
    }
  });
  return findings;
}

function sheetFindings(relative, masked) {
  const findings = [];
  for (const match of masked.matchAll(SHEET_OPEN)) {
    const tagEnd = masked.indexOf('>', match.index);
    if (tagEnd === -1) return { error: `${relative}: SheetContent 开始标签没有结束` };
    const opening = masked.slice(match.index, tagEnd);
    // 全高导航面板：p-0 是设计，不是漏写留白。
    if (/\bdata-sidebar\b|\bp-0\b/.test(opening)) continue;
    const close = masked.indexOf(SHEET_CLOSE, tagEnd);
    if (close === -1) return { error: `${relative}: SheetContent 没有闭合` };
    const body = masked.slice(tagEnd, close);
    if (!/\b(?:px-[46]|p-[46])\b/.test(body) || !/\boverflow-y-auto\b/.test(body)) {
      findings.push({
        rule: 'sheet-padding',
        line: masked.slice(0, match.index).split('\n').length,
        token: 'SheetContent 正文缺 px-4/px-6 或 overflow-y-auto',
      });
    }
  }
  return { findings };
}

const { root, allowlist, files } = parseArgs(proc.argv.slice(2));
const targets = files.length ? files : walk(path.join(root, 'client'));
if (files.length === 0) {
  for (const dir of ['client/pages', 'client/extensions']) {
    if (!existsSync(path.join(root, dir))) usage(`缺目录：${dir}`);
  }
}

let allowEntries = [];
if (existsSync(allowlist)) {
  try {
    allowEntries = JSON.parse(readFileSync(allowlist, 'utf8'));
  } catch (error) {
    usage(`allowlist 不是合法 JSON：${error.message}`);
  }
  if (!Array.isArray(allowEntries)) usage('allowlist 必须是数组');
} else if (!files.length) {
  usage(`缺 allowlist：${allowlist}`);
}

const findings = [];
for (const file of targets) {
  if (!isFile(file)) usage(`不是文件：${file}`);
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  if (relative.startsWith('..') || isSkipped(relative)) continue;
  const source = readFileSync(file, 'utf8');
  const masked = maskComments(source);
  findings.push(...fixedWidthFindings(relative, masked).map((f) => ({ ...f, file: relative })));
  const sheet = sheetFindings(relative, masked);
  if (sheet.error) usage(sheet.error);
  findings.push(...(sheet.findings ?? []).map((f) => ({ ...f, file: relative })));
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

const scanned = new Set(targets.map((f) => path.relative(root, f).replaceAll(path.sep, '/')));
const problems = [];
const unhandled = [];
for (const finding of findings) {
  const indices = [];
  allowEntries.forEach((entry, index) => {
    if (
      entry?.file === finding.file &&
      entry?.rule === finding.rule &&
      typeof entry?.reason === 'string' &&
      entry.reason.trim().length > 0
    ) indices.push(index);
  });
  if (indices.length) continue; // 具体的数目校验在下面做，避免豁免悄悄扩大
  unhandled.push(finding);
}
for (const entry of allowEntries) {
  if (!scanned.has(entry?.file)) continue;
  if (!entry?.reason?.trim()) problems.push(`allowlist 条目缺理由：${entry?.file} / ${entry?.rule}`);
  const expected = entry?.count;
  const actual = findings.filter(
    (f) => f.file === entry?.file && f.rule === entry?.rule,
  ).length;
  if (!Number.isInteger(expected) || expected !== actual) {
    problems.push(
      `allowlist 数目对不上：${entry?.file} / ${entry?.rule} 期望 ${expected}，实际 ${actual}`,
    );
  }
}

for (const finding of [...unhandled, ...problems.map((text) => ({ text }))]) {
  if (finding.text) proc.stdout.write(`${finding.text}\n`);
  else
    proc.stdout.write(
      `${finding.file}:${finding.line} ${finding.rule} ${finding.token}\n`,
    );
}
if (unhandled.length || problems.length) {
  proc.stdout.write(
    `前端版式检查未通过：${unhandled.length} 个未豁免命中，${problems.length} 个 allowlist 问题\n`,
  );
  proc.exit(1);
}
proc.stdout.write(
  `前端版式检查通过：扫描 ${targets.length} 个文件，0 个未豁免命中\n`,
);
