// Tests for ContractRegistry

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractRegistry } from '../src/core/contracts/registry.js';

const TEST_DIR = join(tmpdir(), 'zelto-contract-test');
const SCHEMAS_DIR = join(TEST_DIR, 'schemas');

describe('ContractRegistry', () => {
  let registry: ContractRegistry;

  before(async () => {
    await mkdir(SCHEMAS_DIR, { recursive: true });

    // Write test schemas
    await writeFile(join(SCHEMAS_DIR, 'person.json'), JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'person',
      description: 'A person',
      type: 'object',
      required: ['name', 'age'],
      properties: {
        name: { type: 'string', minLength: 1 },
        age: { type: 'number', minimum: 0, maximum: 150 },
        email: { type: 'string', pattern: '^[\\w.-]+@[\\w.-]+\\.\\w+$' },
        role: { type: 'string', enum: ['admin', 'user', 'guest'] },
      },
      additionalProperties: false,
    }), 'utf-8');

    await writeFile(join(SCHEMAS_DIR, 'config.json'), JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'config',
      description: 'Configuration',
      type: 'object',
      required: ['port', 'host'],
      properties: {
        port: { type: 'number', minimum: 1, maximum: 65535 },
        host: { type: 'string' },
        debug: { type: 'boolean' },
      },
    }), 'utf-8');

    await writeFile(join(SCHEMAS_DIR, 'items.json'), JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'items',
      description: 'List of items',
      type: 'array',
      items: { type: 'string' },
    }), 'utf-8');

    registry = new ContractRegistry(SCHEMAS_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('loads all schemas from directory', async () => {
    const schemas = await registry.loadAll();
    assert.equal(schemas.length, 3);
    const names = schemas.map((s) => s.name).sort();
    assert.deepEqual(names, ['config', 'items', 'person']);
  });

  it('loads a specific schema by name', async () => {
    const schema = await registry.get('person');
    assert.ok(schema, 'schema should be found');
    assert.equal(schema?.name, 'person');
    assert.equal(schema?.description, 'A person');
  });

  it('returns null for unknown schema', async () => {
    const schema = await registry.get('nonexistent');
    assert.equal(schema, null);
  });

  it('validates a valid object', async () => {
    const result = await registry.validate(
      { name: 'Alice', age: 30, email: 'alice@example.com', role: 'admin' },
      'person',
    );
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('validates required fields', async () => {
    const result = await registry.validate({ name: 'Bob' }, 'person');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.endsWith('age') && e.message.includes('Missing')));
  });

  it('validates type constraints', async () => {
    const result = await registry.validate(
      { name: 'Charlie', age: 'thirty' },
      'person',
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('Expected type number')));
  });

  it('validates enum constraints', async () => {
    const result = await registry.validate(
      { name: 'Dave', age: 25, role: 'superadmin' },
      'person',
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('enum')));
  });

  it('validates minimum/maximum', async () => {
    const tooOld = await registry.validate({ name: 'Old', age: 200 }, 'person');
    assert.equal(tooOld.valid, false);

    const tooYoung = await registry.validate({ name: 'Young', age: -1 }, 'person');
    assert.equal(tooYoung.valid, false);
  });

  it('validates pattern constraint', async () => {
    const result = await registry.validate(
      { name: 'Test', age: 20, email: 'not-an-email' },
      'person',
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('Pattern')));
  });

  it('validates additionalProperties: false', async () => {
    const result = await registry.validate(
      { name: 'Test', age: 20, extraField: 'not allowed' },
      'person',
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('Unexpected property')));
  });

  it('validates array items', async () => {
    const result = await registry.validate(['a', 'b', 'c'], 'items');
    assert.equal(result.valid, true);

    const bad = await registry.validate(['a', 42, 'c'], 'items');
    assert.equal(bad.valid, false);
  });

  it('validates numeric config', async () => {
    const valid = await registry.validate({ port: 8080, host: 'localhost', debug: true }, 'config');
    assert.equal(valid.valid, true);

    const invalid = await registry.validate({ port: 0, host: 'localhost' }, 'config');
    assert.equal(invalid.valid, false);
  });

  it('invalidates cache and reloads', async () => {
    registry.invalidateCache();
    const schema = await registry.get('person');
    assert.ok(schema, 'should reload from disk');
    assert.equal(schema?.name, 'person');
  });

  it('lists available schemas', async () => {
    const schemas = await registry.list();
    assert.equal(schemas.length, 3);
  });
});
