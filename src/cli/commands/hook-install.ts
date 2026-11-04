// hook 安装 — git hooks + Claude Code PreToolUse 运行时钩子
//
// 两套钩子各管一段：
// - git pre-commit / pre-push：提交那一刻判定「这一批改动能不能进版本库」
// - Claude Code PreToolUse：agent 写下每一个文件的那一刻判定（ADR-014）
//
// C4: 安装/卸载都写事件（由调用方负责，这里只做纯文件操作）。

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPolicyConfig, parseConfigYaml } from './shared.js';

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** Claude Code 项目级本地设置文件（不进版本库） */
export const CLAUDE_SETTINGS_RELATIVE = join('.claude', 'settings.local.json');

/** 触发判定的工具：写文件的工具 + 能写文件的 shell */
export const PRETOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

/** 用来识别「这条 hook 是 zelto 装的」 */
const HOOK_MARKER_ARG = '--zelto-pretool';

const GIT_HOOK_MARKER = '# zelto-hook — DO NOT EDIT';

// ─── hook 入口路径 ───────────────────────────────────────────────────────────

/**
 * zelto-hook 可执行入口的绝对路径。
 *
 * 从当前模块位置推导：dist/cli/commands → dist/hook/index.js。
 * 找不到就退回 <cwd>/dist/hook/index.js。
 */
export function hookEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'hook', 'index.js'),
    resolve(process.cwd(), 'dist', 'hook', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

// ─── Claude Code PreToolUse 钩子 ────────────────────────────────────────────

export interface ClaudeHookOptions {
  /** 写 .claude/settings.local.json 的目录 —— agent 实际工作的目录（worktree） */
  root: string;
  /**
   * 主仓库根 —— policy.yaml 与 .zelto/locks 都在这里。
   * 不给就退回 `root`（没有 worktree 时两者相同）。
   */
  projectRoot?: string | null;
  /** 切片 id；给了就按写集预约强制 */
  sliceId?: string | null;
  /** agent 实际工作目录（worktree） */
  worktree?: string | null;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: ClaudeHookEntry[] }>>;
  [key: string]: unknown;
}

/** 拼出 hook 命令行。路径统一用正斜杠，避免 shell 转义问题。 */
export function buildPreToolHookCommand(options: ClaudeHookOptions): string {
  const exec = buildPreToolHookExec(options);
  return [exec.command, ...exec.args].map(quoteArg).join(' ');
}

/**
 * 拼出 hook 的「exec 形式」：可执行文件 + 参数数组，不过 shell。
 *
 * SDK 的 `hooks` 选项支持这种形式（`command` + `args`），路径里有空格或
 * 引号也不会被 shell 重新解析 —— 比拼字符串可靠。
 */
export function buildPreToolHookExec(options: ClaudeHookOptions): {
  command: string;
  args: string[];
} {
  const entry = hookEntryPath().replace(/\\/g, '/');
  // `--project-root` 指的是**主仓库**：policy.yaml 与 .zelto/locks/<sliceId>.json 都在那里。
  // 这里曾误填成 worktree —— worktree 里没有 .zelto/（它不入版本库），
  // 于是 hook 读不到写集预约，按「预约缺失 = 拒绝」把所有写入一律拦下。
  const projectRoot = resolve(options.projectRoot ?? options.root).replace(/\\/g, '/');
  const args = [
    entry,
    'pretool',
    '--project-root',
    projectRoot,
  ];
  if (options.worktree) {
    args.push('--worktree', resolve(options.worktree).replace(/\\/g, '/'));
  }
  if (options.sliceId) {
    args.push('--slice', options.sliceId);
  }
  args.push(HOOK_MARKER_ARG);
  return { command: process.execPath, args };
}

/** 给单个参数加引号（Windows 的 cmd 与 POSIX shell 都认双引号）。 */
function quoteArg(value: string): string {
  if (value === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isZeltoHookEntry(entry: { hooks?: ClaudeHookEntry[] }): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER_ARG));
}

/**
 * 安装（或更新）Claude Code 的 PreToolUse 钩子。
 *
 * 写 `<root>/.claude/settings.local.json`；已存在的其他设置原样保留，
 * 只替换 zelto 自己那一条。
 */
export function installClaudeCodeHook(options: ClaudeHookOptions): {
  installed: boolean;
  path: string;
  message: string;
} {
  const settingsPath = join(options.root, CLAUDE_SETTINGS_RELATIVE);

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
    } catch {
      settings = {};
    }
  }

  const hooks = { ...(settings.hooks ?? {}) };
  const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoHookEntry(entry));
  preToolUse.push({
    matcher: PRETOOL_MATCHER,
    hooks: [
      {
        type: 'command',
        command: buildPreToolHookCommand(options),
      },
    ],
  });
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, path: settingsPath, message: `写入失败: ${message}` };
  }

  return { installed: true, path: settingsPath, message: '已安装' };
}

