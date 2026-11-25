// 验收测试 —— 切片 v3-cicd-compat（specs/slices/v3-cicd-compat.md）
//
// 发布流水线（.github/workflows/release.yml）适配 v2 的 Git Tag 命名空间治理：
// 计划版本 tag（plan-<semver>/v<n>）能触发发布，且 tag 校验与
// scripts/tag-namespace.mjs 同源，不出现第二套判定。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v3-cicd-compat/acceptance.test.cjs
//
// 被测的是 workflow 声明（触发模式 / 调用方式 / 保留项）与真实脚本进程，
// 只在「校验命令本身」上真实执行（它是纯脚本，可本地跑），不模拟整套 Actions。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const SCRIPT = path.join(ROOT, 'scripts', 'tag-namespace.mjs');
const MAP = path.join(ROOT, 'scripts', 'tag-map.json');
const VERSION_CHECK = path.join(ROOT, 'scripts', 'version-check.mjs');

// 本片写集（specs/slices/v3-cicd-compat.md 的「范围」）。
const WRITE_SET = [
  '.github/workflows/release.yml',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
];

// 不得被本片改动的三文件（验收标准 7）。
const FROZEN_REFS = [
  'scripts/tag-namespace.mjs',
  'scripts/tag-map.json',
  'scripts/version-check.mjs',
];

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

/** 跑命名空间校验脚本（argv 传参，非交互），返回 { status, output }。 */
function runTagScript(args, input) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    output: (res.stdout || '') + (res.stderr || ''),
  };
}

