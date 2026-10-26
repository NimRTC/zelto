import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setJsonMode,
  isJsonMode,
  formatTable,
  formatList,
  colors,
} from '../src/cli/output.js';

describe('cli output module', () => {
  describe('JSON mode', () => {
    it('should default to false', () => {
      assert.equal(isJsonMode(), false);
    });

    it('should toggle with setJsonMode', () => {
      setJsonMode(true);
      assert.equal(isJsonMode(), true);
      setJsonMode(false);
      assert.equal(isJsonMode(), false);
    });
  });

  describe('formatTable', () => {
    it('should produce table with headers and rows', () => {
      const result = formatTable(
        [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Name' },
        ],
        [
          { id: '1', name: 'Alice' },
          { id: '2', name: 'Bob' },
        ],
      );
      assert.ok(result.includes('ID'));
      assert.ok(result.includes('Name'));
      assert.ok(result.includes('Alice'));
      assert.ok(result.includes('Bob'));
    });

    it('should return empty string for no rows', () => {
      const result = formatTable(
        [{ key: 'id', label: 'ID' }],
        [],
      );
      assert.equal(result, '');
    });
  });

  describe('formatList', () => {
    it('should format items with labels', () => {
      const result = formatList([
        { label: 'Item A' },
        { label: 'Item B' },
      ]);
      assert.ok(result.includes('Item A'));
      assert.ok(result.includes('Item B'));
      assert.ok(result.includes('•'));
    });

    it('should include state badges when present', () => {
      const result = formatList([
        { label: 'Task', state: 'done' },
      ]);
      assert.ok(result.includes('[done]'));
    });

    it('should include values when present', () => {
      const result = formatList([
        { label: 'Path', value: '/src/main.ts' },
      ]);
      assert.ok(result.includes('/src/main.ts'));
    });
  });

  describe('color exports', () => {
    it('should re-export colors', () => {
      assert.ok(typeof colors.red === 'function');
      assert.ok(typeof colors.green === 'function');
      assert.ok(typeof colors.bold === 'function');
    });
  });
});
