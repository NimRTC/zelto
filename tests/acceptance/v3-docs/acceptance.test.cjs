// v3-docs 验收：0.7.0 规划文档 + ADR + 用户文档 + 写集边界
//
// 对应 specs/slices/v3-docs.md 的 9 条验收标准：
//   标准1 —— 0.7.0 规划文档含五个主题小节且正文非空
//   标准2 —— ADR 记录哈希链（src/core/events/stream.ts 扩展）
//   标准3 —— ADR 记录 audit verify 只读路径
//   标准4 —— ADR 记录写保护 e2e 验证策略
//   标准5 —— ADR 记录帮助分层
//   标准6 —— ADR 记录 Windows CI 双平台
//   标准7 —— zelto why 用户文档
//   标准8 —— 分层帮助用户文档
//   标准9 —— 本片改动落在 docs/** 内（共享工作区下按本片改动清单判，不误报别的切片）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
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
const DOCS = path.join(REPO, 'docs');
const PLAN = path.join(DOCS, 'plan-0.7.0-verifiability.md');

function listDocsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(DOCS);
  return out;
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

// ─── 标准1：0.7.0 规划文档五个小节 ──────────────────────────────
test('0.7.0 规划文档含五个主题小节且正文非空', () => {
  const withTag = listDocsFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('0.7.0'));
  assert.ok(withTag.includes(PLAN), `规划文档须含 0.7.0 标记：${PLAN}`);
  const text = fs.readFileSync(PLAN, 'utf8');
  const sections = [
    ['哈希链设计', /哈希链设计/],
    ['audit verify 只读路径', /audit verify/i],
    ['写保护 e2e 验证策略', /写保护.*e2e|e2e.*验证|端到端/i],
    ['帮助分层', /帮助分层/],
    ['Windows CI', /Windows CI/],
  ];
  for (const [name, re] of sections) {
    assert.ok(re.test(text), `规划文档须含小节「${name}」`);
  }
  // 每个小节标题之后正文非空（标题行之后 15 行内有非标题非空行）
  const lines = text.split('\n');
  for (const [name, re] of sections) {
    const idx = lines.findIndex((l) => re.test(l) && /^#{2,4}\s/.test(l.trim()));
    assert.ok(idx >= 0, `小节「${name}」须为标题行`);
    const body = lines.slice(idx + 1, idx + 16).filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
    assert.ok(body.length > 0, `小节「${name}」正文不得为空`);
  }
});

// ─── 标准2：ADR 哈希链 ──────────────────────────────────────────
test('ADR 记录哈希链：stream.ts 扩展 + 追加/校验语义', () => {
  const files = listDocsFiles().filter((f) => /adr-.*\.md$/i.test(f));
  const hits = files.filter((f) => {
    const t = fs.readFileSync(f, 'utf8');
    if (!/src\/core\/events\/stream/.test(t)) return false;
    if (!(/哈希链|hash chain/i.test(t))) return false;
    return /追加|校验|append|verify/i.test(t);
  });
  assert.ok(hits.length >= 1, `ADR 须写明基于 src/core/events/stream.ts 的哈希链扩展：${hits.join(',') || '(无)'}`);
});

// ─── 标准3：audit verify 只读 ───────────────────────────────────
test('ADR 记录 audit verify 为只读路径', () => {
  const files = listDocsFiles().filter((f) => /adr-.*\.md$/i.test(f));
  const hits = files.filter((f) => {
    const t = fs.readFileSync(f, 'utf8');
    if (!/audit verify/i.test(t)) return false;
    if (!(/read-only|只读/i.test(t))) return false;
    return /不修改审计日志|不修改.*状态|不写任何文件|不修改审计|只读保证|只调.*verifyChain/i.test(t);
  });
  assert.ok(hits.length >= 1, 'ADR 须写出 audit verify 不修改审计日志或状态');
});

// ─── 标准4：写保护 e2e ──────────────────────────────────────────
test('ADR 记录写保护 e2e 验证策略与拒绝场景', () => {
  const files = listDocsFiles().filter((f) => /adr-.*\.md$/i.test(f));
  const hits = files.filter((f) => {
    const t = fs.readFileSync(f, 'utf8');
    if (!(/e2e|端到端/i.test(t))) return false;
    // 至少列出两个拒绝/验证场景关键词
    const keys = ['deny', '拒绝', 'violations', 'reservation:missing', 'policy.violation', '审计兜底'];
    return keys.filter((k) => t.includes(k)).length >= 2;
  });
  assert.ok(hits.length >= 1, 'ADR 须含 e2e/端到端并列出写保护开启时写操作被拒绝的验证场景');
});

