import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { resolveStandaloneAppRuntime } from '@nocobase/app-server/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTrustedOrigins } from '../../server/config/trusted-origins.js';
import appRuntime from '../../server/runtime.ts';

const templateRootDir = fileURLToPath(new URL('../..', import.meta.url));

/** A complete origin is `scheme://host[:port]` — no path, query, fragment, credentials or wildcard. */
describe('parseTrustedOrigins', () => {
  it('treats an unset, empty or blank-only value as no extra trusted origins', () => {
    expect(parseTrustedOrigins('')).toEqual([]);
    expect(parseTrustedOrigins('   ')).toEqual([]);
    expect(parseTrustedOrigins(' , , ')).toEqual([]);
  });

  it('accepts a single complete origin', () => {
    expect(parseTrustedOrigins('https://a.example:13000')).toEqual([
      'https://a.example:13000',
    ]);
  });

  it('accepts several complete origins in order', () => {
    expect(
      parseTrustedOrigins('https://a.example:13000,http://b.example:13100'),
    ).toEqual(['https://a.example:13000', 'http://b.example:13100']);
  });

  it('trims surrounding whitespace and ignores empty items', () => {
    expect(
      parseTrustedOrigins(
        '  https://a.example:13000 , , \t http://b.example:13100  , ',
      ),
    ).toEqual(['https://a.example:13000', 'http://b.example:13100']);
  });

  it('keeps http and https of the same host and port as two distinct origins', () => {
    const parsed = parseTrustedOrigins(
      'https://a.example:13000,http://a.example:13000',
    );
    expect(parsed).toHaveLength(2);
    expect(new Set(parsed).size).toBe(2);
    expect(parsed).toContain('https://a.example:13000');
    expect(parsed).toContain('http://a.example:13000');
  });

  it.each([
    ['no scheme', 'a.example:13000'],
    ['a path', 'https://a.example:13000/path'],
    ['a trailing slash', 'https://a.example:13000/'],
    ['a query', 'https://a.example:13000?x=1'],
    ['a fragment', 'https://a.example:13000#frag'],
    ['credentials', 'https://user:pw@a.example:13000'],
    ['a wildcard', 'https://*.example:13000'],
    ['a non-http scheme', 'ftp://a.example:13000'],
    ['an upper-case scheme', 'HTTPS://a.example:13000'],
  ])('rejects an entry with %s and names it in the error', (_label, item) => {
    expect(() => parseTrustedOrigins(`https://ok.example:13000,${item}`)).toThrow(
      item,
    );
    expect(() => parseTrustedOrigins(item)).toThrow(/scheme:\/\/host\[:port\]/u);
  });
});

describe('APP_TRUSTED_ORIGINS configuration mapping', () => {
  let configRoot: string;
  let configPath: string;
  beforeAll(async () => {
    configRoot = await mkdtemp(path.join(os.tmpdir(), 'trusted-origins-config-'));
    configPath = path.join(configRoot, 'config.yml');
    await writeFile(configPath, '{}');
  });
  afterAll(async () => {
    await rm(configRoot, { recursive: true, force: true });
  });

  const resolve = async (env: Record<string, string>) =>
    resolveStandaloneAppRuntime(appRuntime, {
      rootDir: templateRootDir,
      configPath,
      env: { AUTH_SECRET: 'test-auth-secret-at-least-32-characters', ...env },
    });

  it('adds nothing to auth.trustedOrigins when the variable is absent', async () => {
    const runtime = await resolve({});
    expect(runtime.config.get('auth.trustedOrigins')).toBeUndefined();
  });

  it('maps the parsed origins onto auth.trustedOrigins', async () => {
    const runtime = await resolve({
      APP_TRUSTED_ORIGINS: ' https://a.example:13000 , , http://b.example:13100 ',
    });
    expect(runtime.config.get('auth.trustedOrigins')).toEqual([
      'https://a.example:13000',
      'http://b.example:13100',
    ]);
  });

  it('refuses to start with an invalid entry', async () => {
    await expect(
      resolve({ APP_TRUSTED_ORIGINS: 'a.example:13000' }),
    ).rejects.toThrow('a.example:13000');
  });
});
