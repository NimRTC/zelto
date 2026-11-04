import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION, getVersionString } from '../src/cli/version.js';

describe('zelto version', () => {
  it('should export VERSION as a non-empty string', () => {
    assert.ok(typeof VERSION === 'string');
    assert.ok(VERSION.length > 0);
  });

  it('should match package.json version', () => {
    // 不写死版本号 —— 版本一改这个测试就假失败。
    // 真源是 package.json，测试读同一份真源比对。
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it('getVersionString should return formatted version', () => {
    const result = getVersionString();
    assert.equal(result, `zelto v${VERSION}`);
  });

  it('getVersionString should start with "zelto v"', () => {
    const result = getVersionString();
    assert.ok(result.startsWith('zelto v'));
  });

  it('getVersionString should contain the version number', () => {
    const result = getVersionString();
    assert.ok(result.includes(VERSION));
  });
});