/** workflow 文本里的 `run: |` shell 代码块（注释里的 plan- 示例不在此列）。 */
function runBodies(text) {
  const blocks = [];
  const re = /^ *run: \| *\r?$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    // 文件是 CRLF —— 按 \r\n 切，否则行尾留着 \r，
    // 「去注释」会把 \r 当普通字符、把行尾和下一行粘在一起。
    const lines = text.slice(start).split(/\r?\n/);
    const body = [];
    for (const line of lines) {
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      // shell 块是缩进的；回到同级 step（`- ` / step key）即结束。
      if (/^ {6}- /.test(line) || /^ {6}\w/.test(line) || /^ {4}\w/.test(line)) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks.join('\n');
}

/** glob（`*` 不跨 `/`，与 Actions filter 同口径）是否匹配 tag。 */
function globMatch(pattern, tag) {
  const rx =
    '^' +
    pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*') +
    '$';
  return new RegExp(rx).test(tag);
}

/** workflow 的 on.push.tags 列表（只取引号内的字面模式）。 */
function pushTagPatterns(text) {
  // 文件是 CRLF：`.*` 吃不到 `\r`，下一行就接不上 —— 显式吃 `\r?\n`。
  const m = /tags:\s*\r?\n((?:[ \t]*[-*].*(?:\r?\n)?)+)/.exec(text);
  assert.ok(m, 'release.yml 里必须有 on.push.tags 列表');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

// ─── 验收标准 1：触发条件覆盖命名空间形态，且不移除 semver 触发 ─────────────

test('触发条件覆盖 plan-<semver>/v<n>，且 v* 语义版本触发能力未被移除', () => {
  assert.ok(fs.existsSync(WORKFLOW), '.github/workflows/release.yml 必须存在');
  const text = readText(WORKFLOW);
  const patterns = pushTagPatterns(text);

  const nsHit = patterns.filter((p) => globMatch(p, 'plan-0.7.1/v1'));
  assert.ok(
    nsHit.length >= 1,
    `tags 列表必须含能匹配 plan-0.7.1/v1 的模式，实际: ${JSON.stringify(patterns)}`,
  );

  const semverHit = patterns.filter((p) => globMatch(p, 'v0.5.0'));
  assert.ok(
    semverHit.length >= 1,
    `原有的 v* 语义版本触发能力不得移除，实际: ${JSON.stringify(patterns)}`,
  );

  // 命名空间模式不得误伤：它不该匹配纯 semver tag 集合之外的裸 tag 语义——
  // 即 v* 仍是独立模式（两类触发并存，不是互相替代）。
  assert.ok(patterns.includes('v*'), '原 v* 模式必须原样保留');
});

// ─── 验收标准 2：调用唯一判据 + 保留版本号一致性保护 ────────────────────────

test('tag 校验既调用 scripts/tag-namespace.mjs，又保留版本号一致性比对', () => {
  const text = readText(WORKFLOW);
  assert.ok(
    text.includes('node scripts/tag-namespace.mjs'),
    'workflow 必须调用 node scripts/tag-namespace.mjs（命名合法性的唯一判据）',
  );

  // 版本号一致性保护**必须还在**。
  //
  // 为什么这条不能省（实测结论）：tag-namespace.mjs 按设计不管纯 semver tag 的
  // 版本一致性 —— `node scripts/tag-namespace.mjs v0.6.0` 在 package.json 为 0.7.1
  // 时退出码 0（checkTag 对 SEMVER_TAG 直接 return null）。
  // 若把这条也交给脚本，就等于静默削掉「发出去的包和仓库对不上」那条保护：
  // 打一个 v0.6.0 的 tag 就能把 0.7.1 的包发出去。
  assert.ok(text.includes('PKG='), 'workflow 必须仍取出 package.json 的版本号（PKG）');
  assert.ok(
    text.includes('${TAG_SEMVER}" != "${PKG}'),
    'workflow 必须仍做 tag 版本号与 package.json 版本号的比对（TAG_SEMVER vs PKG）',
  );

  // 而「旧写法」那种把版本号与 tag 整体相比的形态，允许保留 ——
  // 它恰恰是被删掉的那条保护，本片要恢复它，不是禁止它。
  // 只需保证它不是「唯一」的保护（脚本调用已在上面断言）。
});

// ─── 验收标准 2b：版本号比对对两种 tag 形态都生效 ────────────────────────────

test('版本号比对对纯 semver tag 与命名空间 tag 都生效（保护没被削弱）', () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
  const m = /^(\d+\.\d+\.\d+)/.exec(pkg.version || '');
  assert.ok(m, `package.json 的 version 应是 semver，实际：${pkg.version}`);
  const cur = m[1];

  // 从 workflow 里抽出那段比对逻辑，实跑五种 tag。
  //
  // 为什么要实跑而不是断言文本：这段 shell 的正确性全在 case/参数展开上，
  // 断言「文本里有某个字符串」证明不了它算得对。
  const body = extractVersionCompareBody(readText(WORKFLOW));
  assert.ok(body, 'workflow 里必须能抽出那段版本号比对逻辑');

  const cases = [
    { tag: `v${cur}`, expect: 0, why: '纯 semver tag，版本一致 → 放行' },
    { tag: 'v0.6.0', expect: 1, why: '纯 semver tag，版本不一致 → 拒绝（旧保护的核心）' },
    { tag: `plan-${cur}/v1`, expect: 0, why: '命名空间 tag，版本一致 → 放行' },
    { tag: 'plan-0.7.0/v1', expect: 1, why: '命名空间 tag，版本不一致 → 拒绝' },
    { tag: 'v1', expect: 1, why: '裸版本 tag，认不出版本号 → 拒绝' },
  ];

  for (const c of cases) {
    // **用位置参数传值，不用环境变量**；且**落成脚本文件**再跑，
    // 不走 `bash -c <body>` —— 理由见 materializeCompareScript 的注释。
    const script = materializeCompareScript(body, c.tag, cur);
    let res;
    try {
      res = spawnSync('bash', [script.rel, c.tag, cur], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } finally {
      script.cleanup();
    }
    assert.equal(
      res.status,
      c.expect,
      `tag=${c.tag} 期望退出码 ${c.expect}（${c.why}），实际 ${res.status}：\n${res.stdout}\n${res.stderr}`,
    );
  }
});

/**
 * 从 workflow 里抽出「版本号比对」那段 shell。
 *
 * 取法：找含 `TAG_SEMVER` 的 `run: |` 块，去掉命名空间脚本调用那几行
 * （那步是脚本的事，由另一条验收覆盖），保留比对逻辑。
 */
function extractVersionCompareBody(text) {
  const blocks = [];
  const re = /^ *run: \| *\r?$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    // 文件是 CRLF —— 必须按 \r\n 切，否则每行尾部留着 \r，
    // 后面「去注释」会把 \r 当普通字符、把行尾和下一行粘在一起。
    const lines = text.slice(start).split(/\r?\n/);
    const body = [];
    for (const line of lines) {
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      if (/^ {6}- /.test(line) || /^ {6}\w/.test(line) || /^ {4}\w/.test(line)) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  const target = blocks.find((b) => b.includes('TAG_SEMVER'));
  if (!target) return null;

  // 只留**可执行的比对逻辑**：
  //   · 去掉整行的注释（**只去整行注释** ——
  //     不能用 `#.*$` 就地截断：那会把 `${TAG#plan-}` 这种
  //     参数展开里的 `#` 当成注释起点，把代码截成
  //     `TAG_SEMVER="${TAG` —— bash 直接报「unexpected EOF」。
  //     注释里的 "semver" 这类词是**解释**不是判定，不能留在判据里。）
  //   · 去掉命名空间脚本调用那几行（那是脚本的事，由另一条验收覆盖）
  //   · 去掉 `PKG=$(node -p …)`（PKG 由本测试注入）
  //   · 去掉 `TAG="${GITHUB_REF_NAME}"`（TAG 由本测试注入）
  //
  // **故意保留** `if [ "${GITHUB_REF_TYPE}" = "tag" ]` 那层外壳 ——
  // 去掉它会留下一个落单的 `fi`（if/fi 不配对 → bash 语法错），
  // 测出来的会是「我的抽取器坏了」而不是「产品逻辑坏了」。
  // 那层的条件靠前置变量 GITHUB_REF_TYPE="tag" 满足。
  return target
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !l.startsWith('#'))
    .filter((l) => !l.includes('tag-namespace.mjs'))
    .filter((l) => !l.includes('PKG=$(node'))
    .filter((l) => !l.includes('GITHUB_REF_NAME'))
    .join('\n')
    .trim();
}

/**
 * 给抽出来的比对逻辑加一段「前置」，并写成临时脚本文件。
 *
 * 返回 { file, cleanup } —— 调用方用完必须 cleanup()。
 *
 * **为什么不就地替换 `${TAG}` → `"$1"`**：
 * 那样改会把 `${TAG#plan-}` / `${TAG#v}` 这两种**带后缀的参数展开**漏掉
 * （`${TAG}` 匹配不到它们），于是 case 分支里的 TAG 仍是未定义变量。
 *
 * **为什么要落成文件、而不是 `bash -c <body>`**：
 * 这台机器上的 `bash` 是 **WSL 的 bash**（`x86_64-pc-linux-gnu`），
 * 它对 `bash -c` 的**位置参数**处理与 Git Bash / Linux 不一致 ——
 * 实测 `bash -c 'echo [$1]' probe hello` 输出空，而把同样的脚本
 * 写进文件 `bash file.sh hello` 则正常。
 * 走「文件 + 位置参数」这条路，三种 bash 实现行为一致。
 */
function materializeCompareScript(body, tag, pkg) {
  // 脚本落在**仓库内的相对路径**下，不能用 os.tmpdir() 的绝对路径 ——
  // 这台机器上的 bash 是 WSL 的 bash，它认的是 /mnt/c/... 这种挂载路径，
  // 拿 Windows 绝对路径去调会得到 exit 127（command not found）。
  // 相对路径在 WSL bash / Git Bash / Linux CI 三处都成立。
  const dir = path.join(ROOT, '.zelto', 'tmp-v3cicd');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compare.sh');
  const prologue = ['GITHUB_REF_TYPE="tag"', 'TAG="$1"', 'PKG="$2"'].join('\n');
  fs.writeFileSync(file, `${prologue}\n${body}\n`, 'utf8');
  return {
    file,
    // 相对 ROOT 的路径 —— 传给 bash 时用这个。
    rel: path.relative(ROOT, file).split(path.sep).join('/'),
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录残留不影响判据 */
      }
    },
  };
}

