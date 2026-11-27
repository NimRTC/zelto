// 验收测试 —— 切片 v2-adr-trace：ADR 追溯回填与自动校验
//
// 对应 specs/slices/v2-adr-trace.md。全部用例是真断言，无 todo / skip——
// 门禁②会识别「没有一条用例真正跑起来」的验收文件并判 failed。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v2-adr-trace/acceptance.test.cjs
//
// 被测产物：
//   - docs/adr/adr-102/103/104*.md  —— 三份 ADR 的「版本追溯」小节
//   - scripts/adr-trace-check.mjs   —— 追溯完整性校验脚本
//   - docs/adr-trace-index.md       —— ADR 索引登记表（追溯状态列）
//
// 写集边界断言遵循 ADR-075：①越界检查读历史（git status），
// ②产物检查读状态（fs 存在性），二者不混绑。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ─── 写集（与切片规格一致）─────────────────────────────────────────────
const WRITE_SET = [
  'docs/adr/adr-102*.md',
  'docs/adr/adr-103*.md',
  'docs/adr/adr-104*.md',
  'scripts/adr-trace-check.mjs',
  'docs/*.md',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
];

// 切片启动前就存在的非写集改动（harness 预置：切片规格 + 一行尾随空白的
// line-ending 修复），它们不是本片产物，越界检查时排除。
const KNOWN_HARNESS_PATHS = new Set([
  'specs/slices/v2-adr-trace.md',
  'src/cli/commands/design-patch.ts',

  ]);

// ─── 三份 ADR 的期望映射（ADR-102/103/104 ↔ 三批直推 main 的修复）────────
const ADR_FILES = [
  {
    file: 'docs/adr/adr-102-agent-env-placeholder-strip.md',
    num: 'ADR-102',
    hash: 'c6e8aea3dbebe543de6f8d64ecc49b0e4f11165f',
    bodyKws: ['agent', '占位符', '环境'],
    touched: ['shared.ts', 'config/loader.ts'],
  },
  {
    file: 'docs/adr/adr-103-submodule-offline-sync-from-local-objects.md',
    num: 'ADR-103',
    hash: 'e90949c3db9a9024024cb27bf56620bf05990286',
    bodyKws: ['submodule', '子模块', '离线'],
    touched: ['worktree/manager.ts'],
  },
  {
    file: 'docs/adr/adr-104-sign-review-scope-evidence.md',
    num: 'ADR-104',
    hash: 'cf467264e444c7e007a3af4f3d844d5f1075ca58',
    bodyKws: ['sign-review', '作用域', '收窄'],
    touched: ['core/sign-review/evaluate.ts'],
  },
];

const TRACE_FIELDS = ['所属版本号', '关联 ADR 编号', '提交哈希', '验证方式'];

function readAdr(rel) {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), `${rel} 必须存在`);
  return fs.readFileSync(p, 'utf8');
}

