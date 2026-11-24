// D-60：后台（detach）路径的写集审计必须与前台路径同源
//
// 病灶（实测于 nimrtc-zelto v3-weaknet-verdict，2026-11-17）：
//
//   `zelto run --detach` 走的是**监督进程**（supervisor.ts，D-50）。
//   监督进程调 `installRuntimeGuard` 时**没传 `managedPaths`** ——
//   前台路径（core-slice.ts / parallel-executor.ts）都传了。
//
//   后果：`managedPaths` 为空 → 写集审计不知道「规格副本是 zelto 自己
//   放进去的」→ 运行结束后拿 git status 对写集时，
//   `specs/slices/<id>.md` 落在写集之外 → 判成「agent 越界写入」
//   → `run.aborted`（reason: write-set violation）→ 整轮运行作废。
//
//   讽刺的是：**agent 一个字节都没碰那个文件**。
//   它的内容与主仓真源逐字节相同（zelto 自己复制进去的副本），
//   agent 的真产物（tools/rd_lan.py 等）反而是干净的。
//
//   所以这不是「agent 不守规矩」，而是「zelto 被自己的文件拦下」。
//
// 这一组用例守的是：
//   1. `zeltoOwnedPaths` 确实把规格副本算作 zelto 托管；
//   2. 审计时，托管文件**不算越界**，但内容被改仍算**篡改**；
//   3. 非托管、不在写集的文件仍算**真越界**（不能因为修了这条而放松）；
//   4. 监督进程那条路径确实传了 `managedPaths`（源码级锁定）。
//
// 第 4 条用源码扫描锁定 —— 因为监督进程是独立进程，
// 端到端跑一次要起真 agent，太重；而这个 bug 的本质就是
// 「一条路径传了、另一条路径没传」，源码扫描正好对着这个判据。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditWorktreeWrites } from '../src/core/sched/audit.js';
import { zeltoOwnedPaths } from '../src/cli/commands/parallel-executor.js';
import { buildSpecIntegrity } from '../src/cli/commands/shared.js';
import type { SliceData } from '../src/core/slice/store.js';

const SPEC_REL = 'specs/slices/v3-weaknet-verdict.md';
const WRITE_SET = [
  'tools/rd_lan.py',
  'tests/acceptance/v3-weaknet-verdict/acceptance.test.cjs',
];

function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'v3-weaknet-verdict',
    title: '弱网判定',
    state: 'frozen',
    spec: { path: SPEC_REL, frozenHash: 'sha256:x', frozenAt: null },
    acceptance: { dir: 'tests/acceptance/v3-weaknet-verdict/', frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: WRITE_SET,
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as SliceData;
}

