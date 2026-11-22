// GitHub 适配器 —— 用 `gh` CLI 实现 ForgePort（ADR-094 §6.1 / §6.4）
//
// **为什么用 `gh` 而不是自己写 REST 客户端**（ADR-094 §2.4）：
//
// 1. core/ 零第三方依赖（C2）—— 写 HTTP 客户端意味着要处理 token、
//    分页、重试、API 版本；
// 2. 凭证不落配置文件（ADR-022 精神）—— `gh` 用自己的登录态
//    （`gh auth login`），zelto 不碰 token；
// 3. core/ 不触网（C3）—— 调用只发生在**人显式执行** `zelto forge pr` 时，
//    不在任何判定路径上。
//
// **PR 是追溯链的载体，不是评审主体**（ADR-094 D7）：
// 批准权单点留在 zelto。这个适配器**不**检查 PR 是否被 approve，
// **不**在 approve 时触发合并。

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ForgeAvailability,
  ForgePort,
  ForgePrRequest,
  ForgePrResult,
} from '../../core/ports/forge.js';

/** `gh` 命令名 —— 可被环境变量覆盖，方便测试与自定义安装路径 */
const GH_BIN = process.env.ZELTO_GH_BIN ?? 'gh';

/** 一次 gh 调用的结果 */
interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 跑一次 `gh` 命令。
 *
 * **用 `execFile` + 参数数组，不用 shell 字符串**（D-69 的同一个坑）：
 * body 里有换行、有反引号、有中文，走 shell 会被拆碎。
 * 而 body 不走命令行参数 —— 它走临时文件（`--body-file`）。
 */
function runGh(args: string[], cwd?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      GH_BIN,
      args,
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf-8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? (error.message || `gh exited with ${String(code ?? 'error')}`),
          });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/** GitHub 适配器 */
export class GitHubForgeAdapter implements ForgePort {
  readonly name = 'github';

  constructor(private readonly repoRoot: string = process.cwd()) {}

  /**
   * 检查 `gh` 是否可用且已登录。
   *
   * 两项都要查：`gh` 存在但没登录时，`gh pr create` 会失败并吐一段
   * 英文提示 —— 那不如在这里说清楚（ADR-094 D10：开不了就说开不了）。
   */
  async isAvailable(): Promise<ForgeAvailability> {
    const version = await runGh(['--version'], this.repoRoot);
    if (!version.ok) {
      return {
        available: false,
        reason: `找不到 \`${GH_BIN}\` 命令（GitHub CLI 未安装或不在 PATH 里）`,
        remedy:
          '装好 GitHub CLI 并登录（gh auth login），' +
          '或手动开 PR —— 用 `zelto forge pr <id> --print-body` 拿到正文贴过去。',
      };
    }

    const auth = await runGh(['auth', 'status'], this.repoRoot);
    if (!auth.ok) {
      return {
        available: false,
        reason: `\`${GH_BIN}\` 未登录 —— ${firstLine(auth.stderr) || 'auth status 返回非零'}`,
        remedy: '先跑 `gh auth login`（凭证由 gh 自己保管，zelto 不碰 token）。',
      };
    }

    return { available: true, reason: null, remedy: null };
  }

  /**
   * 开一个 PR。
   *
   * **body 走临时文件**（`--body-file`）而不是命令行参数：
   * body 是多行 markdown，含反引号、中文、`<!-- -->` 注释块 ——
   * 走命令行参数会被 shell 拆碎（D-69 的同一个坑）。
   */
  async openPr(request: ForgePrRequest): Promise<ForgePrResult> {
    if (request.dryRun) {
      return {
        created: false,
        number: null,
        url: null,
        base: request.base,
        head: request.head,
      };
    }

    const dir = await mkdtemp(join(tmpdir(), 'zelto-forge-'));
    const bodyPath = join(dir, 'body.md');
    try {
      await writeFile(bodyPath, request.body, 'utf-8');

      const result = await runGh(
        [
          'pr',
          'create',
          '--title',
          request.title,
          '--body-file',
          bodyPath,
          '--base',
          request.base,
          '--head',
          request.head,
        ],
        this.repoRoot,
      );

      if (!result.ok) {
        throw new Error(
          `gh pr create 失败：${firstLine(result.stderr) || firstLine(result.stdout) || '未知错误'}`,
        );
      }

      // `gh pr create` 打印 PR 的 URL。
      const url = firstLine(result.stdout) || null;
      return {
        created: true,
        number: parsePrNumber(url),
        url,
        base: request.base,
        head: request.head,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // 临时目录删不掉不是阻断 —— PR 已经开了
      });
    }
  }
}

/** 从 PR URL 里抠出编号（抠不出就 null —— 不编造） */
function parsePrNumber(url: string | null): number | null {
  if (!url) return null;
  const m = /\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** 取第一行非空内容 —— 错误信息只需要第一行 */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
