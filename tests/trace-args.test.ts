import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceArgs, printTraceHelp } from '../src/cli/commands/trace/args.js';

describe('trace args parser', () => {
  // ─── requirement ID ──────────────────────────────────────────────────────────

  it('parses a requirement ID from positional args', () => {
    const result = parseTraceArgs(['REQ-001']);
    assert.equal(result.help, false);
    assert.equal(result.reqId, 'REQ-001');
    assert.equal(result.format, 'text');
  });

  it('accepts requirement IDs with various characters', () => {
    const ids = ['REQ-001', 'req_abc', 'v1.2', 'DESIGN-42', 'PRJ-2026-001'];
    for (const id of ids) {
      const result = parseTraceArgs([id]);
      assert.equal(result.reqId, id);
      assert.equal(result.help, false);
    }
  });

  // ─── missing requirement ID ─────────────────────────────────────────────────

  it('returns help=true when no positional args given', () => {
    const result = parseTraceArgs([]);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  // ─── --json ─────────────────────────────────────────────────────────────────

  it('parses --json flag', () => {
    const result = parseTraceArgs(['REQ-001', '--json']);
    assert.equal(result.reqId, 'REQ-001');
    assert.equal(result.format, 'json');
    assert.equal(result.help, false);
  });

  it('defaults to text format without --json', () => {
    const result = parseTraceArgs(['REQ-001']);
    assert.equal(result.format, 'text');
  });

  // ─── --help / -h ─────────────────────────────────────────────────────────────

  it('sets help=true when --help is passed', () => {
    const result = parseTraceArgs(['--help']);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  it('sets help=true when -h is passed', () => {
    const result = parseTraceArgs(['-h']);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  it('--help works with reqId as first arg', () => {
    const result = parseTraceArgs(['--help', 'REQ-001']);
    assert.equal(result.help, true);
  });

  // ─── printTraceHelp ──────────────────────────────────────────────────────────

  it('printTraceHelp outputs help text', () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => lines.push(args.join(' '));
    try {
      printTraceHelp();
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0);
    const output = lines.join('\n');
    assert.ok(output.includes('zelto trace'));
    assert.ok(output.includes('--json'));
    assert.ok(output.includes('--help'));
  });
});
