// 验收测试 —— 切片 v1-version-align：版本号对齐与一致性校验脚本
//
// 六条验收标准各对应一条用例，全是真断言（无 todo / skip）。
// 标准 4（不一致 → 非零退出 + 可读错误）在 os.tmpdir() 的临时沙箱里验证，
// 拷贝真实 package.json / package-lock.json / 脚本到沙箱再改版本 ——
// 不碰仓库里的真实文件，测试中途被杀也不会留下脏的 package.json。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'version-check.mjs');

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

function runVersionCheck(cwd = ROOT) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
    signal: res.signal,
  };
}

test('package.json 的 version 字段为 0.7.1', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.version, '0.7.1');
});

test('package-lock.json 根包版本与 package.json 一致（均为 0.7.1）', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const lockVersion =
    lock.lockfileVersion >= 2 ? lock.packages[''].version : lock.version;
  assert.equal(lockVersion, pkg.version);
  assert.equal(lockVersion, '0.7.1');
});

test('版本一致时 node scripts/version-check.mjs 退出 0 且无错误输出', () => {
  const res = runVersionCheck();
  assert.equal(res.error, undefined, `脚本启动失败：${res.error}`);
  assert.equal(res.signal, null, `进程被信号终止：${res.signal}`);
  assert.equal(res.status, 0, `一致时应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);
  assert.equal(res.stderr, '', '一致时不得有错误输出');
});

test('版本不一致时脚本非零退出且输出含 package.json/package-lock.json 与实际/预期版本；恢复后退出 0', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'zelto-version-align-'));
  try {
    mkdirSync(join(sandbox, 'scripts'));
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');
    writeFileSync(
      join(sandbox, 'package-lock.json'),
      JSON.stringify(lock, null, 2) + '\n',
      'utf-8',
    );
    writeFileSync(
      join(sandbox, 'scripts', 'version-check.mjs'),
      readFileSync(SCRIPT, 'utf-8'),
      'utf-8',
    );

    // 不一致：package.json 改成 0.7.2，package-lock.json 仍是 0.7.1
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify({ ...pkg, version: '0.7.2' }, null, 2) + '\n',
      'utf-8',
    );
    let res = spawnSync(process.execPath, [join(sandbox, 'scripts', 'version-check.mjs')], {
      cwd: sandbox,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = (res.stdout ?? '') + (res.stderr ?? '');
    assert.notEqual(res.status, 0, `不一致时应非零退出，实际 ${res.status}：\n${output}`);
    assert.ok(output.includes('package.json'), '错误输出必须提到 package.json');
    assert.ok(output.includes('package-lock.json'), '错误输出必须提到 package-lock.json');
    assert.ok(output.includes('0.7.2'), `错误输出必须包含实际版本 0.7.2，实际：${output}`);
    assert.ok(output.includes('0.7.1'), `错误输出必须包含预期版本 0.7.1，实际：${output}`);

    // 恢复一致：还原 package.json 的 0.7.1
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n',
      'utf-8',
    );
    res = spawnSync(process.execPath, [join(sandbox, 'scripts', 'version-check.mjs')], {
      cwd: sandbox,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(res.status, 0, `恢复后应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('package.json 的 scripts.prepublishOnly 为 "node scripts/version-check.mjs"', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts.prepublishOnly, 'node scripts/version-check.mjs');
});

test('校验脚本只读：连续运行两次，package.json 与 package-lock.json 哈希不变', () => {
  const targets = ['package.json', 'package-lock.json'];
  const sha = (rel) =>
    createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
  const before = targets.map(sha);

  const first = runVersionCheck();
  const second = runVersionCheck();
  assert.equal(first.status, 0, `第一次运行应退出 0，实际 ${first.status}`);
  assert.equal(second.status, 0, `第二次运行应退出 0，实际 ${second.status}`);

  const after = targets.map(sha);
  assert.deepEqual(after, before, '运行前后哈希必须一致（脚本不得修改文件）');
});
