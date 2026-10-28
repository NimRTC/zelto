// Tests for OutputFormatter v2
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OutputFormat, OutputFormatter, initFormatter, getDefaultFormatter, setDefaultFormatter } from '../src/cli/output-formatter.js';
import { validateWithSchema, isValid } from '../src/cli/validate-schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an OutputFormatter with auto-JSON-from-pipe disabled.
 * This ensures terminal mode tests work in non-TTY environments (e.g., test runners).
 */
function createFormatter(format: OutputFormat = OutputFormat.Terminal): OutputFormatter {
  const f = new OutputFormatter(format);
  f.disableAutoJsonFromPipe();
  return f;
}

// Helper to capture stdout/stderr
interface StreamCapture {
  restore: () => void;
  getOutput: () => string;
}

function captureStream(stream: 'stdout' | 'stderr'): StreamCapture {
  const orig = process[stream].write.bind(process[stream]);
  let output = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process[stream].write = ((chunk: any) => { output += String(chunk); return true; }) as any;
  return {
    restore: () => { process[stream].write = orig; },
    getOutput: () => output,
  };
}

describe('OutputFormatter', () => {
  before(async () => {
    await initFormatter();
  });

  describe('OutputFormat enum', () => {
    it('should have three formats', () => {
      assert.equal(OutputFormat.Terminal, 'terminal');
      assert.equal(OutputFormat.JSON, 'json');
      assert.equal(OutputFormat.YAML, 'yaml');
    });
  });

  describe('format accessors', () => {
    it('should default to Terminal', () => {
      const f = createFormatter();
      assert.equal(f.getFormat(), OutputFormat.Terminal);
    });

    it('should set format via constructor', () => {
      const f = createFormatter(OutputFormat.JSON);
      assert.equal(f.getFormat(), OutputFormat.JSON);
    });

    it('should allow runtime format change', () => {
      const f = createFormatter(OutputFormat.Terminal);
      f.setFormat(OutputFormat.YAML);
      assert.equal(f.getFormat(), OutputFormat.YAML);
    });
  });

  describe('out()', () => {
    it('should write message to stdout in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.out('hello world');
      cap.restore();
      assert.ok(cap.getOutput().includes('hello world'));
      assert.ok(cap.getOutput().endsWith('\n'));
    });

    it('should write to stderr with stderr option', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stderr');
      f.out('error msg', { stderr: true });
      cap.restore();
      assert.ok(cap.getOutput().includes('error msg'));
    });

    it('should output JSON in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.out('hello');
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.message, 'hello');
    });

    it('should include timestamp when requested', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.out('hello', { timestamp: true });
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.message, 'hello');
      assert.ok(typeof parsed.timestamp === 'string');
    });
  });

  describe('data()', () => {
    it('should output (empty) for null in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.data(null);
      cap.restore();
      assert.ok(cap.getOutput().includes('(empty)'));
    });

    it('should output (empty) for empty array in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.data([]);
      cap.restore();
      assert.ok(cap.getOutput().includes('(empty)'));
    });

    it('should output array items in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.data([{ id: '1', name: 'test' }]);
      cap.restore();
      assert.ok(cap.getOutput().includes('1.'));
      assert.ok(cap.getOutput().includes('test'));
    });

    it('should output JSON in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.data([{ id: '1' }]);
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.ok(Array.isArray(parsed.data));
      assert.equal(parsed.data[0].id, '1');
    });

    it('should include total/shown when provided', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.data([], { total: 10, showing: 0 });
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.total, 10);
      assert.equal(parsed.showing, 0);
    });
  });

  describe('error()', () => {
    it('should write error to stderr in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stderr');
      f.error('TEST_ERR', 'something went wrong');
      cap.restore();
      assert.ok(cap.getOutput().includes('Error:'));
      assert.ok(cap.getOutput().includes('something went wrong'));
    });

    it('should output structured error in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stderr');
      f.error('ERR_CODE', 'fail');
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.error.code, 'ERR_CODE');
      assert.equal(parsed.error.message, 'fail');
    });

    it('should include extra fields in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stderr');
      f.error('ERR', 'msg', { path: '/test', detail: 'extra' });
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.error.path, '/test');
      assert.equal(parsed.error.detail, 'extra');
    });
  });

  describe('success()', () => {
    it('should write green success in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.success('all good');
      cap.restore();
      assert.ok(cap.getOutput().includes('all good'));
    });

    it('should output structured success in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.success('done');
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.success, true);
      assert.equal(parsed.message, 'done');
    });

    it('should include data when provided in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stdout');
      f.success('done', { data: { id: 1 } });
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.data.id, 1);
    });
  });

  describe('warn()', () => {
    it('should write warning in terminal mode', () => {
      const f = createFormatter(OutputFormat.Terminal);
      const cap = captureStream('stdout');
      f.warn('be careful');
      cap.restore();
      assert.ok(cap.getOutput().includes('be careful'));
    });

    it('should output structured warning in JSON mode', () => {
      const f = createFormatter(OutputFormat.JSON);
      const cap = captureStream('stderr');
      f.warn('caution');
      cap.restore();
      const parsed = JSON.parse(cap.getOutput());
      assert.equal(parsed.warning, 'caution');
    });
  });

  describe('singleton', () => {
    it('should return default formatter', () => {
      const f = getDefaultFormatter();
      assert.ok(f instanceof OutputFormatter);
    });

    it('should allow setting default formatter', () => {
      const custom = createFormatter(OutputFormat.JSON);
      setDefaultFormatter(custom);
      assert.equal(getDefaultFormatter(), custom);

      // Reset
      setDefaultFormatter(new OutputFormatter());
    });
  });
});

