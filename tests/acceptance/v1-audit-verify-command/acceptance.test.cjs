// v1-audit-verify-command 验收：audit verify 只读校验
//
// 规格只有一条占位验收（"需人补齐"），本文件断言设计上下文已明确的行为：
// verify 分支存在、只读、**三态结论**（ok / broken / no-chain）、CLI 真实可执行。
// 人补齐口径后，断言与规格一起修订。
//
// ── 为什么全部用「自建临时链」而不是仓库里的本地事件流 ──────────────────
//
// 病灶（本文件此前的写法，2026-11-24 修）：
//
//   原「verify 篡改链必红」那条直接拿仓库里的 `v1-event-hash-chain` 流断言
//   「必须是 BROKEN」。但 `.zelto/` 在 `.gitignore` 里、`git ls-files .zelto`
//   返回 0 行 —— **干净检出与 CI 上根本不存在这个流**。
//   于是那条断言只有作者本机（有历史 `.zelto` 数据）才绿，CI 上必红：
//
//     node dist/cli/index.js audit verify v1-event-hash-chain --json
//     → { ok: true, checked: 0, ... }  退出码 0   （断言期望 ok === false）
//
//   判据不该依赖**未入库的本地状态** —— 那不是判据，那是运气。
//
// 修法：**自己造链**。在临时目录里写一条真实格式的事件流（自己算 hash），
// 篡改其中一行，再让 CLI 去验 —— 断言只依赖被测逻辑，不依赖任何外部状态。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// 门禁②在 worktree 里跑（cwd = worktree），而 worktree 没有 dist/ ——
// CLI 二进制只在主仓。向上查找到含 dist/cli/index.js 的主仓（C3：纯路径探测）。
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
const AUDIT_SRC = path.join(REPO, 'src', 'cli', 'commands', 'audit.ts');
const CATALOG_SRC = path.join(REPO, 'src', 'cli', 'commands', 'catalog.ts');
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const STREAM_DIST = path.join(REPO, 'dist', 'core', 'events', 'stream.js');

/**
 * 跑 CLI。
 *
 * `cwd` 默认是主仓 —— 但 `.zelto/` 是**相对 cwd** 解析的
 * （`shared.ts`：`EVENTS_DIR = join('.zelto', 'events')`），
 * 所以要验一条自建的链，必须把 cwd 指到那条链所在的项目根。
 */
function runCli(args, cwd = REPO) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf8', timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function parseVerdict(out) {
  try {
    const start = out.indexOf('{');
    if (start < 0) return null;
    return JSON.parse(out.slice(start));
  } catch {
    return null;
  }
}

test('audit.ts 含 verify 分支且调用 verifyChain', () => {
  const src = fs.readFileSync(AUDIT_SRC, 'utf8');
  assert.ok(src.includes("'verify'") || src.includes('"verify"'), '须有 verify 分支');
  assert.ok(/verifyChain/.test(src), '须调用 verifyChain');
});

test('verify 路径只读：不写任何文件', () => {
  const src = fs.readFileSync(AUDIT_SRC, 'utf8');
  // 取 verify 分支到下一个 register/分支之间的代码，确认无写操作
  const idx = src.indexOf('verify');
  const seg = src.slice(idx, idx + 3000);
  assert.ok(!/\.append\s*\(/.test(seg), 'verify 路径不得 append 事件');
  assert.ok(!/writeFile|appendFile|mkdir/.test(seg), 'verify 路径不得写文件');
});

test('catalog 登记 audit verify 用法', () => {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  assert.ok(/verify/.test(src), 'catalog 须提及 verify');
});

test('CLI：不存在的流 → no-chain（无链可验、不判假，但也不是「验过了」）', () => {
  const r = runCli(['audit', 'verify', '__no_such_slice_for_acceptance_xyz__']);
  assert.equal(r.exit, 0, `无链应退出 0，输出：${r.out}`);
  // 三态必须能被外部读出来 —— 「无链」不能被压成「OK」。
  assert.ok(/NO CHAIN/.test(r.out), `须明确报告 NO CHAIN，输出：${r.out}`);
  assert.ok(/无链可验/.test(r.out), `须明说无链可验，输出：${r.out}`);
  // 也不能出现「链完好」的措辞 —— 那会让人以为验过了。
  assert.ok(!/Chain: OK\b/.test(r.out), `无链不得报成 OK，输出：${r.out}`);
});

test('CLI：不存在的流 --json → status=no-chain', () => {
  const r = runCli(['audit', 'verify', '__no_such_slice_for_acceptance_xyz__', '--json']);
  const verdict = parseVerdict(r.out);
  assert.ok(verdict && typeof verdict.ok === 'boolean', `须输出 JSON verdict，实际：${r.out.slice(0, 500)}`);
  assert.equal(verdict.status, 'no-chain', `无链须判 no-chain，实际：${JSON.stringify(verdict)}`);
  assert.equal(verdict.ok, true, '无链不判假（ADR-100 §3）');
  assert.equal(verdict.checked, 0);
  assert.equal(r.exit, 0, '无链不判假 → 退出码 0');
});

/**
 * 在临时项目里造一条**真实格式**的事件链，然后按需篡改。
 *
 * 用 `dist/core/events/stream.js` 导出的 `canonicalEventContent` 算 hash ——
 * 与 `EventStream.append` 用的是**同一份**规范（ADR-100 §3），
 * 所以造出来的链是真链，不是「看着像链」。
 */
function buildChainProject(sliceId, { tamper = null } = {}) {
  const { canonicalEventContent } = require(STREAM_DIST);
  const crypto = require('node:crypto');
  const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-audit-verify-'));
  const events = [];
  let prevHash = null;
  for (let i = 1; i <= 3; i++) {
    const base = {
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      runSeq: i,
      slice: sliceId,
      run: 'run-1',
      type: 'slice.state.changed',
      actor: 'test',
      payload: { n: i },
      prevHash,
    };
    const hash = sha256Hex(canonicalEventContent(base));
    events.push({ ...base, hash });
    prevHash = hash;
  }

  if (tamper === 'middle-hash') {
    // 篡改中间那条的 hash —— 复算必然对不上。
    events[1].hash = '0'.repeat(64);
  } else if (tamper === 'append-unchained') {
    // 在链中间插一条**没上链**的老格式事件 —— 断链证据。
    events.splice(2, 0, {
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 99)).toISOString(),
      runSeq: 3,
      slice: sliceId,
      run: 'run-1',
      type: 'slice.state.changed',
      actor: 'test',
      payload: { n: 999 },
    });
  }

  const dir = path.join(root, '.zelto', 'events', sliceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return root;
}