/** 卸载 zelto 装的那条 Claude Code 钩子；其他设置原样保留。 */
export function removeClaudeCodeHook(root: string): { removed: boolean; path: string } {
  const settingsPath = join(root, CLAUDE_SETTINGS_RELATIVE);
  if (!existsSync(settingsPath)) return { removed: false, path: settingsPath };

  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
    const hooks = { ...(settings.hooks ?? {}) };
    const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoHookEntry(entry));
    let removed = false;

    if (preToolUse.length !== (hooks.PreToolUse ?? []).length) {
      removed = true;
      if (preToolUse.length > 0) hooks.PreToolUse = preToolUse;
      else delete hooks.PreToolUse;
      settings.hooks = hooks;

      if (Object.keys(hooks).length === 0) delete settings.hooks;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    }
    return { removed, path: settingsPath };
  } catch {
    return { removed: false, path: settingsPath };
  }
}

/** Claude Code 钩子是否已安装。 */
export function claudeCodeHookInstalled(root: string): boolean {
  const settingsPath = join(root, CLAUDE_SETTINGS_RELATIVE);
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    return (settings.hooks?.PreToolUse ?? []).some((entry) => isZeltoHookEntry(entry));
  } catch {
    return false;
  }
}

// ─── git hooks ──────────────────────────────────────────────────────────────

export interface HookScriptOptions {
  /**
   * zelto-hook 二进制的绝对路径（正斜杠形式）。
   * 不给就退回「仓库内 dist/hook/index.js」。
   */
  binaryPath?: string | null;
  /**
   * 策略所在的项目根绝对路径（正斜杠形式）——
   * hook 靠它找到 policy/policy.yaml。给空就退回 git 仓库根。
   */
  projectRoot?: string | null;
  /** node 可执行文件路径；给空就用 PATH 里的 node。 */
  nodePath?: string | null;
}

/**
 * 生成 git hook 脚本。
 *
 * 注意判定循环用的是 `while ... done < 文件` 而不是 `echo | while ... done`：
 * 后者会在子 shell 里跑循环，循环里给 HAS_DENY 赋值传不回外层，
 * 于是「有文件被拒绝」永远传不到退出码上（这个 bug 让 pre-commit 形同虚设）。
 *
 * 拦截口径：**只有显式 deny 规则才拦**（matched_rule 不是 default）。
 * 「没有规则匹配」产生的 default deny 只告警放行 ——
 * 否则策略没覆盖到的文件会把整条提交堵死，钩子反而变成摆设。
 */
export function hookScript(name: string, condition: string, options: HookScriptOptions = {}): string {
  const binary = (options.binaryPath ?? '').replace(/\\/g, '/');
  const projectRoot = (options.projectRoot ?? '').replace(/\\/g, '/');
  const nodeBin = (options.nodePath ?? 'node').replace(/\\/g, '/');

  return `#!/bin/sh
${GIT_HOOK_MARKER}
# Auto-installed by \`zelto hook --install\`
# Runs zelto-hook policy check on ${name}

# --- 定位 zelto-hook 二进制 ---
ZELTO_HOOK="${binary}"
if [ ! -f "\$ZELTO_HOOK" ]; then
  FALLBACK="\$(git rev-parse --show-toplevel 2>/dev/null)/dist/hook/index.js"
  if [ -f "\$FALLBACK" ]; then
    ZELTO_HOOK="\$FALLBACK"
  fi
fi
if [ ! -f "\$ZELTO_HOOK" ]; then
  echo "⚠️  zelto-hook: Binary not found at \$ZELTO_HOOK"
  echo "   Rebuild zelto, then re-run 'zelto hook --install'."
  echo "   To skip zelto check: git commit --no-verify"
  exit 0
fi

# --- 策略所在的项目根 ---
ZELTO_PROJECT_ROOT="${projectRoot}"
if [ -z "\$ZELTO_PROJECT_ROOT" ]; then
  ZELTO_PROJECT_ROOT="\$(git rev-parse --show-toplevel 2>/dev/null)"
fi
export ZELTO_PROJECT_ROOT

NODE_BIN="${nodeBin}"
if [ ! -f "\$NODE_BIN" ]; then
  NODE_BIN="node"
fi

${condition}
if [ \$? -ne 0 ]; then
  FILES="${name === 'pre-commit' ? '$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)' : '$(git -c core.quotePath=false diff --name-only @{push}.. 2>/dev/null || git -c core.quotePath=false diff --name-only HEAD~1..)'}"
  if [ -z "$FILES" ]; then
    exit 0
  fi

  HAS_DENY=0
  FILE_LIST="\$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/zelto-hooks-\$\$")"
  printf '%s\\n' "$FILES" > "\$FILE_LIST"

  while IFS= read -r file; do
    if [ -n "$file" ]; then
      RESULT=\$(echo "{\\"path\\":\\"$file\\",\\"operation\\":\\"write\\",\\"harness\\":\\"git\\"}" | "\$NODE_BIN" "\$ZELTO_HOOK" 2>/dev/null)
      DECISION=\$(echo "\$RESULT" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)
      RULE=\$(echo "\$RESULT" | grep -o '"matched_rule":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "\$DECISION" = "deny" ] && [ "\$RULE" != "default" ]; then
        echo "❌ zelto-hook: DENIED write to \$file"
        BASIS=\$(echo "\$RESULT" | grep -o '"basis":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "   Basis: \$BASIS"
        HAS_DENY=1
      elif [ "\$DECISION" = "deny" ]; then
        echo "⚠️  zelto-hook: \$file 不在策略允许范围内（默认拒绝）—— 提交放行，但请确认"
      fi
    fi
  done < "\$FILE_LIST"

  rm -f "\$FILE_LIST"

  if [ "\$HAS_DENY" = "1" ]; then
    echo ""
    echo "zelto-hook: Policy check failed. Commit blocked."
    exit 1
  fi
fi
`;
}