// ─── 验收标准 3：非法命名 → 中止且指出命名空间问题 ───────────────────────────

test('命名空间校验失败时发布中止，错误信息指出命名空间/非法命名', () => {
  // 与 workflow 同一条命令（管道喂入待校验 tag，非交互）。
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'v1\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = (res.stdout || '') + (res.stderr || '');
  assert.notEqual(res.status, 0, `非法裸 tag v1 应非零退出，实际 ${res.status}：\n${output}`);
  assert.ok(
    /命名|非法/.test(output),
    `错误信息必须指出是命名空间/非法命名问题：\n${output}`,
  );
});

// ─── 验收标准 4：合法 tag → 不阻断 ───────────────────────────────────────────

test('命名空间校验通过时不阻断：合法 tag 退出码为 0', () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
  const m = /^(\d+\.\d+\.\d+)/.exec(pkg.version || '');
  assert.ok(m, `package.json 的 version 应是 semver，实际：${pkg.version}`);
  const res = runTagScript([`plan-${m[1]}/v1`, 'v0.6.0']);
  assert.equal(res.status, 0, `合法 tag 应退出 0，实际 ${res.status}：\n${res.output}`);
});

// ─── 验收标准 5：不引入第二套命名合法性判定 ──────────────────────────────────

test('发布流水线不引入第二套命名合法性判定规则', () => {
  const text = readText(WORKFLOW);
  // **只看可执行代码，不看注释** ——
  // 注释里出现「semver」「非法」这类词是**解释**（「为什么不能省这条保护」），
  // 不是判定。判据若把注释也算进去，就会逼着人把解释删掉 ——
  // 那等于让后来人失去「为什么」的上下文，正是最该留住的东西。
  const shells = runBodies(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !l.startsWith('#'))
    .join('\n');

  // **判定**与**提取**要分清（见规格验收标准 5 的说明）：
  //   · 提取 —— 从 tag 里取出 semver（`plan-<semver>/v<n>` / `v<semver>` 各怎么取），
  //     跑在脚本已判合法之后，允许留在 workflow 里；
  //   · 判定 —— 「什么形态算合法」，唯一来源是 scripts/tag-namespace.mjs，
  //     workflow 里不得出现。
  //
  // 所以这条断言的是：**workflow 里没有对形态下结论**。
  // 判据：不得出现针对形态的结论词，也不得出现形态正则。

  // 形态正则 —— 那是「判定形态」的典型写法。
  assert.ok(!/\\d/.test(shells), '校验 shell 里不得手写 \\d 这类形态正则');
  assert.ok(!/\[0-9\]/.test(shells), '校验 shell 里不得手写 [0-9] 这类形态正则');
  assert.ok(
    !/semver/i.test(shells.replace(/TAG_SEMVER/g, '')),
    '校验 shell 里不得手写 semver 形态判定（那是脚本的事）',
  );

  // 结论词 —— 出现即说明 workflow 在自己判「这个形态合不合法」。
  for (const word of ['非法', '不合法']) {
    assert.ok(
      !shells.includes(word),
      `校验 shell 里不得对形态下结论（出现了「${word}」）—— 判定只在 tag-namespace.mjs 里`,
    );
  }

  // 映射表是脚本的职责，workflow 不得直读。
  assert.ok(!shells.includes('tag-map'), '校验 shell 里不得直读 tag-map（那是脚本的事）');

  // 反向保证：命名空间的**唯一**判据确实被调用了（不然上面几条就成了空转）。
  assert.ok(
    shells.includes('tag-namespace.mjs'),
    '命名合法性必须由 scripts/tag-namespace.mjs 判定',
  );
});

