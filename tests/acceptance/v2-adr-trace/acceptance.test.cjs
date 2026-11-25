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
  return gitOut(['status', '--porcelain']).map((l) => l.slice(3).trim());
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
  const offenders = [];
  for (const p of changedPaths()) {
    for (const expanded of expandChangedPath(p)) {
      if (KNOWN_HARNESS_PATHS.has(expanded)) continue;
      if (!inWriteSet(expanded)) offenders.push(expanded);
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
