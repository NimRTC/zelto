import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, getVersionString } from '../src/cli/version.js';

describe('zelto version', () => {
  it('should export VERSION as a non-empty string', () => {
    assert.ok(typeof VERSION === 'string');
    assert.ok(VERSION.length > 0);
  });

  it('should match package.json version (0.1.0)', () => {
    assert.equal(VERSION, '0.1.0');
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