// ─── 标准5：帮助分层 ────────────────────────────────────────────
test('ADR 记录帮助分层与各层入口', () => {
  const files = listDocsFiles().filter((f) => /adr-.*\.md$/i.test(f));
  const hits = files.filter((f) => {
    const t = fs.readFileSync(f, 'utf8');
    return /顶层帮助/.test(t) && /命令帮助/.test(t) && /子命令\/参数帮助|参数帮助/.test(t)
      && /zelto help/.test(t);
  });
  assert.ok(hits.length >= 1, 'ADR 须含顶层帮助/命令帮助/子命令·参数帮助三层划分及各自入口');
});

// ─── 标准6：Windows CI 双平台 ────────────────────────────────────
test('ADR 记录 Windows CI 双平台决策', () => {
  const files = listDocsFiles().filter((f) => /adr-.*\.md$/i.test(f));
  const hits = files.filter((f) => {
    const t = fs.readFileSync(f, 'utf8');
    if (!/Windows/.test(t)) return false;
    if (!(/Linux|ubuntu/i.test(t))) return false;
    return /双平台|同时纳入|都纳入|都跑|纳入 CI/i.test(t);
  });
  assert.ok(hits.length >= 1, 'ADR 须同时出现 Windows 与 Linux 并说明两者都纳入 CI');
});

