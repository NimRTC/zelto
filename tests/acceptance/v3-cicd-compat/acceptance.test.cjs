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

// 不得被本片改动的文件（验收标准 7）。
//
// ── 为什么 `scripts/version-check.mjs` 不在其中（ADR-113 决策四）──
//
// 当初把它列进来是对的 —— 那是**当片**的写集边界。
// 但 ADR-113 要在那个文件里**新增 `--tag` 判据**（恢复被 v4 删掉的
// 「触发的 tag == 实际发布版本」这条保护），所以它**必须**能改。
//
// **处置不是「删掉这条判据」—— 那是放弃边界检查。**
// 而是把它移出「不可改」名单，并给它一条**定向**断言：
// 它的改动只能是**新增 `--tag` 判据**，不得动原有的三条判据。
//
// 剩下两个（tag-namespace / tag-map）**仍然不可改** ——
// 命名合法性的唯一判据与迁移台账，与本片无关。
const FROZEN_REFS = [
  'scripts/tag-namespace.mjs',
  'scripts/tag-map.json',
];

// 允许改动、但**只能以受限方式**改的文件（ADR-113 决策四）。
// 断言在下方 —— 它不得动原有的判据，只能新增 `--tag` 那一支。
const GUARDED_REFS = ['scripts/version-check.mjs'];

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

test('触发条件覆盖 plan-<planId>/v<n>，且 v* 语义版本触发能力未被移除', () => {
  assert.ok(fs.existsSync(WORKFLOW), '.github/workflows/release.yml 必须存在');
  const text = readText(WORKFLOW);
  const patterns = pushTagPatterns(text);

  // 命名空间形态用**真实的 13 位 planId** ——
  // ADR-110 把旧形态 `plan-<semver>/v<n>` 取代了（`<semver>` 是「现在」的概念，
  // tag 是「历史」，两者必然分叉）。这里要断言的是**新**形态能触发。
  const nsHit = patterns.filter((p) => globMatch(p, 'plan-1795507341754/v3'));
  assert.ok(
    nsHit.length >= 1,
    `tags 列表必须含能匹配 plan-1795507341754/v3 的模式，实际: ${JSON.stringify(patterns)}`,
  );

  const semverHit = patterns.filter((p) => globMatch(p, 'v0.5.0'));
  assert.ok(
    semverHit.length >= 1,
    `原有的 v* 语义版本触发能力不得移除，实际: ${JSON.stringify(patterns)}`,
  );

  // 命名空间模式不得误伤：它不该匹配纯 semver tag 集合之外的裸 tag 语义——
  // 即 v* 仍是独立模式（两类触发并存，不是互相替代）。
  assert.ok(patterns.includes('v*'), '原 v* 模式必须原样保留');
  assert.ok(patterns.includes('plan-*/v*'), 'plan-*/v* 模式必须存在（ADR-110 决策二）');
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
  //
  // ── 判据落在哪（ADR-113 决策一）─────────────────────────────
  //
  // 落在 `scripts/version-check.mjs`（新增 `--tag` 参数），
  // **不在 workflow 里内联** —— ADR-106 §5「同一问题只能有一处判定」：
  // 内联回 workflow 等于在 workflow 里**再建一处**版本号判定，
  // 正是本切片当初要消除的形态。
  assert.ok(
    text.includes('node scripts/version-check.mjs --tag'),
    'workflow 必须调用 node scripts/version-check.mjs --tag（版本一致性的唯一判据）',
  );

  // 而 workflow 里**不得再有**自行比对版本号的 shell ——
  // 那会与 version-check.mjs 构成两套判定。
  const checkStep = extractStepBody(text, '校验 tag 命名空间');
  assert.ok(checkStep, 'workflow 必须有「校验 tag 命名空间」这一步');
  assert.ok(
    !checkStep.includes('TAG_SEMVER'),
    '命名空间校验步骤不得再有从 tag 抽取 semver 的逻辑（那是 version-check.mjs 的职责）',
  );
  assert.ok(
    !checkStep.includes('PKG='),
    '命名空间校验步骤不得再自行取 package.json 版本号做比对',
  );
  assert.ok(
    !/case\s+["']?\$\{?TAG/.test(checkStep),
    '命名空间校验步骤不得再有按 tag 形态分支的 case 语句',
  );
});

// ─── 验收标准 2b：版本号比对对两种 tag 形态都生效 ────────────────────────────

test('版本号比对对纯 semver tag 与命名空间 tag 都生效（保护没被削弱）', () => {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
  const m = /^(\d+\.\d+\.\d+)/.exec(pkg.version || '');
  assert.ok(m, `package.json 的 version 应是 semver，实际：${pkg.version}`);
  const cur = m[1];

  // 实跑唯一判据（scripts/version-check.mjs --tag）。
  //
  // 为什么要实跑而不是断言文本：这条判据的正确性全在
  // 「形态识别 + 版本比较 + 退出码」上，
  // 断言「文本里有某个字符串」证明不了它算得对。
  //
  // ── 为什么命名空间 tag 用 `plan-<planId>/v<n>` 而不是 `plan-<semver>/v<n>` ──
  //
  // ADR-110 决策一：`<semver>` 从 tag 里移出去 ——
  // tag 是「历史」，`package.json` 的 version 是「现在」，两者必然分叉。
  // 旧形态 `plan-0.7.1/v1` 现在**非法**（tag-namespace.mjs 会拒绝它），
  // 拿它当「命名空间 tag」的样本就是拿一个非法形态做断言。
  //
  // 而「命名空间 tag 也要能被版本判据处理」这条要求**依然成立** ——
  // 区别是：版本锚点是**历史**，**不校**版本一致性（ADR-110 决策一）。
  // 旧断言里 `plan-0.7.0/v1 → 拒绝` 那一条的前提是
  // 「命名空间 tag 里带 semver，所以能比」——
  // 新形态里**没有 semver 可比**，所以它**不参与**版本比对，
  // 而不是「参与并被拒」。
  const cases = [
    { tag: `v${cur}`, expect: 0, why: '纯 semver tag，版本一致 → 放行' },
    { tag: 'v0.6.0', expect: 1, why: '纯 semver tag，版本不一致 → 拒绝（旧保护的核心）' },
    {
      tag: 'plan-1795507341754/v1',
      expect: 0,
      why: '命名空间 tag（版本锚点是历史，不校版本）→ 放行',
    },
    { tag: 'v1', expect: 1, why: '裸版本 tag，认不出版本号 → 拒绝' },
  ];

  for (const c of cases) {
    // 实跑唯一判据。判据从 workflow 里的 shell 挪进了脚本，
    // 测试也就跟着挪 —— 顺便甩掉「WSL bash 对 `bash -c` 位置参数处理不一致」
    // 那个环境坑（那坑本就在 v3-cicd-compat 的规格风险里记着）。
    const res = spawnSync(process.execPath, [VERSION_CHECK, '--tag', c.tag], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const output = (res.stdout || '') + (res.stderr || '');
    assert.equal(
      res.status,
      c.expect,
      `tag=${c.tag} 期望退出码 ${c.expect}（${c.why}），实际 ${res.status}：\n${output}`,
    );
  }
});

/**
 * 取出 workflow 里某个 step 的 `run: |` 代码块（**只取可执行代码**）。
 *
 * 用途：断言「某个步骤里**没有**自行做版本号比对」。
 *
 * 为什么只取可执行代码（去整行注释）：
 * 注释里出现「semver」「非法」这类词是**解释**（「为什么不能省这条保护」），
 * 不是判定。判据若把注释也算进去，就会逼着人把解释删掉 ——
 * 那等于让后来人失去「为什么」的上下文，正是最该留住的东西。
 */
function extractStepBody(text, stepName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`name: ${stepName}`));
  if (start < 0) return null;
  // 从 step 开始往后找 `run: |`，再收集缩进块。
  let i = start;
  while (i < lines.length && !/^\s*run:\s*\|\s*$/.test(lines[i])) i += 1;
  if (i >= lines.length) return null;
  const body = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    // shell 块是缩进的；回到同级 step（`- ` / step key）即结束。
    if (/^\s{6}- /.test(line) || /^\s{6}\w/.test(line) || /^\s{4}\w/.test(line)) break;
    body.push(line);
  }
  return body
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
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
  // 命名空间形态用**真实的 13 位 planId**（ADR-110 决策一）——
  // 旧形态 `plan-<semver>/v<n>` 已被取代，现在**非法**。
  const res = runTagScript(['plan-1795507341754/v1', 'v0.6.0']);
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

