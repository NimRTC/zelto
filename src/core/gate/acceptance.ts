// 切片级验收 —— 门禁②里「这一片自己有没有被验证过」的那一步
//
// 背景（ADR-033）：门禁②原本只跑 `config.yaml` 里的 `gate.commands`
// （默认 `pnpm test` / `pnpm lint`）—— 那是**全项目**命令。后果是
// agent 交回来一片半成品，只要项目里别的测试还绿，门禁就放行。
// 于是「签字 = 门禁通过」并不等于「这片东西真的被验证过」。
//
// 这一步只做一件事：把本片的验收目标找出来、跑起来、把结论记下来。
// 判据（跑没跑、跑没跑过、成没成功）全是确定性计算，不调模型、不触网（C3）。
//
// ── 失败语义：fail closed ───────────────────────────────────────────────
// 门禁是闸门。跑不起来 ≠ 没问题，所以「没有验收目标」「命令跑不起来」
// 「命令跑了但失败」三种情况都判 failed。只有一种情况判 skipped：
// 配置显式声明 `required: false` 且本片确实没有验收目标。
// skipped 也会被显式记录下来 —— 静默跳过等于骗人。
//
// ── 为什么不用「目录」当目标 ───────────────────────────────────────────
// `node --test <目录>` 在 Node 24 上不展开目录：它把目录当模块加载，
// 报 "Cannot find module" 直接失败。所以验收目标必须落到**具体文件**。
// 这里自己把目录展开成文件列表（规则与 node 测试运行器一致，见 isTestFileName），
// 再把文件列表填进命令模板。
//
// 展开规则是纯计算 + 读文件系统，判定确定（C3）。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, relative, sep } from 'node:path';
import type { AcceptanceOutcome, GateAcceptanceConfig } from './types.js';

/** 默认的验收命令模板 —— 用项目自己的测试运行器跑本片验收目标 */
export const DEFAULT_ACCEPTANCE_COMMAND = 'node --test {acceptance}';

/** 默认的编译产物目录 —— TypeScript 项目的源文件不能直接被 node --test 执行 */
export const DEFAULT_ACCEPTANCE_BUILD_DIR = 'dist-test';

/**
 * 本片的验收目标最终是什么。
 *
 * `path` 是给人看的目标（目录或文件），`files` 是真正要跑的东西，
 * `source` 说清它是从源目录还是编译产物里找到的。
 */
export interface ResolvedAcceptanceTarget {
  /** 展示用的目标路径（相对 gate root） */
  path: string;
  /** 目标是从哪儿定位出来的 */
  source: 'source' | 'compiled';
  /** 真正要执行的测试文件（相对 gate root） */
  files: string[];
}

/**
 * 验收目标的定位结果。
 *
 * 找不到时必须说清是**哪种**找不到 —— 「目录压根不存在」和
 * 「目录在、里面一个测试文件都没有」是两种不同的病，
 * 报成同一句话，人就没法判断该补测试还是该修路径。
 */
export interface AcceptanceResolution {
  /** 定位到的目标；没定位到时为 null */
  target: ResolvedAcceptanceTarget | null;
  /** 没定位到时的原因（中文，给人看）；定位到时为 null */
  reason: string | null;
}

/**
 * 判断一个文件名是不是「测试文件」。
 *
 * 规则与 node 测试运行器的默认匹配规则保持一致（否则门禁跑的文件
 * 和人本地跑的文件就不是同一批，签字就失去意义）：
 *
 *   test.js / test-foo.js / foo.test.js / foo-test.js / foo_test.js
 *   以及任意 `test/` 目录下的文件
 *
 * 扩展名覆盖 js/cjs/mjs 与 ts/mts/cts（Node 22.18+ 可直接跑 TS）。
 */
export function isTestFileName(name: string): boolean {
  if (!/\.(c|m)?(js|ts)$/i.test(name)) return false;
  if (/^test[-_].*\.(c|m)?(js|ts)$/i.test(name)) return true; // test-foo.js
  if (/^test\.(c|m)?(js|ts)$/i.test(name)) return true; // test.js
  if (/[-._]test\.(c|m)?(js|ts)$/i.test(name)) return true; // foo.test.js / foo-test.js / foo_test.js
  return false;
}

/**
 * 递归收集目录下的测试文件（相对 root）。
 *
 * 结果按路径排序 —— 同样的输入永远得到同样的顺序与同样的命令（C3）。
 */