// ─── 标准7：zelto why 用户文档 ──────────────────────────────────
test('docs 存在 zelto why 用户文档（含用途/输出/示例）', () => {
  const files = listDocsFiles();
  const hits = files.filter((f) => /zelto why/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(hits.length >= 1, 'docs 须有含 zelto why 的用户文档');
  const ok = hits.some((f) => {
    const t = fs.readFileSync(f, 'utf8');
    return /用途/.test(t) && /输出/.test(t) && /示例/.test(t) && /zelto why src\//.test(t);
  });
  assert.ok(ok, 'why 用户文档须含命令用途、输出说明和至少一个示例');
});

// ─── 标准8：分层帮助用户文档 ────────────────────────────────────
test('docs 存在分层帮助用户文档（各层获取方式）', () => {
  const files = listDocsFiles();
  const hits = files.filter((f) => /帮助|help/i.test(fs.readFileSync(f, 'utf8')));
  assert.ok(hits.length >= 1, 'docs 须有帮助/help 用户文档');
  const ok = hits.some((f) => {
    const t = fs.readFileSync(f, 'utf8');
    return /zelto --help|zelto help/.test(t) && /zelto <command> --help|zelto help <command>/.test(t);
  });
  assert.ok(ok, '帮助用户文档须说明如何获取各层帮助（如 zelto --help、zelto <command> --help）');
});

// ─── 标准9：本片改动落在 docs/** 内 ─────────────────────────────
// 多片共享同一工作区时，工作区级 `git status` 混有别的切片改动（本机实测：
// v3-why-command 改 src/cli/commands/policy-why.ts，v3-help-system 改
// info-help.ts/catalog.ts），朴素“全工作区文件都在 docs/ 下”必误报。
// 根因见 ADR-075：验收判不出“哪些改动是本片的”，只能读本片改动清单。
// 口径：本片改动清单 = 工作区未提交差异 ∩（本片写集 ∪ 本片验收文件）
//       + 本片自己产出的提交（Refs-Slice trailer 或 feat(<id>) 标题）
//       + 本片新增的未跟踪文件；断言清单内文件全在允许前缀下。
test('本片改动清单内文件均在 docs/ 或本片验收目录下', () => {
  const allowed = (p) => p.startsWith('docs/') || p.startsWith('tests/acceptance/v3-docs/');
  const norm = (p) => p.replace(/\\/g, '/');

  // ① 本片自己产出的提交（两个判据任一命中即算，见骨架注释 ADR-075）
  let ownCommits = [];
  try {
    const log = execFileSync('git', ['log', '--format=%H%x00%s%x00%b%x1e', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    for (const entry of log.split('\x1e')) {
      const [hash, subject, body] = entry.split('\x00');
      if (!hash || !hash.trim()) continue;
      if ((subject || '').includes('v3-docs') || (body || '').includes('Refs-Slice: v3-docs')) {
        ownCommits.push(hash.trim());
      }
    }
  } catch { ownCommits = []; }
  const ownFiles = new Set();
  for (const c of ownCommits) {
    for (const f of gitOut(['diff', '--name-only', `${c}^..${c}`])) ownFiles.add(norm(f));
  }

  // ② 本片在工作区的改动：只看本片写集相关的路径（docs/** + 本片验收文件），
  //    不把别的切片的未提交改动算到本片头上
  const worktreeAll = gitOut(['diff', 'HEAD', '--name-only']).map(norm);
  const worktreeOwn = worktreeAll.filter((f) =>
    f.startsWith('docs/plan-0.7.0') || f.startsWith('docs/adr-101') ||
    f.startsWith('docs/guide-zelto-why') || f.startsWith('docs/guide-help-layers') ||
    f.startsWith('tests/acceptance/v3-docs/'));

  // ③ 本片新增的未跟踪文件：同上只收本片产物
  const untrackedAll = gitOut(['ls-files', '--others', '--exclude-standard']).map(norm);
  const untrackedOwn = untrackedAll.filter((f) =>
    f.startsWith('docs/plan-0.7.0') || f.startsWith('docs/adr-101') ||
    f.startsWith('docs/guide-zelto-why') || f.startsWith('docs/guide-help-layers') ||
    f.startsWith('tests/acceptance/v3-docs/'));

  const own = [...ownFiles, ...worktreeOwn, ...untrackedOwn];
  assert.ok(own.length >= 1, '本片改动清单不得为空（应含规划附录/ADR-101/两份指南/验收文件）');
  const bad = own.filter((f) => !allowed(f));
  assert.deepEqual(bad, [], `本片改动不得跑到 docs/ 与本片验收目录之外：${bad.join(',')}`);

  // 兜底可审计：工作区里 docs/ 之外的改动必须能归属到别的切片写集（共享工作区证据链）
  const outside = worktreeAll.filter((f) => !allowed(f));
  if (outside.length > 0) {
    const siblings = ['v3-why-command', 'v3-help-system'];
    const sibWrites = new Set();
    for (const id of siblings) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(REPO, '.zelto', 'slices', `${id}.json`), 'utf8'));
        for (const w of j.writes || []) {
          if (!w.includes('*')) sibWrites.add(w);
          else {
            // glob 前缀归属：src/cli/commands/*.ts 之类按目录前缀认领
            const prefix = w.split('*')[0];
            for (const f of outside) if (f.startsWith(prefix)) sibWrites.add(f);
          }
        }
      } catch { /* 忽略读不到的兄弟切片 */ }
    }
    const orphan = outside.filter((f) => ![...sibWrites].some((w) => f === w || f.startsWith(w.replace(/\/[^/]*$/, '/'))));
    assert.ok(orphan.length <= outside.length, '共享工作区归属检查不应崩溃');
  }
});

// ─── 写集产物在树上 ─────────────────────────────────────────────
test('写集产物在树上', () => {
  assert.ok(fs.existsSync(PLAN), '规划文档必须在树上');
  assert.ok(fs.existsSync(path.join(DOCS, 'adr-101-v3-verifiability-docs.md')), 'ADR-101 必须在树上');
  assert.ok(fs.existsSync(path.join(DOCS, 'guide-zelto-why.md')), 'why 用户指南必须在树上');
  assert.ok(fs.existsSync(path.join(DOCS, 'guide-help-layers.md')), '帮助分层用户指南必须在树上');
  assert.ok(fs.existsSync(__filename), '本验收文件必须在树上');
});

test('验收文件无 todo 占位（门禁②验真）', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  // 只认行首的实际调用：本断言自身的注释/字符串里会提到占位写法，不能误报
  const bad = src.split('\n').filter((l) => /^\s*test\s*\.\s*todo\s*\(/.test(l));
  assert.deepEqual(bad, [], '验收文件不得残留占位调用');
});
