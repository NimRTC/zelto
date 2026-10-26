// Command registry — imports all command group files (they call register() as side effects)
// and exports the commands record + runCLI entry point.

import { createLlmFromConfig } from './shared.js';
import { commands } from './shared.js';

// Import all command group files — these call register() as module-level side effects
import './core-slice.js';
import './gate-sign.js';
import './info-help.js';
import './ai-pipeline.js';
import './panoramic-project.js';
import './trace/trace.js';
import '../policy/index.js';
import './completion.js';
import './audit.js';
import './snapshot.js';

export async function runCLI(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  // Handle --version and -v flags
  if (cmd === '--version' || cmd === '-v') {
    const { getVersionString } = await import('../version.js');
    console.log(getVersionString());
    return 0;
  }

  if (!cmd || cmd === 'help' || cmd === '--help') {
    return commands.help?.([]) ?? 0;
  }

  const handler = commands[cmd];
  if (!handler) {
    // Unknown command — try LLM-powered natural language routing
    const llm = createLlmFromConfig();
    if (llm) {
      const { routeAndExecute } = await import('../llm-router.js');
      const fullInput = [cmd, ...rest].join(' ');
      return routeAndExecute(fullInput, llm, commands);
    }
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "zelto help" for usage.');
    return 1;
  }

  return handler(rest);
}