export function collectTestFiles(dir: string, root: string): string[] {
  const found: string[] = [];

  const walk = (current: string, inTestDir: boolean): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 读不到就当没有 —— 不静默编造
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, inTestDir || entry.name === 'test');
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/');
      const inTest = inTestDir || rel.split('/').includes('test');
      if (inTest || isTestFileName(entry.name)) {
        found.push(rel);
      }
    }
  };

  walk(dir, false);
  return found.sort();
}

/**
 * 定位本片的验收目标。
 *
 * `slice.acceptance.dir` 有两种形态（既有代码里两种都真实存在）：
 *   - 目录：`tests/acceptance/<id>/`（store.create 的默认值）
 *   - 文件：`tests/acceptance/<id>.test.ts`（`create --from-spec` 设的）
 *
 * TypeScript 项目的源文件不一定能直接被 `node --test` 执行。所以当目标是
 * 源路径时，先去编译产物目录（默认 `dist-test/`）找同名产物：
 * 找到就跑编译产物，找不到就跑源路径 —— 让运行器去失败，
 * 并由门禁把失败原因说清楚。**不静默跳过**。
 *
 * @param acceptanceDir 切片记录里的验收路径
 * @param gateRoot 门禁工作目录（worktree 或 cwd）
 * @param buildDir 编译产物目录（相对 gateRoot）
 */
export function resolveAcceptance(
  acceptanceDir: string | undefined | null,
  gateRoot: string,
  buildDir: string = DEFAULT_ACCEPTANCE_BUILD_DIR,
): AcceptanceResolution {
  const raw = (acceptanceDir ?? '').trim();
  if (!raw) {
    return { target: null, reason: '本片没有登记验收目标' };
  }

  // 去掉结尾斜杠，让「目录」和「目录/」是同一个东西
  const normalized = raw.replace(/[\\/]+$/, '');
  if (!normalized) {
    return { target: null, reason: '本片没有登记验收目标' };
  }

  const sourceAbs = isAbsolute(normalized) ? normalized : join(gateRoot, normalized);
  const compiledRel = join(buildDir, normalized).replace(/\\/g, '/');
  const compiledAbs = join(gateRoot, compiledRel);

  // ── 目录形态 ────────────────────────────────────────────────────────
  if (existsSync(sourceAbs) && statSync(sourceAbs).isDirectory()) {
    const compiledFiles =
      existsSync(compiledAbs) && statSync(compiledAbs).isDirectory()
        ? collectTestFiles(compiledAbs, gateRoot)
        : [];
    if (compiledFiles.length > 0) {
      return { target: { path: compiledRel, source: 'compiled', files: compiledFiles }, reason: null };
    }
    const sourceFiles = collectTestFiles(sourceAbs, gateRoot);
    if (sourceFiles.length > 0) {
      return { target: { path: normalized, source: 'source', files: sourceFiles }, reason: null };
    }
    return {
      target: null,
      reason: `验收目录存在但里面没有测试文件：${normalized}`,
    };
  }

  // ── 文件形态 ────────────────────────────────────────────────────────
  if (existsSync(sourceAbs) && statSync(sourceAbs).isFile()) {
    if (normalized.endsWith('.ts')) {
      const compiledFile = compiledRel.replace(/\.ts$/, '.js');
      if (existsSync(join(gateRoot, compiledFile))) {
        return { target: { path: compiledFile, source: 'compiled', files: [compiledFile] }, reason: null };
      }
    }
    return { target: { path: normalized, source: 'source', files: [normalized] }, reason: null };
  }

  // 源路径不在，但编译产物在（例如只构建了产物、源码路径写法不同）
  if (existsSync(compiledAbs)) {
    const files = statSync(compiledAbs).isDirectory()
      ? collectTestFiles(compiledAbs, gateRoot)
      : [compiledRel];
    if (files.length > 0) {
      return { target: { path: compiledRel, source: 'compiled', files }, reason: null };
    }
  }

  return { target: null, reason: `验收目标不存在：${normalized}` };
}

/**
 * 把验收目标填进命令模板。
 *
 * 模板里的字面量 `{acceptance}` 会被替换成**要跑的文件列表**；
 * 模板没有占位符时，文件列表作为末尾参数追加。这样两种写法都能用：
 *
 *   command: "node --test {acceptance}"
 *   command: "pnpm vitest run"          → 变成 "pnpm vitest run <文件1> <文件2>"
 *
 * 文件路径里带空格时加引号 —— 门禁命令走 shell，不加就会被拆成两个参数。
 */
