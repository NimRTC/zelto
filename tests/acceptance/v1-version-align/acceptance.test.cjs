// 验收测试 —— 切片 v1-version-align：版本号对齐与一致性校验脚本
//
// 七条验收标准各对应一条用例，全是真断言（无 todo / skip）。
//
// 口径变更（ADR-107）—— 原验收标准有两处病灶：
//   ① 它断言「package-lock.json 的根包版本 == package.json 的版本」——
//      而那个 package-lock.json 是 agent 从 pnpm 本地 store 造出来的**假锁文件**
//      （resolved 指向 ../../../node_modules/.pnpm/...，零个 integrity）。
//      **断言通过 ≠ 文件能用** —— `npm ci` 在别的机器上照样失败。
//   ② 它断言「prepublishOnly == 'node scripts/version-check.mjs'」——
//      把原来「清理 → 构建 → 全量测试」三步的发布闸门整个换小了。
//
// 新口径：校验对象是 pnpm 锁文件（pnpm 的锁文件**不记录根包版本**，
// 实测见 ADR-107），断言的是**依赖声明逐条一致**；
// 并且必须断言 **package-lock.json 不存在** ——
// **只写正向断言，下一个 agent 还能再造一个假锁文件。**
//
// 沙箱用例在 os.tmpdir() 里跑：拷贝真实 package.json / pnpm-lock.yaml / 脚本
// 再制造漂移 —— 不碰仓库里的真实文件，测试中途被杀也不会留下脏文件。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  cpSync,
  existsSync,
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

function runVersionCheck(cwd = ROOT, script = SCRIPT) {
  const res = spawnSync(process.execPath, [script], {
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

/**
 * 造一个沙箱：拷贝 package.json + pnpm-lock.yaml + 脚本。
 *
 * 为什么还要给沙箱接上 js-yaml：`version-check.mjs` 用 js-yaml 解析锁文件，
 * 而 js-yaml 是**运行时依赖**（不是 devDependencies）。沙箱里没有它的话，
 * 脚本会自己优雅地失败（报「加载 js-yaml 失败」）——
 * 那测的就不是我们要测的漂移逻辑，而是「依赖装上了没」。
 *
 * 怎么接：pnpm 的 `node_modules/<name>` 是**指向 .pnpm store 的 junction**
 * （不是真实目录）。所以不能用相对路径去找 —— 得先在仓库根解析出
 * js-yaml 的**真实位置**，再把那一个目录接进沙箱。
 *
 * 为什么要从**仓库根**找而不是当前工作区：git worktree（`.zelto/version-worktrees/*`）
 * 里的 `node_modules` 是各自独立的，切片工作区常常还没跑过 `pnpm install`。
 * 而验收测试跑在哪个 worktree 里是**不确定的**（谁在 main 上跑就在 main）。
 * 所以这里向上找 —— 哪个祖先目录里有能用的 node_modules 就用哪个。
 */
function resolveJsYamlDir() {
  let dir = ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', 'js-yaml');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 把 js-yaml 接进沙箱。
 *
 * 用 junction（symlink）而不是复制：pnpm 的 store 里 js-yaml 有自己的
 * 依赖（argparse），复制单个目录会漏掉它们；整棵树复制又太重。
 * junction 让 Node 照常解析到真实位置。
 */
function linkJsYaml(sandbox) {
  const src = resolveJsYamlDir();
  if (!src) return false;
  const dest = join(sandbox, 'node_modules', 'js-yaml');
  mkdirSync(join(sandbox, 'node_modules'), { recursive: true });
  try {
    // Windows 要 junction（要管理员权限的 symlink 免了），POSIX 用 symlink
    const isWindows = process.platform === 'win32';
    const { symlinkSync } = require('node:fs');
    symlinkSync(src, dest, isWindows ? 'junction' : 'dir');
    return true;
  } catch {
    // 接不上就退回复制（可能漏传递依赖，但好过完全没有）
    try {
      cpSync(src, dest, { recursive: true, dereference: true });
      return true;
    } catch {
      return false;
    }
  }
}

function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'zelto-version-align-'));
  mkdirSync(join(sandbox, 'scripts'), { recursive: true });
  writeFileSync(
    join(sandbox, 'package.json'),
    readFileSync(join(ROOT, 'package.json'), 'utf-8'),
    'utf-8',
  );
  writeFileSync(
    join(sandbox, 'pnpm-lock.yaml'),
    readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf-8'),
    'utf-8',
  );
  writeFileSync(
    join(sandbox, 'scripts', 'version-check.mjs'),
    readFileSync(SCRIPT, 'utf-8'),
    'utf-8',
  );
  linkJsYaml(sandbox);
  return sandbox;
}

test('package.json 的 version 字段为 0.7.1', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.version, '0.7.1');
});