/** 建一个真的 git 仓库 —— 审计要靠 git status 才能看到未跟踪文件。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-d51-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q');
  git('config', 'user.email', 'test@zelto.local');
  git('config', 'user.name', 'zelto test');
  return dir;
}

describe('D-60 托管文件清单：规格副本归 zelto，不归 agent', () => {
  it('规格副本进托管清单', () => {
    const owned = zeltoOwnedPaths('D:/wt', makeSlice());
    assert.ok(
      owned.includes(SPEC_REL),
      `规格副本必须在托管清单里，实际：${JSON.stringify(owned)}`,
    );
  });

  it('写集里的验收文件**不**进托管清单（ADR-046：那是 agent 该改的）', () => {
    const owned = zeltoOwnedPaths('D:/wt', makeSlice());
    assert.ok(
      !owned.includes('tests/acceptance/v3-weaknet-verdict/acceptance.test.cjs'),
      '写集里的验收文件不能被托管 —— 那等于一边叫 agent 改、一边拦它改',
    );
  });

  it('没有 worktree 时托管清单为空', () => {
    assert.deepEqual(zeltoOwnedPaths(null, makeSlice()), []);
  });
});

// ─── ADR-106：写集里的规格文件不是「托管文件」─────────────────────────────
//
// 病灶（实测于 nimrtc-v14 v1-call-state-surface，2026-11-24）：
//
//   规格在写集里（人批准的边界）→ zelto 告诉 agent「You may only modify
//   these paths」，而这条路径就在名单上。agent 改了它（把 ADR 状态从
//   `Proposed` 改成 `Accepted`）→ 写集审计判 `tampered` → 整轮运行作废，
//   gate 都没跑。agent 的活全做完了。
//
//   规格文件**无条件**登记为托管，而验收目录**按写集豁免**（ADR-046）——
//   同一个语义，两套判据。ADR-106 把规格也统一到「写集」这条判据。
describe('ADR-106 托管文件清单：规格按写集判（与验收目录同源）', () => {
  it('规格在写集里 → **不**进托管清单（agent 有权改它）', () => {
    const slice = makeSlice({ writes: [...WRITE_SET, SPEC_REL] });
    const owned = zeltoOwnedPaths('D:/wt', slice);
    assert.ok(
      !owned.includes(SPEC_REL),
      `写集里的规格文件不能被托管 —— 那等于一边叫 agent 改、一边拦它改。` +
        `实际：${JSON.stringify(owned)}`,
    );
  });

  it('规格不在写集里 → 照旧进托管清单（保护没放松）', () => {
    const owned = zeltoOwnedPaths('D:/wt', makeSlice());
    assert.ok(
      owned.includes(SPEC_REL),
      `规格不在写集里时必须继续被托管 —— 那是 zelto 的副本，实际：${JSON.stringify(owned)}`,
    );
  });

  // ─── 回归：写集判据必须与 C9 运行时一致 ──────────────────────────────
  //
  // 病灶（2026-11-24 复核 ADR-106 时发现）：
  //
  //   ADR-106 的豁免判据用**严格相等**（`writeSet.has(specRel)`），
  //   而 C9 运行时守卫用 `pathInWriteSet` —— 后者认 **glob 与目录前缀**。
  //
  //   于是人用这些写法把规格放进写集时：
  //     - `specs/slices/*.md`（glob）
  //     - `specs/`（目录前缀）
  //     - `specs`（裸目录）
  //     - `specs/slices/`（父目录前缀）
  //
  //   C9 说「这个文件在写集里，你可以改」，
  //   而托管清单说「不在写集」→ 登记成托管 → agent 一改就判篡改
  //   → **zelto 一边让 agent 改、一边因它改而拦下** ——
  //   正是 ADR-106 要修的那个矛盾，只是换了种写法没修掉。
  //
  // **同一件事两套判据**是 D-11 的老教训（合并的两条路径判据不一致）。
  for (const writeForm of [
    'specs/slices/*.md',
    'specs/',
    'specs',
    'specs/slices/',
  ]) {
    it(`写集用「${writeForm}」覆盖规格 → 不进托管清单（与 C9 口径一致）`, () => {
      const slice = makeSlice({ writes: [...WRITE_SET, writeForm] });
      const owned = zeltoOwnedPaths('D:/wt', slice);
      assert.ok(
        !owned.includes(SPEC_REL),
        `C9 认「${writeForm}」覆盖这个规格，托管清单也必须认 —— ` +
          `否则又回到「一边让 agent 改、一边因它改而拦下」。` +
          `实际：${JSON.stringify(owned)}`,
      );
    });
  }

  it('验收文件同样用写集判据（ADR-046 口径一致，glob 也认）', () => {
    const slice = makeSlice({ writes: [...WRITE_SET, 'tests/acceptance/**/*.cjs'] });
    const owned = zeltoOwnedPaths('D:/wt', slice);
    assert.ok(
      !owned.includes('tests/acceptance/v3-weaknet-verdict/acceptance.test.cjs'),
      'glob 覆盖的验收文件也不能被托管 —— C9 允许 agent 改它',
    );
  });
});