// ─── 安装作用域：只装进「被管理的项目」 ───────────────────────────────────

export interface HookInstallScope {
  /** git hooks 装到哪个仓库根；null 表示不装 */
  root: string | null;
  /** 判定依据（打印给用户看） */
  reason: string;
}

/** 读一个目录下的 .zelto/config.yaml（用与 shared.ts 相同的解析器）。 */
function readConfigAt(dir: string): ReturnType<typeof parseConfigYaml> {
  const configPath = join(dir, ZELTO_DIR_NAME, 'config.yaml');
  if (!existsSync(configPath)) return null;
  try {
    return parseConfigYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

const ZELTO_DIR_NAME = '.zelto';

/** 这个目录是不是 zelto 工具自己的源码库（而不是被管理的项目）。 */
export function isZeltoToolCheckout(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
    if (pkg.name !== 'zelto') return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'src', 'hook', 'index.ts'));
}

/** 这个目录是不是被 zelto 管理的项目（有 .zelto/）。 */
export function isManagedProject(dir: string): boolean {
  return existsSync(join(dir, ZELTO_DIR_NAME));
}

/**
 * 决定 git hooks 装到哪个仓库。
 *
 * 规则：
 * 1. 当前目录是 zelto 工具自身的源码库 → git hooks 属于「被管理的项目」，
 *    不装在工具仓库里。改用配置里的 targetProject（若指向一个真实目录）。
 * 2. 当前目录是被管理的项目（有 .zelto/）→ 装在这里。
 * 3. 其余情况（随便一个目录）→ 不装，并说明原因。
 */
export function resolveHookInstallRoot(cwd: string = process.cwd()): HookInstallScope {
  if (isZeltoToolCheckout(cwd)) {
    const cfg = readConfigAt(cwd);
    const target = cfg?.targetProject?.path;
    if (target) {
      const dir = resolve(cwd, target);
      if (existsSync(dir)) {
        return { root: dir, reason: `zelto 工具仓库 → 被管理的项目（targetProject）：${dir}` };
      }
      return { root: null, reason: `zelto 工具仓库 → targetProject 指向的目录不存在：${dir}` };
    }
    return {
      root: null,
      reason: '这是 zelto 工具自身的源码库，且没有配置 targetProject —— git hooks 只装在被管理的项目里',
    };
  }

  if (isManagedProject(cwd)) {
    return { root: cwd, reason: `当前项目：${cwd}` };
  }

  return {
    root: null,
    reason: '当前目录不是被 zelto 管理的项目（缺少 .zelto/）—— git hooks 只装在被管理的项目里',
  };
}

