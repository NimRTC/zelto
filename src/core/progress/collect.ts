// 采集「做成了什么」所需的事实
//
// 这里只做**取数**：从规格、验收文件、git 事实里把判定需要的东西取出来，
// 判定本身在 `report.ts`（纯计算）。
//
// 全部是读文件 + 跑 git —— 不调模型、不触网（C3）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractAcceptanceCriteria } from '../spec/trace-extract.js';
import { buildAcceptanceCommand, resolveAcceptance } from '../gate/acceptance.js';
import { parsePorcelainStatus } from '../sched/audit.js';
import { countTodoCases, parseCaseResults, type CaseResult } from './report.js';

/**
 * 读规格里的验收标准条数。
 *
 * 读不到规格（文件没了 / 章节改名了）时返回 null ——
 * **不知道**与**零条**是两件事，混起来会让人以为「规格没要求任何东西」。
 */
export function countAcceptanceCriteria(specPath: string | null | undefined): number | null {
  if (!specPath) return null;
  try {
    if (!existsSync(specPath)) return null;
    const content = readFileSync(specPath, 'utf-8');
    return extractAcceptanceCriteria(content).length;
  } catch {
    return null;
  }
}

/**
 * 找本片验收文件里还剩多少条 `test.todo(...)`。
 *
 * 验收目标有两种形态（目录 / 单文件），这里都认。
 * 找不到就返回 0 —— 「没找到验收文件」与「验收文件里没有 todo」
 * 在判定上等价：都没有可验证的断言。
 */
export function countAcceptanceTodos(
  acceptanceDir: string | null | undefined,
  root: string,
): number {
  if (!acceptanceDir) return 0;
  const normalized = acceptanceDir.replace(/[\\/]+$/, '');
  if (!normalized) return 0;
  const abs = join(root, normalized);

  try {
    if (!existsSync(abs)) return 0;
    if (statSync(abs).isDirectory()) {
      let total = 0;
      for (const name of readdirSync(abs)) {
        const file = join(abs, name);
        try {
          if (!statSync(file).isFile()) continue;
          if (!/\.(c|m)?(js|ts)$/i.test(name)) continue;
          total += countTodoCases(readFileSync(file, 'utf-8'));
        } catch {
          /* 读不到就跳过 */
        }
      }
      return total;
    }
    return countTodoCases(readFileSync(abs, 'utf-8'));
  } catch {
    return 0;
  }
}

/**
 * 跑本片的验收测试，拿到逐条用例的结果。
 *
 * 跑不起来（命令不对、文件不存在）时返回 null ——
 * 「没跑起来」与「跑起来但全挂」是两件事，不能混。
 *
 * 这里跑的是**门禁②会跑的那条命令**（同一套定位逻辑与同一套模板），
 * 不是另起一条 —— 两处命令不一样的话，
 * 判定出来的「做成了什么」和实际放行的不是一回事。
 */
export function runAcceptanceForProgress(input: {
  acceptanceDir: string | null | undefined;
  root: string;
  commandTemplate: string;
  buildDir?: string;
  timeoutSec: number;
}): { cases: CaseResult[]; exitCode: number | null } | null {
  const { acceptanceDir, root, commandTemplate, buildDir, timeoutSec } = input;
  if (!acceptanceDir) return null;

  const resolution = resolveAcceptance(acceptanceDir, root, buildDir);
  if (!resolution.target) return null;

  const command = buildAcceptanceCommand(commandTemplate, resolution.target.files);

  try {
    const stdout = execFileSync('cmd', ['/c', command], {
      cwd: root,
      encoding: 'utf-8',
      timeout: timeoutSec * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // NODE_TEST_CONTEXT 会被子进程继承成「我是测试子进程」，
      // 于是它跳过所有用例直接 exit 0 —— 那是「假绿」（ADR-033）。
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    return { cases: parseCaseResults(stdout), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number | null };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    return { cases: parseCaseResults(output), exitCode: e.status ?? null };
  }
}

/**
 * 列出 worktree 里实际改动的文件（相对 worktree）。
 *
 * 读 git 的工作区状态 —— 已改的 + 新增的（未跟踪）。
 * 已提交的改动不在这里（那是基点之后的提交，由审计单独算）。
 *
 * **复用审计侧的 `parsePorcelainStatus`** —— 不自己抄一份正则。
 * 抄一份就会漂移：`git status --porcelain` 的状态位**可能含空格**
 * （` M file` = 工作区已改、暂存区没改），用 `\S{2}` 匹配会漏掉
 * 「只改了工作区」的文件 —— 而那恰恰是 agent 最常见的改动形态
 * （实测 D-55：` M src/util.js` 被漏掉，progress 里少列了 agent 真正做的那件事）。
 */
export function listChangedFiles(worktree: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'],
      { cwd: worktree, encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return parsePorcelainStatus(String(out));
  } catch {
    return [];
  }
}
