/**
 * loadConfig() 的凭据解析（ADR-022）
 *
 * 密钥优先走环境变量，配置文件里的值降级为回退：
 *   ZELTO_LLM_API_KEY > DEEPSEEK_API_KEY > llm.apiKey（配置文件）
 *
 * 这些是集成判定 —— 走真实的 loadConfig()，真实的 .zelto/config.yaml。
 * 环境变量在这里必须真的改 process.env（loadConfig 读的就是它），
 * 所以每个用例结束后都要还原，不能污染其它测试。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/cli/commands/shared.js';

describe('loadConfig — credential resolution (ADR-022)', () => {
  const originalCwd = process.cwd();
  const originalZelto = process.env.ZELTO_LLM_API_KEY;
  const originalDeepseek = process.env.DEEPSEEK_API_KEY;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-cred-'));
    process.chdir(dir);
    delete process.env.ZELTO_LLM_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    if (originalZelto === undefined) delete process.env.ZELTO_LLM_API_KEY;
    else process.env.ZELTO_LLM_API_KEY = originalZelto;
    if (originalDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepseek;
  });

  /** 写一份 .zelto/config.yaml */
  function writeConfig(content: string): void {
    mkdirSync(join(dir, '.zelto'), { recursive: true });
    writeFileSync(join(dir, '.zelto', 'config.yaml'), content, 'utf-8');
  }

  it('reads the key from the config file when no env var is set', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  apiKey: "sk-from-config"
`);
    const cfg = loadConfig();
    assert.equal(cfg.llm?.apiKey, 'sk-from-config');
  });

  it('lets ZELTO_LLM_API_KEY override the config file', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  apiKey: "sk-from-config"
`);
    process.env.ZELTO_LLM_API_KEY = 'sk-from-env';
    const cfg = loadConfig();
    assert.equal(cfg.llm?.apiKey, 'sk-from-env');
  });

  it('lets DEEPSEEK_API_KEY override the config file', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  apiKey: "sk-from-config"
`);
    process.env.DEEPSEEK_API_KEY = 'sk-from-deepseek-env';
    const cfg = loadConfig();
    assert.equal(cfg.llm?.apiKey, 'sk-from-deepseek-env');
  });

  it('prefers ZELTO_LLM_API_KEY over DEEPSEEK_API_KEY', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  apiKey: "sk-from-config"
`);
    process.env.ZELTO_LLM_API_KEY = 'sk-from-zelto-env';
    process.env.DEEPSEEK_API_KEY = 'sk-from-deepseek-env';
    const cfg = loadConfig();
    assert.equal(cfg.llm?.apiKey, 'sk-from-zelto-env');
  });

  it('uses the env key when the config file has no llm section at all', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
`);
    process.env.ZELTO_LLM_API_KEY = 'sk-from-env';
    const cfg = loadConfig();
    assert.ok(cfg.llm !== undefined);
    assert.equal(cfg.llm!.apiKey, 'sk-from-env');
  });

  it('keeps baseUrl and model from the config file when the key comes from env', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  model: "deepseek-chat"
  baseUrl: "https://api.example.com"
`);
    process.env.ZELTO_LLM_API_KEY = 'sk-from-env';
    const cfg = loadConfig();
    assert.equal(cfg.llm?.apiKey, 'sk-from-env');
    assert.equal(cfg.llm?.model, 'deepseek-chat');
    assert.equal(cfg.llm?.baseUrl, 'https://api.example.com');
    assert.equal(cfg.llm?.provider, 'deepseek');
  });

  it('leaves llm undefined when neither env nor config has a key', () => {
    writeConfig(`
gate:
  - { name: test, run: "pnpm test" }
`);
    const cfg = loadConfig();
    assert.equal(cfg.llm, undefined);
  });

  it('uses the env key even when there is no config file at all', () => {
    process.env.ZELTO_LLM_API_KEY = 'sk-from-env';
    const cfg = loadConfig();
    assert.ok(cfg.llm !== undefined);
    assert.equal(cfg.llm!.apiKey, 'sk-from-env');
  });
});