describe('ADR-106 规格完整性锚：豁免「托管」，不豁免「改验收标准」', () => {
  const SPEC_WITH_CRITERIA = [
    '# Slice: v1-call-state-surface',
    '',
    '## Summary',
    '状态面。',
    '',
    '## 验收标准',
    '',
    '1. `CallState` 枚举存在，含五个状态。',
    '2. 同一状态不重复上报。',
    '3. `kFailed` 是吸收态。',
    '',
  ].join('\n');

  /** 建一个仓库并写一份带验收标准的规格（相对 worktree 根）。 */
  function makeSpecRepo(specContent: string): string {
    const dir = makeRepo();
    mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(dir, SPEC_REL), specContent, 'utf-8');
    return dir;
  }

  it('规格被改了，但冻结需求全在 → **不**判篡改（豁免生效）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      // agent 改了一行非验收标准的内容（ADR 状态行）
      const changed = SPEC_WITH_CRITERIA.replace('状态面。', '状态面。（ADR 已接受）');
      writeFileSync(join(dir, SPEC_REL), changed, 'utf-8');

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: {
          specPath: SPEC_REL,
          requirements: [
            '`CallState` 枚举存在，含五个状态。',
            '同一状态不重复上报。',
            '`kFailed` 是吸收态。',
          ],
        },
      });

      assert.equal(result.error, null, `git 状态读取失败：${result.error}`);
      assert.ok(
        !result.tampered.includes(SPEC_REL),
        `冻结需求全在就不该判篡改 —— 篡改清单：${JSON.stringify(result.tampered)}`,
      );
      assert.ok(
        !result.violations.includes(SPEC_REL),
        '规格在写集里 → 也不算越界',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('规格被改了，且**少了一条**冻结需求 → 判篡改（拦住自动改验收标准）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      // agent 删掉了「kFailed 是吸收态」这条 —— 条数从 3 变 2
      const weakened = SPEC_WITH_CRITERIA.replace('3. `kFailed` 是吸收态。\n', '');
      writeFileSync(join(dir, SPEC_REL), weakened, 'utf-8');

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: {
          specPath: SPEC_REL,
          requirements: [
            '`CallState` 枚举存在，含五个状态。',
            '同一状态不重复上报。',
            '`kFailed` 是吸收态。',
          ],
        },
      });

      assert.ok(
        result.tampered.includes(SPEC_REL),
        '删掉一条验收标准必须判篡改 —— 那就是自动改规格',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('条数不变但**内容被换掉** → 判篡改（只比条数等于没比）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      // 把「kFailed 是吸收态」换成「kFailed 是终态」—— 条数不变，判据被削弱
      const weakened = SPEC_WITH_CRITERIA.replace(
        '3. `kFailed` 是吸收态。',
        '3. `kFailed` 是终态。',
      );
      writeFileSync(join(dir, SPEC_REL), weakened, 'utf-8');

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: {
          specPath: SPEC_REL,
          requirements: [
            '`CallState` 枚举存在，含五个状态。',
            '同一状态不重复上报。',
            '`kFailed` 是吸收态。',
          ],
        },
      });

      assert.ok(
        result.tampered.includes(SPEC_REL),
        '改写验收标准的文本必须判篡改 —— 条数不变不等于没改',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('规格被改但**新增**了一条验收标准 → 不判篡改（新增只会更严）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      const stricter = SPEC_WITH_CRITERIA.replace(
        '## 验收标准',
        '## 验收标准\n\n0. 前提条款。',
      );
      writeFileSync(join(dir, SPEC_REL), stricter, 'utf-8');

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: {
          specPath: SPEC_REL,
          requirements: [
            '`CallState` 枚举存在，含五个状态。',
            '同一状态不重复上报。',
            '`kFailed` 是吸收态。',
          ],
        },
      });

      assert.ok(
        !result.tampered.includes(SPEC_REL),
        '新增验收标准不削弱判据，不该拦',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有锚（锚为空）→ 不做这道校验（没有判据不能凭空判篡改）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      writeFileSync(join(dir, SPEC_REL), '改完了，什么都没了\n', 'utf-8');

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: { specPath: SPEC_REL, requirements: [] },
      });

      assert.ok(
        !result.tampered.includes(SPEC_REL),
        '锚为空 = 没有判据 = 不判篡改',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('规格被删了（读不出来）→ 判篡改（fail closed：判据判不了就不能放行）', () => {
    const dir = makeSpecRepo(SPEC_WITH_CRITERIA);
    try {
      // 先提交（规格本来就在版本控制里 —— 它是 zelto 复制进 worktree 的真源），
      // 再删掉 —— 这才是「agent 把规格删了」的真实场景。
      execFileSync('git', ['add', SPEC_REL], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.email=t@t.z', '-c', 'user.name=t', 'commit', '-q', '-m', 'spec'],
        { cwd: dir, stdio: 'ignore' });
      rmSync(join(dir, SPEC_REL), { force: true });

      const result = auditWorktreeWrites(dir, [SPEC_REL], {
        specIntegrity: {
          specPath: SPEC_REL,
          requirements: ['`CallState` 枚举存在，含五个状态。'],
        },
      });

      assert.ok(
        result.tampered.includes(SPEC_REL),
        '规格读不出来 = 判据判不了 = 不能放行（fail closed）',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D-60 写集审计：托管文件不算越界，但被改算篡改', () => {
  it('规格副本（zelto 放的）不被判成越界', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(dir, SPEC_REL), '# Slice: v3-weaknet-verdict\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:PLACEHOLDER' }],
      });

      assert.equal(result.error, null, `git 状态读取失败：${result.error}`);
      assert.ok(
        result.changed.includes(SPEC_REL),
        '前提：规格副本确实出现在 git 改动里（未跟踪的新文件）',
      );
      assert.ok(
        !result.violations.includes(SPEC_REL),
        `托管文件不该判成越界 —— 越界清单：${JSON.stringify(result.violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('托管文件内容被改 → 判篡改（不是越界）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(dir, SPEC_REL), '# 改了内容\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:WRONG' }],
      });

      assert.ok(
        result.tampered.includes(SPEC_REL),
        '托管文件内容对不上必须判篡改 —— 改规格副本等于自动改规格',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非托管、又不在写集里的文件 → 判越界（真越界不能放过）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sneaky.cpp'), 'int main(){}\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:x' }],
      });

      assert.ok(
        result.violations.includes('src/sneaky.cpp'),
        `真正的越界写入必须被抓住，越界清单：${JSON.stringify(result.violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写集里的文件 → 不算越界（agent 的正当产出）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'tools'), { recursive: true });
      writeFileSync(join(dir, 'tools', 'rd_lan.py'), 'print("hi")\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {});

      assert.ok(
        !result.violations.includes('tools/rd_lan.py'),
        '写集里的文件不能算越界',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D-60 监督进程路径：managedPaths 必须传（源码级锁定）', () => {  it('supervisor.ts 的 installRuntimeGuard 调用带 managedPaths', () => {
    // 源码在仓库里，不在 dist-test 里 —— 从仓库根找。
    const repoRoot = process.cwd();
    const srcPath = join(repoRoot, 'src', 'cli', 'commands', 'supervisor.ts');
    assert.ok(existsSync(srcPath), `找不到源码：${srcPath}`);
    const src = readFileSync(srcPath, 'utf-8');

    const callIdx = src.indexOf('await installRuntimeGuard({');
    assert.ok(callIdx >= 0, 'supervisor.ts 里应有一处 installRuntimeGuard 调用');

    // 取这次调用的参数块（到匹配的右括号为止）
    const block = src.slice(callIdx, src.indexOf('});', callIdx) + 3);

    assert.match(
      block,
      /managedPaths:/,
      '监督进程必须传 managedPaths —— 少了它，zelto 自己放进 worktree 的' +
        '规格副本会被写集审计判成「agent 越界写入」（实测 v3-weaknet-verdict）',
    );
    assert.match(
      block,
      /zeltoOwnedPaths/,
      '托管清单必须用 zeltoOwnedPaths（与前台路径同源，不能另写一份）',
    );
  });
});

// ─── ADR-106 §2：规格完整性锚的写集判据 ───────────────────────────────────
//
// 「冻结需求仍在」这道校验（ADR-106 §2）是规格豁免的**另一半** ——
// 豁免了「托管」，但没豁免「改验收标准」。
//
// 它靠 `buildSpecIntegrity` 产出的**锚**（冻结时物化的需求文本）。
// 锚从哪来？**起跑前的规格正文**。
//
// 病灶（2026-11-24 复核 ADR-106 时发现）：
//
//   `buildSpecIntegrity` 的「规格在不在写集里」判据用**严格相等**，
//   而 C9 运行时用 `pathInWriteSet`（认 glob 与目录前缀）。
//
//   后果比托管那一侧更隐蔽 —— **放行与校验会同时走偏**：
//     托管侧说「不在写集」→ 登记成托管 → agent 改了就判篡改（矛盾）；
//     锚侧说「不在写集」→ **不给锚** → 「冻结需求仍在」这道校验**不生效**
//     → agent 删掉验收标准也拦不住。
//
//   修好托管侧、放任锚侧，就是「一边放行、一边不校验」—— **漏**。
//   所以两处必须**同一个判据**（`pathInWriteSet`）。
describe('ADR-106：规格完整性锚的写集判据与 C9 一致', () => {
  /** 建一个含「验收标准」的规格文件，返回 worktree 根。 */
  function makeSpecWorktree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-adr106-'));
    mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
    writeFileSync(
      join(dir, SPEC_REL),
      [
        '# Slice: v3-weaknet-verdict',
        '',
        '## 验收标准',
        '',
        '1. `CallState` 枚举存在，含五个状态。',
        '2. 同一状态不重复上报。',
        '',
      ].join('\n'),
      'utf-8',
    );
    return dir;
  }

  for (const writeForm of [
    'specs/slices/*.md',
    'specs/',
    'specs',
    'specs/slices/',
  ]) {
    it(`写集用「${writeForm}」覆盖规格 → 要给锚（否则校验形同虚设）`, () => {
      const dir = makeSpecWorktree();
      try {
        const integrity = buildSpecIntegrity(dir, {
          spec: { path: SPEC_REL },
          writes: [writeForm],
        });
        assert.ok(
          integrity !== null,
          `C9 认「${writeForm}」覆盖这个规格，锚也必须给 —— ` +
            `不给锚 = 「冻结需求仍在」这道校验不生效 = agent 能删掉验收标准`,
        );
        assert.equal(integrity?.requirements.length, 2, '两条验收标准都要进锚');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('规格精确在写集里 → 给锚', () => {
    const dir = makeSpecWorktree();
    try {
      const integrity = buildSpecIntegrity(dir, {
        spec: { path: SPEC_REL },
        writes: [SPEC_REL],
      });
      assert.ok(integrity !== null, '精确命中也要给锚');
      assert.equal(integrity?.requirements.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('规格不在写集里 → 不给锚（它受托管哈希保护，不需要这道校验）', () => {
    const dir = makeSpecWorktree();
    try {
      const integrity = buildSpecIntegrity(dir, {
        spec: { path: SPEC_REL },
        writes: ['src/core/**'],
      });
      assert.equal(integrity, null, '不在写集里 = 不需要锚');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有 worktree → 不给锚', () => {
    const integrity = buildSpecIntegrity(null, {
      spec: { path: SPEC_REL },
      writes: [SPEC_REL],
    });
    assert.equal(integrity, null);
  });
});