test('仓库里没有 package-lock.json —— 本仓库用 pnpm，真锁文件是 pnpm-lock.yaml', () => {
  // 这条是**最关键**的一条断言：它直接锁住「不再造 npm 锁文件」这个决定。
  //
  // 为什么必须有反向断言：这次的失败模式是「agent 造了一个看起来对的
  // 假文件，而验收只查了字段」。**只写正向断言，下一个 agent 还能再造一个。**
  //
  // 那份假文件的具体危害：14 个条目里 7 个的 resolved 指向
  // ../../../node_modules/.pnpm/...（pnpm 的本地虚拟 store），且整份文件
  // **零个 integrity** 哈希 —— npm ci 在别的机器上必然失败。
  assert.equal(
    existsSync(join(ROOT, 'package-lock.json')),
    false,
    '仓库里存在 package-lock.json —— 本仓库用 pnpm。两套锁文件会漂' +
      '（而 version-check.mjs 的存在意义就是防漂）。',
  );
  // npm-shrinkwrap.json 比 package-lock.json 更强：npm 优先用它，
  // 存在时 package-lock.json 会被忽略。
  assert.equal(
    existsSync(join(ROOT, 'npm-shrinkwrap.json')),
    false,
    '仓库里存在 npm-shrinkwrap.json —— npm 优先用它，装出来的依赖树' +
      '就不受 pnpm-lock.yaml 控制了。',
  );
  // 真锁文件必须在
  assert.equal(
    existsSync(join(ROOT, 'pnpm-lock.yaml')),
    true,
    '缺少 pnpm-lock.yaml —— 本仓库用 pnpm，那才是真锁文件。',
  );
});

test('依赖一致时 node scripts/version-check.mjs 退出 0 且无错误输出', () => {
  const res = runVersionCheck();
  assert.equal(res.error, undefined, `脚本启动失败：${res.error}`);
  assert.equal(res.signal, null, `进程被信号终止：${res.signal}`);
  assert.equal(
    res.status,
    0,
    `一致时应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`,
  );
  assert.equal(res.stderr, '', '一致时不得有错误输出');
});