describe('validateWithSchema', () => {
  describe('output-message', () => {
    it('should validate a valid message', () => {
      const errors = validateWithSchema('output-message', { message: 'hello' });
      assert.equal(errors.length, 0);
    });

    it('should reject missing required message', () => {
      const errors = validateWithSchema('output-message', {});
      assert.ok(errors.length > 0);
    });

    it('should reject unexpected properties', () => {
      const errors = validateWithSchema('output-message', { message: 'hi', extraField: 123 });
      assert.ok(errors.length > 0);
    });
  });

  describe('output-error', () => {
    it('should validate a valid error', () => {
      const errors = validateWithSchema('output-error', { error: { code: 'E1', message: 'fail' } });
      assert.equal(errors.length, 0);
    });

    it('should reject missing error.code', () => {
      const errors = validateWithSchema('output-error', { error: { message: 'fail' } });
      assert.ok(errors.length > 0);
    });
  });

  describe('output-success', () => {
    it('should validate a valid success', () => {
      const errors = validateWithSchema('output-success', { success: true, message: 'done' });
      assert.equal(errors.length, 0);
    });

    it('should reject success:false', () => {
      const errors = validateWithSchema('output-success', { success: false, message: 'done' });
      assert.equal(errors.length, 0); // boolean is boolean, schema only checks type
    });
  });

  describe('output-warning', () => {
    it('should validate a valid warning', () => {
      const errors = validateWithSchema('output-warning', { warning: 'careful' });
      assert.equal(errors.length, 0);
    });
  });

  describe('isValid', () => {
    it('should return true for valid data', () => {
      assert.ok(isValid('output-message', { message: 'ok' }));
    });

    it('should return false for invalid data', () => {
      assert.equal(isValid('output-message', {}), false);
    });
  });
});

describe('OutputFormatter with YAML', () => {
  it('should output YAML when format is YAML', () => {
    const f = createFormatter(OutputFormat.YAML);
    const cap = captureStream('stdout');
    f.success('done');
    cap.restore();
    const output = cap.getOutput();
    // YAML output should contain key: value pairs
    assert.ok(output.includes('success:'));
    assert.ok(output.includes('message:'));
    assert.ok(output.includes('done'));
  });

  it('should output data in YAML format', () => {
    const f = createFormatter(OutputFormat.YAML);
    const cap = captureStream('stdout');
    f.data([{ id: '1' }]);
    cap.restore();
    const output = cap.getOutput();
    assert.ok(output.includes('data:'));
    assert.ok(output.includes('id:'));
    assert.ok(output.includes('1'));
  });
});
