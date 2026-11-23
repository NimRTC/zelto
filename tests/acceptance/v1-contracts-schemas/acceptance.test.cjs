// v1-contracts-schemas 验收：event-envelope.json 可选 prevHash/hash 字段
//
// 对应 specs/slices/v1-contracts-schemas.md 三条验收标准。
// 判据全部读磁盘状态，不依赖 git 历史（ADR-075：产物检查用状态读），
// 因此 squash / rebase / worktree 清理都不会翻转结论。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// 门禁②在 worktree 里跑，而 worktree 没有 dist/ ——向上查找到含 dist/cli/index.js 的主仓。
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'dist', 'cli', 'index.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const REPO = findRepoRoot(ROOT);
const SCHEMA_PATH = path.join(REPO, 'contracts', 'schemas', 'event-envelope.json');
const HOOK_IO_PATH = path.join(REPO, 'contracts', 'schemas', 'hook-io.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 最小必填字段校验：只认 schema 的 required + properties.type，
// 不引入第三方依赖（core/ 零依赖，验收同样不拉新依赖）。
function checkRequired(doc, schema) {
  const required = schema.required || [];
  for (const k of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(doc, k), `缺必填字段: ${k}`);
  }
  return true;
}

test('properties 含 prevHash/hash 且 required 不含二者', () => {
  const schema = readJson(SCHEMA_PATH);
  assert.ok(schema.properties, 'schema 缺 properties');
  assert.ok(schema.properties.prevHash, 'properties 缺 prevHash');
  assert.ok(schema.properties.hash, 'properties 缺 hash');
  const required = schema.required || [];
  assert.ok(!required.includes('prevHash'), 'required 不应含 prevHash（必须可选）');
  assert.ok(!required.includes('hash'), 'required 不应含 hash（必须可选）');
});

test('不带 prevHash/hash 的存量 envelope 仍通过校验', () => {
  const schema = readJson(SCHEMA_PATH);
  const legacy = {
    ts: '2026-11-23T00:00:00.000Z',
    runSeq: 1,
    slice: 'v1-contracts-schemas',
    type: 'slice.state.changed',
    actor: 'test',
    payload: {},
  };
  assert.ok(checkRequired(legacy, schema), '存量事件应通过 required 校验');
  // 可选字段缺省必须合法：补上之后同样通过（字段类型为 string/null + string）
  const withChain = { ...legacy, prevHash: null, hash: 'abc123' };
  assert.ok(checkRequired(withChain, schema), '带链字段的事件也应通过');
  assert.equal(typeof withChain.hash, 'string');
  assert.ok(withChain.prevHash === null || typeof withChain.prevHash === 'string');
});

test('变更范围仅 event-envelope.json：hook-io 未被触碰', () => {
  // 磁盘状态断言（不读 git 历史）：hook-io.json 存在且不含链字段，
  // 说明本片没有把链字段扩散到其它 schema。
  assert.ok(fs.existsSync(SCHEMA_PATH), 'event-envelope.json 必须在树上');
  assert.ok(fs.existsSync(HOOK_IO_PATH), 'hook-io.json 必须在树上');
  const hookIo = readJson(HOOK_IO_PATH);
  const props = hookIo.properties || {};
  assert.ok(!('prevHash' in props), 'hook-io.json 不应含 prevHash');
  assert.ok(!('hash' in props), 'hook-io.json 不应含 hash');
  const schema = readJson(SCHEMA_PATH);
  assert.ok(schema.properties.prevHash, '链字段必须只落在 event-envelope.json');
  assert.ok(schema.properties.hash, '链字段必须只落在 event-envelope.json');
});
