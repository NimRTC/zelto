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

  const handler = commands[cmd];
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