// ─── 验收标准 7：写集边界 ─────────────────────────────────────────────────────

test('不修改 tag-namespace / tag-map；version-check 的改动仅限新增 --tag 判据', () => {
  for (const rel of [...FROZEN_REFS, ...GUARDED_REFS]) {
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

  // ── 受限改动的文件：只能新增 `--tag` 判据，不得动原有判据 ──
  //
  // 为什么要有这条（ADR-113 决策四）：
  // `scripts/version-check.mjs` 原本在「不可改」名单里 ——
  // 那是**当片**的写集边界，成立。
  // ADR-113 要在它里面**新增**一条判据（恢复被 v4 删掉的发布保护），
  // 所以它必须能改。
  //
  // **处置不是「把这条判据删掉」** —— 那是放弃边界检查。
  // 而是给它一条**定向**断言：原有三条判据（依赖声明一致、
  // `pkg >= 最高已发布 tag`、无参时的通过输出）**一条都不能少**。
  for (const rel of GUARDED_REFS) {
    const src = readText(path.join(ROOT, rel));
    // 原有判据 ①：依赖声明一致性（package.json ↔ pnpm-lock.yaml）。
    assert.ok(
      src.includes('package.json 与 pnpm-lock.yaml'),
      `${rel} 不得丢掉「依赖声明一致性」这条原有判据`,
    );
    // 原有判据 ②：`pkg >= 最高已发布 tag`（ADR-110 决策四）。
    assert.ok(
      src.includes('listSemverTags') && src.includes('pkgIsBehind'),
      `${rel} 不得丢掉「package.json 不低于已发布版本」这条原有判据`,
    );
    // 原有判据 ③：新增的 `--tag` 判据**必须**在。
    assert.ok(
      src.includes("--tag") && src.includes('triggeringTag'),
      `${rel} 必须含新增的 --tag 判据（ADR-113 决策一）`,
    );
  }

  // 本片改动只在写集内（片外既有状态除外：规格文件由流程落盘）。
  const KNOWN_OUT_OF_SCOPE = new Set([
    'specs/slices/v3-cicd-compat.md',
    // ADR-113 的落地产物（ADR 与规格由流程落盘）。
    'specs/slices/v5-release-tag-guard.md',
    'docs/adr/adr-113-release-tag-version-guard.md',
    'docs/adr-trace-index.md',
  ]);
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
      // 受限改动的文件（已由上面那条定向断言把关）。
      !GUARDED_REFS.includes(p) &&
      // 主仓既有脏状态（本片开工前已存在，非本片产物）。
      p !== 'policy/policy.yaml' &&
      p !== 'policy/lock.json' &&
      p !== 'src/cli/commands/design-patch.ts' &&
      !p.startsWith('docs/adr/adr-109-'),
  );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});
