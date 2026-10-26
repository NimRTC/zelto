/**
 * policy/index.ts — `zelto policy` command group
 *
 * Registers the `policy` command with subcommands (list, …).
 * Imported as a side effect by `src/cli/commands/index.ts`.
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { register } from '../commands/shared.js';
import { listPolicyRules } from './commands/list.command.js';

// ─── Subcommand dispatch ─────────────────────────────────────────────────────

register('policy', async (args) => {
  const subcmd = args[0];

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    console.log(`
${'Usage:'}
  zelto policy list [--json]

${'Subcommands:'}
  list    List all policy rules

${'Options:'}
  --json  Output in JSON format
    `);
    return 0;
  }

  if (subcmd === 'list') {
    const rest = args.slice(1);
    const isJson = rest.includes('--json');
    return listPolicyRules({ json: isJson });
  }

  console.error(`Unknown policy subcommand: "${subcmd}"`);
  console.error('Run "zelto policy --help" for usage.');
  return 1;
});