// ─── 验收标准 6：其余行为保持不变 ────────────────────────────────────────────

test('其余行为保持不变：打包、发布与发布状态回写步骤仍在', () => {
  const text = readText(WORKFLOW);
  for (const step of [
    '编码与凭据扫描',
    '验证发布产物装出来能用',
    '发布到 npm',
    '更新发布状态并提交',
    '仅打包（dry run）',
  ]) {
    assert.ok(text.includes(step), `步骤必须保留：${step}`);
  }
  for (const keep of [
    'npm publish --provenance',
    'release-status.json',
    'pnpm build',
    'pnpm lint',
    'pnpm test',
    'npm publish --dry-run',
    'actions/checkout@v4',
    'fetch-depth: 0',
  ]) {
    assert.ok(text.includes(keep), `关键行为必须保留：${keep}`);
  }
});

// ─── 验收标准 7：三文件哈希不变（写集边界） ──────────────────────────────────

test('不修改三文件：tag-namespace / tag-map / version-check 无改动', () => {
  for (const rel of FROZEN_REFS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 必须存在`);
  }
  // tag-map 仍是合法扁平映射（内容正确性不因本片改变）。
  const map = JSON.parse(readText(MAP));
  for (const oldName of ['v1', 'v2', 'v3']) {
    assert.ok(Object.prototype.hasOwnProperty.call(map, oldName), `映射必须含旧名 ${oldName}`);
  }

  const porcelain = gitOut(['status', '--porcelain', '--untracked-files=all']).map((l) =>
    l.slice(3).replace(/\/+$/, ''),
  );
  const diffNames = new Set([
    ...gitOut(['diff', 'HEAD', '--name-only']),
    ...gitOut(['diff', '--cached', '--name-only']),
  ]);
  for (const rel of FROZEN_REFS) {
    assert.ok(
      !porcelain.some((p) => p === rel || p.startsWith(rel + '/')),
      `${rel} 不得有未提交改动`,
    );
    assert.ok(!diffNames.has(rel), `${rel} 不得有相对 HEAD 的改动`);
  }

  // 本片改动只在写集内（片外既有状态除外：规格文件由流程落盘）。
  const KNOWN_OUT_OF_SCOPE = new Set(['specs/slices/v3-cicd-compat.md']);
  const writeSetFiles = new Set(WRITE_SET);
  const changed = [
    ...gitOut(['diff', 'HEAD', '--name-only']),
    ...gitOut(['ls-files', '--others', '--exclude-standard']),
  ]
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const outside = changed.filter(
    (p) =>
      !writeSetFiles.has(p) &&
      ![...writeSetFiles].some((w) => w.startsWith(p + '/')) &&
      !KNOWN_OUT_OF_SCOPE.has(p) &&
      // 主仓既有脏状态（本片开工前已存在，非本片产物）。
      p !== 'policy/policy.yaml' &&
      p !== 'policy/lock.json' &&
      p !== 'src/cli/commands/design-patch.ts' &&
      !p.startsWith('docs/adr/adr-109-'),
  );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});