/** 解析某个仓库的 git hooks 目录（worktree 下也能定位到真正的 hooks 目录）。 */
export function gitHooksDir(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

// ─── 命令实现 ───────────────────────────────────────────────────────────────

export async function hookCommand(args: string[]): Promise<number> {
  const action = args[0];
  const wantClaude = args.includes('--claude');
  const onlyClaude = args.includes('--claude-only');

  // git hooks 的作用域：只装在被管理的项目里。
  const scope = resolveHookInstallRoot(process.cwd());
  const GIT_HOOKS_DIR = scope.root ? gitHooksDir(scope.root) : null;

  async function installHook(name: string, condition: string): Promise<boolean> {
    if (!GIT_HOOKS_DIR) return false;

    const hookBinary = hookEntryPath();
    if (!existsSync(hookBinary)) {
      console.warn(`  ⚠️  zelto-hook binary not found at ${hookBinary}`);
      console.warn(`     Hooks will be installed but will skip checks until "pnpm build" is run.`);
    }

    const hookPath = join(GIT_HOOKS_DIR, name);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');
      if (!existing.includes(GIT_HOOK_MARKER) && !existing.includes('# zelto-hook')) {
        console.error(`  ⚠️  ${name} already exists (not a zelto hook). Skipping.`);
        console.error(`     Merge manually: ${hookPath}`);
        return false;
      }
    }
    mkdirSync(GIT_HOOKS_DIR, { recursive: true });
    writeFileSync(
      hookPath,
      hookScript(name, condition, {
        binaryPath: hookBinary,
        projectRoot: scope.root,
        nodePath: process.execPath,
      }),
      'utf-8',
    );
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod may fail
    }
    console.log(`  ✅ ${name} installed → ${hookPath}`);
    return true;
  }

  async function uninstallHook(name: string): Promise<boolean> {
    if (!GIT_HOOKS_DIR) return false;
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (!existsSync(hookPath)) return false;
    const existing = readFileSync(hookPath, 'utf-8');
    if (!existing.includes(GIT_HOOK_MARKER)) {
      console.error(`  ⚠️  ${name} is not a zelto hook. Skipping.`);
      return false;
    }
    try {
      unlinkSync(hookPath);
    } catch {
      writeFileSync(hookPath, '', 'utf-8');
    }
    console.log(`  ✅ ${name} uninstalled`);
    return true;
  }

  if (action === '--install') {
    if (wantClaude || onlyClaude) {
      const result = installClaudeCodeHook({ root: process.cwd() });
      if (result.installed) {
        console.log(`  ✅ Claude Code PreToolUse hook installed → ${result.path}`);
      } else {
        console.error(`  ❌ Claude Code hook install failed: ${result.message}`);
      }
      if (onlyClaude) return 0;
    }

    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
      console.log(`     Claude Code 钩子仍然安装在当前目录（agent 实际工作的地方）。`);
      return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log(`Installing zelto git hooks... (${scope.reason})`);
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await installHook('pre-commit', 'git diff --cached --quiet --exit-code')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await installHook('pre-push', 'git diff --quiet @{push}.. 2>/dev/null || git diff --quiet HEAD~1..')) count++;
    }
    console.log(`\n✅ ${count} hook(s) installed.`);
    return 0;
  }

  if (action === '--uninstall') {
    if (wantClaude || onlyClaude) {
      const result = removeClaudeCodeHook(process.cwd());
      if (result.removed) console.log(`  ✅ Claude Code PreToolUse hook uninstalled`);
      else console.log(`  ⬜ Claude Code PreToolUse hook — not installed`);
      if (onlyClaude) return 0;
    }

    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
      return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log(`Uninstalling zelto git hooks... (${scope.reason})`);
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await uninstallHook('pre-commit')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await uninstallHook('pre-push')) count++;
    }
    console.log(`\n✅ ${count} hook(s) uninstalled.`);
    return 0;
  }

  if (action === '--check' || action === '--status') {
    const checkType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
    } else {
      console.log(`  ℹ️  ${scope.reason}`);
      for (const name of checkType === 'all' ? ['pre-commit', 'pre-push'] : [checkType]) {
        const hookPath = join(GIT_HOOKS_DIR, name);
        if (existsSync(hookPath)) {
          const content = readFileSync(hookPath, 'utf-8');
          if (content.includes(GIT_HOOK_MARKER)) {
            console.log(`  ✅ ${name} — zelto hook installed`);
          } else {
            console.log(`  ⚠️  ${name} — exists but not a zelto hook`);
          }
        } else {
          console.log(`  ⬜ ${name} — not installed`);
        }
      }
    }

    const claudeInstalled = claudeCodeHookInstalled(process.cwd());
    console.log(
      claudeInstalled
        ? `  ✅ claude-code PreToolUse — installed (${join(CLAUDE_SETTINGS_RELATIVE)})`
        : `  ⬜ claude-code PreToolUse — not installed`,
    );
    return 0;
  }

  // Test a single file
  const testPath = args.find((a) => !a.startsWith('--'));
  if (testPath) {
    const { evaluatePolicy, isProtectedPath, hashPolicy } = await import('../../core/policy/engine.js');
    const config = loadPolicyConfig();
    const policyVersion = hashPolicy(JSON.stringify(config));
    const decision = evaluatePolicy(config, testPath, 'write', policyVersion);
    console.log(JSON.stringify(decision, null, 2));
    return 0;
  }

  console.error('Usage: zelto hook --install [pre-commit|pre-push|all] [--claude]');
  console.error('       zelto hook --uninstall [pre-commit|pre-push|all] [--claude]');
  console.error('       zelto hook --check [pre-commit|pre-push|all]');
  console.error('       zelto hook <file-path>');
  return 1;
}