export function buildAcceptanceCommand(template: string, files: string[]): string {
  const rendered = files.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(' ');
  if (template.includes('{acceptance}')) {
    return template.replace(/\{acceptance\}/g, rendered);
  }
  return `${template} ${rendered}`;
}

/**
 * 决定「没有验收目标」这件事是 failed 还是 skipped。
 *
 * @param required 配置里是否声明必须有验收目标（默认 true = fail closed）
 */
export function classifyMissingTarget(required: boolean): 'failed' | 'skipped' {
  return required ? 'failed' : 'skipped';
}

/**
 * 组装一个「没跑成」的验收结论。
 */
export function missingTargetOutcome(
  required: boolean,
  reason: string,
  command: string | null = null,
): AcceptanceOutcome {
  return {
    status: classifyMissingTarget(required),
    path: null,
    command,
    reason,
    exitCode: null,
    durationMs: 0,
  };
}

/**
 * 把验收目标路径换算成给人看的相对路径（用于报告）。
 */
export function displayPath(target: string, gateRoot: string): string {
  if (!isAbsolute(target)) return target;
  const rel = relative(gateRoot, target);
  return rel.startsWith('..') ? target : rel.split(sep).join('/');
}

// ─── 「有没有真跑用例」 ─────────────────────────────────────────────────────

/**
 * 测试运行器的统计（只认 TAP 汇总行里明确写出来的数字）。
 *
 * `known` 为 false 表示输出里没有可识别的汇总行 —— **未知不等于没跑**，
 * 这种情况下不做任何判断（不同测试运行器的输出格式不一样，猜不得）。
 */
export interface AcceptanceRunStats {
  /** 真正执行并通过的用例数 */
  pass: number;
  /** 失败的用例数 */
  fail: number;
  /** 标记为 todo 的用例数（骨架生成器写的就是它） */
  todo: number;
  /** 被跳过的用例数 */
  skipped: number;
  /** 是否读到了统计 */
  known: boolean;
}

/**
 * 从测试运行器的输出里读统计。
 *
 * 认 node 测试运行器的 TAP 汇总行（`# pass 3` / `# todo 2` / `# skipped 1`）。
 * 认不出就返回 `known: false` —— 不猜、不用正则硬凑一个结论。
 */
export function parseTestRunnerStats(output: string): AcceptanceRunStats {
  const stats: AcceptanceRunStats = { pass: 0, fail: 0, todo: 0, skipped: 0, known: false };

  for (const line of output.split('\n')) {
    const m = line.match(/^\s*#\s*(pass|fail|todo|skipped)\s+(\d+)\s*$/i);
    if (!m) continue;
    const count = Number.parseInt(m[2], 10);
    if (Number.isNaN(count)) continue;
    stats.known = true;
    const key = m[1].toLowerCase() as 'pass' | 'fail' | 'todo' | 'skipped';
    stats[key] = count;
  }

  return stats;
}

/**
 * 判断验收是不是「真跑过了」。
 *
 * 为什么要多这一层（ADR-034）：验收测试骨架里的用例全是 `test.todo(...)`，
 * 而 `node --test` 对全是 todo 的文件**退出码是 0** —— 门禁于是把
 * 「一个用例都没跑」当成「验收通过」。骨架存在 ≠ 验收通过。
 *
 * 判定只有一条：**没有任何一条用例真正执行过** → 没验证。
 */
export function verifyAcceptanceRanTests(stats: AcceptanceRunStats): {
  ok: boolean;
  reason: string | null;
} {
  if (!stats.known) {
    return { ok: true, reason: null }; // 读不出统计 → 不做判断
  }

  if (stats.pass > 0) {
    return { ok: true, reason: null };
  }

  if (stats.todo > 0 || stats.skipped > 0) {
    return {
      ok: false,
      reason: `验收文件里没有一条用例真正执行过（pass 0 / todo ${stats.todo} / skipped ${stats.skipped}）—— todo 与 skip 不算验证`,
    };
  }

  return {
    ok: false,
    reason: '验收命令跑完了，但没有任何用例被执行（pass 0）—— 验收文件是空的或全被跳过',
  };
}
