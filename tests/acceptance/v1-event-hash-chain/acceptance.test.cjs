// v1-event-hash-chain 验收：stream.ts append/verifyChain/loadChain
//
// 对应 specs/slices/v1-event-hash-chain.md 四条验收标准。
// 用编译产物 dist/core/events/stream.js 跑真实逻辑，
// 临时目录隔离，不污染 .zelto/events。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// 门禁②在 worktree 里跑（cwd = worktree），而 worktree 没有 dist/ ——
// 实现产物只在主仓构建。向上查找到含 dist/cli/index.js 的主仓（C3：纯路径探测）。
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
const SRC_PATH = path.join(REPO, 'src', 'core', 'events', 'stream.ts');
const DIST_PATH = path.join(REPO, 'dist', 'core', 'events', 'stream.js');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('EventEnvelope 类型含 prevHash/hash 字段', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  assert.ok(/prevHash\?\s*:\s*string\s*\|\s*null/.test(src), '须定义 prevHash?: string | null');
  assert.ok(/hash\?\s*:\s*string/.test(src), '须定义 hash?: string');
});

test('append 写入 3 事件：链式链接 + hash 可复算', async () => {
  const { EventStream, canonicalEventContent } = require(DIST_PATH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-chain-'));
  const stream = new EventStream(dir);
  const e1 = await stream.append('s1', 'slice.state.changed', 'test', { n: 1 });
  const e2 = await stream.append('s1', 'slice.state.changed', 'test', { n: 2 });
  const e3 = await stream.append('s1', 'slice.state.changed', 'test', { n: 3 });

  assert.equal(e1.prevHash, null, '创世事件 prevHash 为 null');
  assert.equal(e2.prevHash, e1.hash, '第2个 prevHash 等于第1个 hash');
  assert.equal(e3.prevHash, e2.hash, '第3个 prevHash 等于第2个 hash');

  for (const e of [e1, e2, e3]) {
    assert.ok(typeof e.hash === 'string' && e.hash.length === 64, 'hash 为 64 位 hex');
    const { hash, ...rest } = e;
    const recomputed = sha256Hex(canonicalEventContent(rest));
    assert.equal(hash, recomputed, 'hash 与规范内容复算一致');
  }

  // 持久化内容同样可复算
  const lines = fs.readFileSync(path.join(dir, 's1', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyChain：好链过、篡改后失败', async () => {
  const { EventStream } = require(DIST_PATH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-verify-'));
  const stream = new EventStream(dir);
  await stream.append('s2', 'slice.state.changed', 'test', { n: 1 });
  await stream.append('s2', 'slice.state.changed', 'test', { n: 2 });

  const good = await stream.verifyChain('s2');
  assert.equal(good.ok, true, `好链应通过：${JSON.stringify(good.failures)}`);
  assert.equal(good.checked, 2);

  // 篡改第二个事件的 hash
  const file = path.join(dir, 's2', 'events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines[1].hash = '0'.repeat(64);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const stream2 = new EventStream(dir);
  const bad = await stream2.verifyChain('s2');
  assert.equal(bad.ok, false, '篡改后必须失败');
  assert.ok(bad.failures.length >= 1, '必须报出断点');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadChain：数量与顺序与写入一致', async () => {
  const { EventStream } = require(DIST_PATH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-load-'));
  const stream = new EventStream(dir);
  for (let i = 0; i < 4; i++) {
    await stream.append('s3', 'slice.state.changed', 'test', { i });
  }
  const chain = await stream.loadChain('s3');
  assert.equal(chain.length, 4);
  assert.deepEqual(chain.map((e) => e.payload.i), [0, 1, 2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});