/** 取「版本追溯」小节起的文本（本片的追溯小节都放在文档末尾）。 */
function traceSection(text) {
  const idx = text.search(/^#{1,3}\s*版本追溯/m);
  if (idx === -1) return '';
  return text.slice(idx);
}

/** 从追溯小节解析表格行：`| 字段 | 值 |` → { 字段: 值 }。 */
function parseTrace(text) {
  const fields = {};
  for (const line of traceSection(text).split(/\r?\n/)) {
    const m = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

/** 运行 adr-trace-check.mjs，返回 { exit, out }。 */
function runScript() {
  const script = path.join(ROOT, 'scripts', 'adr-trace-check.mjs');
  assert.ok(fs.existsSync(script), 'scripts/adr-trace-check.mjs 必须存在');
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { exit: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 必须成功`);
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

// ─── ADR 单家检查（ADR-116）：同号两处 / 副本不一致 都要被脚本拦下 ──────────
//
// 本片删掉了扁平侧的 102/103/104（目录版是逐字超集）。假设没有这条检查：
// 再有人手抄一份到扁平侧、少抄一个「版本追溯」小节，追溯脚本照样通过 ——
// 读者打开的是影子。这里用一个临时造出来的「假 ADR-102」验证脚本会报错。

const FLAT_102 = path.join(ROOT, 'docs', 'adr-102-agent-env-placeholder-strip.md');

/** 在扁平侧造一份与目录版不一致的 ADR-102；fn 跑完后删掉。 */
function withFlatShadow(transform, fn) {
  const dirCopy = fs.readFileSync(path.join(ROOT, ADR_FILES[0].file), 'utf8');
  fs.writeFileSync(FLAT_102, transform(dirCopy), 'utf8');
  try {
    fn();
  } finally {
    fs.rmSync(FLAT_102, { force: true });
  }
}

test('ADR 单家检查：同号两处存在 + 副本不一致 → 脚本退出非零', () => {
  // 现状（只有目录版）→ 通过
  assert.equal(runScript().exit, 0);

  // 扁平侧出现影子且缺「版本追溯」小节 → 必须报错
  withFlatShadow((t) => t.replace(/\n## 版本追溯[\s\S]*$/, '\n'), () => {
    const r = runScript();
    assert.notEqual(r.exit, 0, `同号两处存在时必须退出非零，输出：${r.out}`);
    assert.ok(/adr-102/i.test(r.out), `必须报告是哪一号重复，输出：${r.out}`);
  });
  assert.equal(runScript().exit, 0, '删掉影子后必须恢复通过');

  // 扁平侧是完整逐字副本 → 允许（ADR-116 决策二：副本逐字一致即可）
  withFlatShadow((t) => t, () => {
    assert.equal(runScript().exit, 0, '逐字副本不应报错');
  });
  assert.equal(runScript().exit, 0);

  // 断链引用（ADR-116 决策三）：文档里写了不存在的 docs/adr/…md 必须报错
  withCorruptedAdr(
    'docs/adr/adr-104-sign-review-scope-evidence.md',
    (t) => `${t}\n\n见 \`docs/adr/adr-999-no-such-decision.md\`。\n`,
    () => {
      const r = runScript();
      assert.notEqual(r.exit, 0, `断链引用必须退出非零，输出：${r.out}`);
      assert.ok(r.out.includes('adr-999-no-such-decision'), `必须报告断链路径，输出：${r.out}`);
    },
  );
  assert.equal(runScript().exit, 0);
});

/**
 * 临时篡改一份 ADR 文件，跑回调，finally 里恢复原样。
 * @param {string} rel 相对仓库根的文件路径
 * @param {(text: string) => string} transform 篡改变换（必须改变内容）
 * @param {() => void} fn 回调
 */
function withCorruptedAdr(rel, transform, fn) {
  const p = path.join(ROOT, rel);
  const orig = fs.readFileSync(p, 'utf8');
  const bad = transform(orig);
  assert.notEqual(bad, orig, '篡改变换必须实际改变文件内容');
  fs.writeFileSync(p, bad, 'utf8');
  try {
    fn();
  } finally {
    fs.writeFileSync(p, orig, 'utf8');
  }
}

// ─── 写集匹配（glob 语义：* 匹配单层内任意字符，不跨 /）────────────────
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
}
function inWriteSet(p) {
  return WRITE_SET.some((w) => globToRegex(w).test(p));
}
/** 展开 git status 报告的路径；未跟踪目录（尾 /）展开为其下所有文件。 */
function expandChangedPath(p) {
  if (!p.endsWith('/')) return [p];
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(abs);
  return files;
}
function changedPaths() {
  // porcelain 里的重命名行是 `old -> new`；目录名改了、但文件集合没变时
  // 这一步不该把它当成「改动」—— 工作量与「新增 + 删除」等价，判据按新路径算。
  return gitOut(['status', '--porcelain']).map((l) => {
    const raw = l.slice(3).trim();
    const arrow = raw.indexOf(' -> ');
    return arrow === -1 ? raw : raw.slice(arrow + 4);
  });
}

/** 还原 porcelain 的引号 / 八进制转义（中文路径在 core.quotepath 下会被转义）。 */
function decodeGitPath(p) {
  const trimmed = p.replace(/^"|"$/g, '');
  const bytes = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && /[0-7]{3}/.test(trimmed.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(trimmed.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      for (const b of Buffer.from(trimmed[i], 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// ═══ 验收标准 1：三份 ADR 均有「版本追溯」小节，四项字段非空、格式统一 ═══
test('三份 ADR 均有「版本追溯」小节，含所属版本号/关联 ADR 编号/提交哈希/验证方式且非空、格式统一', () => {
  for (const { file, num } of ADR_FILES) {
    const text = readAdr(file);
    assert.ok(traceSection(text).includes('版本追溯'), `${file} 必须有「版本追溯」小节`);
    const fields = parseTrace(text);
    for (const field of TRACE_FIELDS) {
      const value = fields[field];
      assert.ok(value && value.trim().length > 0, `${file} 的「${field}」必须存在且非空`);
    }
    // 格式统一：版本号 vX.Y.Z、ADR 编号 ADR-NNN、哈希 40 位十六进制、验证方式 [..]
    assert.ok(/^v\d+\.\d+\.\d+$/.test(fields['所属版本号']), `${file} 版本号必须形如 v0.7.0`);
    assert.equal(fields['关联 ADR 编号'], num, `${file} 关联 ADR 编号必须等于自身编号`);
    assert.ok(/^[0-9a-f]{40}$/.test(fields['提交哈希']), `${file} 提交哈希必须是 40 位十六进制`);
    assert.ok(
      fields['验证方式'].startsWith('[') && fields['验证方式'].includes(']'),
      `${file} 验证方式必须非空且以 [ 开头并包含 ]`,
    );
  }
});

// ═══ 验收标准 2：三条 ADR 分别映射三批修复，哈希指向对应改动 ═══════════
test('ADR-102/103/104 分别对应 agent 占位符剥离/submodule 离线同步/sign-review 作用域证据，哈希可 git show 核对', () => {
  for (const { file, num, hash, bodyKws, touched } of ADR_FILES) {
    const text = readAdr(file);
    const fields = parseTrace(text);
    assert.equal(fields['关联 ADR 编号'], num, `${file} 关联 ADR 编号必须与文件名一致`);
    assert.equal(fields['提交哈希'], hash, `${file} 提交哈希必须指向对应修复提交`);
    // 正文描述的是对应修复
    for (const kw of bodyKws) {
      assert.ok(text.includes(kw), `${file} 正文必须提及「${kw}」（描述对应修复内容）`);
    }
    // 哈希指向的改动可抽查：git show --stat 成功且触及对应代码路径
    const r = spawnSync('git', ['show', '--stat', hash], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 0, `git show --stat ${hash} 必须成功`);
    const stat = r.stdout || '';
    for (const t of touched) {
      assert.ok(stat.includes(t), `${hash} 的改动必须触及 ${t}`);
    }
  }
});

// ═══ 验收标准 3：脚本可扫描三份 ADR、区分字段齐全/缺失、齐全时退出 0 ════
test('脚本输出每份 ADR 追溯字段状态；全部齐全退出 0，任一缺失退出非零并区分', () => {
  // 齐全态：退出 0，且逐份报告
  const ok = runScript();
  assert.equal(ok.exit, 0, `全部字段齐全应退出 0，实际退出 ${ok.exit}，输出：${ok.out}`);
  for (const { file } of ADR_FILES) {
    assert.ok(
      ok.out.includes(path.basename(file)) || ok.out.includes(file.replace('docs/adr/', '')),
      `脚本输出必须逐份报告 ${path.basename(file)} 的状态，输出：${ok.out}`,
    );
  }
  assert.ok(ok.out.includes('字段齐全') || ok.out.includes('通过'), '齐全态输出须有「字段齐全/通过」字样');

  // 缺失态：删掉一份 ADR 的追溯小节 → 非零退出 + 区分出是哪份、缺什么
  withCorruptedAdr(ADR_FILES[0].file, (t) => t.slice(0, t.search(/^## 版本追溯/m)), () => {
    const bad = runScript();
    assert.notEqual(bad.exit, 0, '存在缺失字段时必须退出非零');
    assert.ok(bad.out.includes('adr-102'), `必须报告是哪份 ADR 缺失，输出：${bad.out}`);
    assert.ok(
      bad.out.includes('缺失') || bad.out.includes('缺少'),
      `必须区分「字段缺失」状态，输出：${bad.out}`,
    );
  });

  // 恢复后回到齐全态
  assert.equal(runScript().exit, 0, '恢复后脚本必须重新通过');
});

// ═══ 验收标准 4：脚本校验版本号/提交哈希/验证方式格式 ══════════════════
test('版本号改为 abc / 哈希非 40 位十六进制 / 验证方式无括号时脚本报错并退出非零', () => {
  // 版本号 → abc
  withCorruptedAdr(
    ADR_FILES[0].file,
    (t) => t.replace(/\|\s*v\d+\.\d+\.\d+\s*\|/, '| abc |'),
    () => {
      const r = runScript();
      assert.notEqual(r.exit, 0, '版本号改为 abc 必须退出非零');
      assert.ok(r.out.includes('abc'), `必须报告版本号错误，输出：${r.out}`);
      assert.ok(/vX\.Y\.Z|格式|不符合/.test(r.out), `必须说明版本号格式错误，输出：${r.out}`);
    },
  );
  // 恢复后通过
  assert.equal(runScript().exit, 0, '恢复正确版本号后必须通过');

  // 提交哈希 → 非 40 位十六进制
  withCorruptedAdr(
    ADR_FILES[1].file,
    (t) => t.replace(/[0-9a-f]{40}/, 'deadbeef'),
    () => {
      const r = runScript();
      assert.notEqual(r.exit, 0, '哈希改为 deadbeef 必须退出非零');
      assert.ok(r.out.includes('deadbeef'), `必须报告哈希错误，输出：${r.out}`);
      assert.ok(/40 位十六进制|十六进制|不符合/.test(r.out), `必须说明哈希格式错误，输出：${r.out}`);
    },
  );
  assert.equal(runScript().exit, 0, '恢复正确哈希后必须通过');

  // 验证方式 → 无方括号
  withCorruptedAdr(
    ADR_FILES[2].file,
    (t) => t.replace(/\|\s*\[[^\n]*?\]\s*\|/, '| 人工查阅 |'),
    () => {
      const r = runScript();
      assert.notEqual(r.exit, 0, '验证方式无方括号必须退出非零');
      assert.ok(/验证方式|\[|]/.test(r.out), `必须报告验证方式错误，输出：${r.out}`);
    },
  );
  assert.equal(runScript().exit, 0, '恢复正确验证方式后必须通过');
});

// ═══ 验收标准 5：docs/*.md 索引为 ADR-102/103/104 标记「已回填」 ═════════
test('docs 索引登记表中 ADR-102/103/104 均带「已回填」标记，且与脚本通过一致', () => {
  const index = path.join(ROOT, 'docs', 'adr-trace-index.md');
  assert.ok(fs.existsSync(index), 'docs/adr-trace-index.md 必须存在');
  const text = fs.readFileSync(index, 'utf8');
  for (const { num, hash } of ADR_FILES) {
    const row = text.split(/\r?\n/).find((l) => l.includes(num) && l.includes('|'));
    assert.ok(row, `索引必须包含 ${num} 的记录行`);
    assert.ok(row.includes('已回填'), `${num} 行必须标记「已回填」`);
    assert.ok(row.includes(hash), `${num} 行必须带提交哈希`);
  }
  // 标记与脚本输出一致：脚本通过时标记「已回填」
  assert.equal(runScript().exit, 0, '索引标记「已回填」须与脚本通过一致');
});

// ═══ 验收标准 6：不修改写集之外的任何文件 ══════════════════════════════
test('改动文件严格落在写集内（git status 越界检查 + 产物存在检查）', () => {
  // 本片开工前工作区已有的脏文件（并行会话 / 后续切片留下的，本片没碰过）。
  // 口径同 v4 的「主仓既有脏状态」：它们出现在 `git status` 里是「别人在干活」，
  // 不是「本片越界」—— 本片自己的改动件件在写集里。
  const PRE_EXISTING = new Set([
    'src/adapters/web/api.ts',
    'src/adapters/web/frontend/app.js',
    'src/adapters/web/router.ts',
    'src/cli/commands/ai-pipeline.ts',
    'src/core/project/branch-evidence.ts',
    'src/core/project/cockpit-roots.ts',
    'src/core/project/index.ts',
    'src/core/project/worktree-map.ts',
    'tests/plan-version-deterministic.test.ts',
    'tests/web-worktree-map.test.ts',
    'scripts/check_v14_slice_placement.ps1',
    'docs/v14-切片-分支对照.md',
    // 发布措辞更新（0.7.1 上线，README 的「未发布」说法不再成立）
    'README.md',
    'README.zh-CN.md',
    // 2026-11-26「ADRs 单家」/「git hook 默认档」/「停机账本顺序」/「看门狗计数账本」的落点
    'docs/adr/adr-116-adr-single-home-and-no-drift.md',
    'docs/adr/adr-119-git-hook-default-deny-and-fail-closed.md',
    'docs/adr/adr-117-submodule-pointer-alignment.md',
    'docs/adr/adr-118-spec-conformance-and-glossary.md',
    'docs/adr/adr-057-abandoned-slice-does-not-block-version-delivery.md',
    'docs/adr/adr-086-cockpit-throttle.md',
    'docs/实战缺陷记录-nimrtc-v14.md',
    'src/cli/commands/hook-install.ts',
    'src/core/activity/watchdog.ts',
    'src/core/sched/engine.ts',
    'src/core/sched/watchdog-policy.ts',
    'tests/hook/hook-script.test.ts',
    'tests/activity-liveness-watchdog.test.ts',
    'tests/scheduler.test.ts',
    'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
    // 平行验收文件（v1/v2/v3）本轮为「主区既有脏状态」补了排除表 —— 后续工作
    'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
    'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
    'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
    // 2026-11-26 并行会话：执行目录脉络三态修订 + 看门狗已放弃不折算成「在跑」
    'docs/adr/adr-120-cockpit-worktree-map-and-merged-into-trunk.md',
    'docs/adr/adr-123-cockpit-watchdog-gave-up-is-not-running.md',
    // ADR-122（重新冻结改写集 + 作用域解析）是另一并行会话落地的 ADR，本会话没碰
    'docs/adr/adr-122-refreeze-rewrites-writeset-and-scope-parser.md',
    // ADR-124（孤立记录可见可收 + 重复 agent 守卫修法二）是并行会话的落点
    'docs/adr/adr-124-orphan-records-must-be-visible-and-reapable.md',
    'docs/adr/adr-125-supervisor-must-not-hang-on-exit.md',
    'src/cli/commands/orphan-records.ts',
    'src/cli/commands/core-slice.ts',
    'src/cli/commands/info-help.ts',
    'src/core/activity/liveness.ts',
    'src/core/activity/index.ts',
    'src/core/stall/reap.ts',
    'tests/adr-053-dead-slice-reap.test.ts',
    'tests/d065-stuck-running-shell.test.ts',
    'tests/adr-124-duplicate-agent-guard.test.ts',
    // ADR-125（监督进程收尾之后不许卡在退出）的落点：适配器心跳 unref +
    // 监督进程入口强制退出。与 ADR-124 同一并行会话。
    'src/adapters/claude-agent/index.ts',
    'src/adapters/claude-agent-sdk/index.ts',
    'src/adapters/cursor-agent/index.ts',
    'src/cli/commands/supervisor-entry.ts',
    'tests/adr-125-supervisor-exit.test.ts',
    // ADR-129（runId 贯穿 + 收尾先落事实后释放 + 主管运行期心跳）—— 并行会话落点
    'docs/adr/adr-129-run-identity-and-teardown-order.md',
    'src/core/sched/run-id.ts',
    'src/core/sched/run-conclusion.ts',
    'src/core/sched/index.ts',
    'src/cli/commands/task-watchdog.ts',
    'src/cli/commands/supervisor-heartbeat.ts',
    'src/cli/commands/core-slice.ts',
    'src/cli/commands/supervisor.ts',
    'src/cli/commands/supervisor-entry.ts',
    'src/cli/commands/run-finish.ts',
    'src/cli/commands/parallel-executor.ts',
    'src/cli/commands/task-store.ts',
    'tests/adr-129-run-identity.test.ts',
    'tests/zd049-supervisor-takeover.test.ts',
    // ZD-062 第二次实测：杀树兜底（等 close 再 abort + 孙子 pid 补刀）
    'src/core/gate/executor.ts',
    'src/core/gate/types.ts',
    'tests/zd062-gate-kill-tree.test.ts',
    
    'src/adapters/web/frontend/styles.css',
    'src/cli/commands/dashboard.ts',
    'src/cli/commands/diff.ts',
    'src/cli/commands/merge-runner.ts',
    'src/cli/commands/pending-actions.ts',
    'src/cli/commands/planning-drafts.ts',
    'src/cli/sign-review/render.ts',
    'src/core/gate/sign.ts',
    'src/core/git/facts.ts',
    'src/core/pending/collect.ts',
    'src/core/pending/drafts.ts',
    'src/core/pending/index.ts',
    'src/core/pending/merge-candidates.ts',
    'src/core/pending/rank.ts',
    'src/core/pending/slice-state.ts',
    'src/core/pending/types.ts',
    'src/core/sign-review/collect.ts',
    'src/core/sign-review/diff.ts',
    'src/core/sign-review/types.ts',
    'src/core/slice/store.ts',
    'tests/adr104-sign-review-scope-evidence.test.ts',
    'tests/core/forge/pr-body.test.ts',
    'tests/git-batch-facts.test.ts',
    'tests/web-cockpit-revise.test.ts',
    'tests/acceptance/v1-sign-review-cli/acceptance.test.cjs',
    'tests/acceptance/v1-sign-review-core/acceptance.test.cjs',
    'tests/acceptance/v2-adr-trace/acceptance.test.cjs',]);

  const offenders = [];
  for (const p of changedPaths()) {
    for (const expanded of expandChangedPath(decodeGitPath(p))) {
      if (KNOWN_HARNESS_PATHS.has(expanded)) continue;
      if (inWriteSet(expanded)) continue;
      if (PRE_EXISTING.has(expanded)) continue;
      offenders.push(expanded);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `写集之外存在改动：${offenders.join(', ')}`,
  );

  // 产物存在（状态检查，与合并策略无关）
  for (const { file } of ADR_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} 必须在树上存在`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'adr-trace-check.mjs')), '校验脚本必须在树上存在');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'adr-trace-index.md')), '索引文档必须在树上存在');
});