test('依赖漂移（版本范围变了）时脚本非零退出且报错点明依赖名与两个版本范围；恢复后退出 0', () => {
  const sandbox = makeSandbox();
  try {
    const pkg = readJson('package.json');
    // 挑一条 dependencies 里的依赖改版本范围 —— 锁文件不动，制造漂移
    const target = Object.keys(pkg.dependencies)[0];
    const original = pkg.dependencies[target];
    const drifted = { ...pkg, dependencies: { ...pkg.dependencies, [target]: '^0.0.1' } };
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(drifted, null, 2) + '\n',
      'utf-8',
    );

    let res = runVersionCheck(sandbox, join(sandbox, 'scripts', 'version-check.mjs'));
    const output = (res.stdout ?? '') + (res.stderr ?? '');
    assert.notEqual(res.status, 0, `漂移时应非零退出，实际 ${res.status}：\n${output}`);
    assert.ok(output.includes('package.json'), `错误输出必须提到 package.json，实际：${output}`);
    assert.ok(
      output.includes('pnpm-lock.yaml'),
      `错误输出必须提到 pnpm-lock.yaml，实际：${output}`,
    );
    assert.ok(output.includes(target), `错误输出必须点明依赖名 ${target}，实际：${output}`);
    assert.ok(
      output.includes('^0.0.1'),
      `错误输出必须包含 package.json 里的版本范围 ^0.0.1，实际：${output}`,
    );
    assert.ok(
      output.includes(original),
      `错误输出必须包含锁文件里的版本范围 ${original}，实际：${output}`,
    );

    // 恢复一致 → 退出 0
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n',
      'utf-8',
    );
    res = runVersionCheck(sandbox, join(sandbox, 'scripts', 'version-check.mjs'));
    assert.equal(
      res.status,
      0,
      `恢复后应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('package.json 多出一条锁文件里没有的依赖时非零退出并点名该依赖', () => {
  const sandbox = makeSandbox();
  try {
    const pkg = readJson('package.json');
    const drifted = {
      ...pkg,
      dependencies: { ...pkg.dependencies, 'zelto-fake-dep': '^1.0.0' },
    };
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(drifted, null, 2) + '\n',
      'utf-8',
    );
    const res = runVersionCheck(sandbox, join(sandbox, 'scripts', 'version-check.mjs'));
    const output = (res.stdout ?? '') + (res.stderr ?? '');
    assert.notEqual(res.status, 0, `应非零退出，实际 ${res.status}：\n${output}`);
    assert.ok(
      output.includes('zelto-fake-dep'),
      `错误输出必须点名缺失的依赖 zelto-fake-dep，实际：${output}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('沙箱里出现 package-lock.json 时非零退出（反向断言：不再造 npm 锁文件）', () => {
  const sandbox = makeSandbox();
  try {
    // 造一个「看起来对」的假 npm 锁文件 —— 正是这次的失败模式
    writeFileSync(
      join(sandbox, 'package-lock.json'),
      JSON.stringify(
        { name: 'zelto', version: '0.7.1', lockfileVersion: 3, packages: {} },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    const res = runVersionCheck(sandbox, join(sandbox, 'scripts', 'version-check.mjs'));
    const output = (res.stdout ?? '') + (res.stderr ?? '');
    assert.notEqual(res.status, 0, `存在 npm 锁文件时应非零退出，实际 ${res.status}：\n${output}`);
    assert.ok(
      output.includes('package-lock.json'),
      `错误输出必须点名 package-lock.json，实际：${output}`,
    );
    assert.ok(
      output.includes('pnpm-lock.yaml'),
      `错误输出必须指出真锁文件是 pnpm-lock.yaml，实际：${output}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('prepublishOnly 保留了「清理 + 构建 + 全量测试」，版本校验挂在末尾', () => {
  const pkg = readJson('package.json');
  const prepublish = pkg.scripts.prepublishOnly;
  assert.ok(typeof prepublish === 'string' && prepublish.length > 0, '缺 prepublishOnly');
  // 闸门只能加，不能换小 —— 三步一步都不能少
  assert.ok(
    prepublish.includes('pnpm clean'),
    `prepublishOnly 必须先清理，实际：${prepublish}`,
  );
  assert.ok(
    prepublish.includes('pnpm build'),
    `prepublishOnly 必须构建，实际：${prepublish}`,
  );
  assert.ok(
    prepublish.includes('pnpm test'),
    `prepublishOnly 必须跑全量测试，实际：${prepublish}`,
  );
  // 版本校验在最后 —— 这样失败时其它检查都已经过了，
  // 人看到的是「前面都绿了，卡在版本一致性」
  assert.ok(
    prepublish.includes('version-check.mjs'),
    `prepublishOnly 必须包含版本校验，实际：${prepublish}`,
  );
  assert.ok(
    prepublish.indexOf('version-check.mjs') > prepublish.indexOf('pnpm test'),
    `版本校验必须排在全量测试之后，实际：${prepublish}`,
  );
});

test('校验脚本只读：连续运行两次，package.json 与 pnpm-lock.yaml 哈希不变', () => {
  const targets = ['package.json', 'pnpm-lock.yaml'];
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