test('CLI：完整链 → OK（status=ok）', () => {
  const sliceId = 'acc-verify-ok';
  const root = buildChainProject(sliceId);
  try {
    const r = runCli(['audit', 'verify', sliceId, '--json'], root);
    const verdict = parseVerdict(r.out);
    assert.ok(verdict, `须输出 JSON verdict，实际：${r.out.slice(0, 500)}`);
    assert.equal(verdict.status, 'ok', `完整链须判 ok，实际：${JSON.stringify(verdict)}`);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.checked, 3, '三条都参与了校验');
    assert.equal((verdict.failures || []).length, 0);
    assert.equal(r.exit, 0, '完整链退出码为 0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：verify 篡改链必红（audit verify 不是恒过）', () => {
  // 自己造一条「中间被篡改」的链 —— 不依赖任何未入库的本地状态。
  const sliceId = 'acc-verify-broken';
  const root = buildChainProject(sliceId, { tamper: 'middle-hash' });
  try {
    const r = runCli(['audit', 'verify', sliceId, '--json'], root);
    const verdict = parseVerdict(r.out);
    assert.ok(verdict && typeof verdict.ok === 'boolean', `须输出 JSON verdict，实际：${r.out.slice(0, 500)}`);
    assert.equal(verdict.status, 'broken', `篡改链必须判 broken，实际：${JSON.stringify(verdict)}`);
    assert.equal(verdict.ok, false, '被篡改的链必须判 BROKEN');
    assert.ok((verdict.failures || []).length >= 1, '必须报出断点');
    assert.equal(r.exit, 1, '断链时退出码为 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：链中间插入未上链事件 → broken', () => {
  const sliceId = 'acc-verify-unchained';
  const root = buildChainProject(sliceId, { tamper: 'append-unchained' });
  try {
    const r = runCli(['audit', 'verify', sliceId, '--json'], root);
    const verdict = parseVerdict(r.out);
    assert.ok(verdict, `须输出 JSON verdict，实际：${r.out.slice(0, 500)}`);
    assert.equal(verdict.status, 'broken', `链中间插入未上链事件必须判 broken，实际：${JSON.stringify(verdict)}`);
    assert.ok((verdict.failures || []).length >= 1, '必须报出断点');
    assert.equal(r.exit, 1, '断链时退出码为 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：verify 只读 —— 校验前后事件流逐字节相同', () => {
  const sliceId = 'acc-verify-readonly';
  const root = buildChainProject(sliceId, { tamper: 'middle-hash' });
  try {
    const file = path.join(root, '.zelto', 'events', sliceId, 'events.jsonl');
    const before = fs.readFileSync(file);
    const dirBefore = fs.readdirSync(path.join(root, '.zelto', 'events', sliceId));
    runCli(['audit', 'verify', sliceId, '--json'], root);
    const after = fs.readFileSync(file);
    assert.ok(before.equals(after), 'verify 不得改动事件流');
    assert.deepEqual(
      fs.readdirSync(path.join(root, '.zelto', 'events', sliceId)),
      dirBefore,
      'verify 不得新增/删除文件',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
