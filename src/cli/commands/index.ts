// Command registry — imports all command group files (they call register() as side effects)
// and exports the commands record + runCLI entry point.

import { createLlmFromConfig } from './shared.js';
import { commands } from './shared.js';
import { OutputFormat, setDefaultFormatter, getDefaultFormatter, initFormatter } from '../output-formatter.js';

// Import all command group files — these call register() as module-level side effects
import './core-slice.js';
import './question.js';
import './slices.js'; // Overrides slices from core-slice with --active/--json support
import './slice-detail.js';
import './config.js';
import './gate-sign.js';
import './info-help.js';
import './ai-pipeline.js';
import './panoramic-project.js';
import './trace/trace.js';
import '../policy/index.js';
import './completion.js';
import './audit.js';
import './snapshot.js';
import './diff.js';
import './diff-highlight.js';
import './patch-content.js';
import './spec-md.js';
import './slice-status.js';
import './drift.js';
import './dashboard.js';
import './depgraph.js';
import './artifact.js';
import './batch.js';
import './halt.js';
import './merge.js';
import './architecture.js';
import './slice-spec.js';
import './contract.js';

/**
 * 近形命令别名 —— 常见拼错 / 复数形式的直达表。
 *
 * 实测缺陷 D-5：`zelto requirement list`（`require` 的复数）不是已注册命令，
 * 于是掉进了 **LLM 自然语言路由** —— 返回一段「需求似乎不够明确」的提示。
 * 人会以为自己拼错了命令，或者以为工具没听懂。
 *
 * 实际上命令名是 `zelto require list`。这类错误**不该动用 LLM**：
 * LLM 路由的成本是「调一次模型」，而它给出的答案还比一条明确的提示更糟
 * —— 它让人以为工具「懂了但没找到」，而不是「命令名不对」。
 *
 * 所以：近形命令先查这张表，命中就直接执行对应的真命令；
 * 不命中才交给 LLM 路由。
 *
 * 键是小写的完整命令词；值是真命令名。
 */
const COMMAND_ALIASES: Record<string, string> = {
  // requirement / requirements → require
  requirement: 'require',
  requirements: 'require',
  req: 'require',
  reqs: 'require',
  // design / designs → design（design 本身就是命令名，留作示例）
  designs: 'design',
  // plan / plans → plan
  plans: 'plan',
  // slice / slices（slices 已是命令名）
  slice: 'slices',
  // spec / specs → spec 相关命令
  specs: 'spec',
  // version / versions → version
  versions: 'version',
  // merge / merging
  merging: 'merge',
  // sign / signing
  signing: 'sign',
  // gate / gating
  gating: 'gate',
  // check / checking
  checking: 'check',
  // freeze / freezing
  freezing: 'freeze',
  // run / runs
  runs: 'run',
  // create / creates
  creates: 'create',
  // show / shows
  shows: 'show',
  // list / lists
  lists: 'list',
  // status / statuses
  statuses: 'status',
  // audit / audits
  audits: 'audit',
  // events / event
  event: 'events',
  // trace / traces
  traces: 'trace',
  // policy / policies
  policies: 'policy',
  // dashboard / dashboards
  dashboards: 'dashboard',
  // snapshot / snapshots
  snapshots: 'snapshot',
  // artifact / artifacts
  artifacts: 'artifact',
  // batch / batches
  batches: 'batch',
  // config / configs
  configs: 'config',
};

export async function runCLI(argv: string[]): Promise<number> {
  // ─── Parse global flags ──────────────────────────────────────────────────
  const formatIdx = argv.indexOf('--format');
  let globalFormat: OutputFormat | undefined;
  if (formatIdx >= 0 && formatIdx + 1 < argv.length) {
    const formatStr = argv[formatIdx + 1].toLowerCase();
    if (formatStr === 'json') globalFormat = OutputFormat.JSON;
    else if (formatStr === 'yaml') globalFormat = OutputFormat.YAML;
    else if (formatStr === 'terminal') globalFormat = OutputFormat.Terminal;
    // Remove --format and its value from argv
    argv.splice(formatIdx, 2);
  }

  // ─── Initialize OutputFormatter ──────────────────────────────────────────
  // Pre-load YAML serializer if needed
  await initFormatter();

  const formatter = getDefaultFormatter();
  if (globalFormat !== undefined) {
    formatter.setFormat(globalFormat);
  }
  setDefaultFormatter(formatter);

  const [cmd, ...rest] = argv;

  // Handle --version and -v flags
  if (cmd === '--version' || cmd === '-v') {
    const { getVersionString } = await import('../version.js');
    formatter.out(getVersionString());
    return 0;
  }

  if (!cmd || cmd === '--help') {
    return commands.help?.([]) ?? 0;
  }

  // zelto help <cmd> — pass the rest args to help handler
  if (cmd === 'help') {
    return commands.help?.(rest) ?? 0;
  }

  // 近形命令别名（D-5）：`requirement` → `require` 这类拼法先查表，
  // 命中就直接跑真命令 —— 不该为「命令名拼错」付一次 LLM 调用的代价。
  const alias = COMMAND_ALIASES[cmd.toLowerCase()];
  const resolvedCmd = alias && commands[alias] ? alias : cmd;

  const handler = commands[resolvedCmd];
  if (!handler) {
    // Unknown command — try LLM-powered natural language routing
    const llm = createLlmFromConfig('llm-router', 'cli');
    if (llm) {
      const { routeAndExecute } = await import('../llm-router.js');
      const fullInput = [cmd, ...rest].join(' ');
      return routeAndExecute(fullInput, llm, commands);
    }
    formatter.error('UNKNOWN_COMMAND', `Unknown command: ${cmd}`);
    formatter.out('Run "zelto help" for usage.', { stderr: false });
    return 1;
  }

  return handler(rest);
}
