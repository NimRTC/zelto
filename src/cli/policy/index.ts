/**
 * policy/index.ts — `zelto policy` command group
 *
 * Registers the `policy` command with subcommands (list, check, validate, …).
 * Imported as a side effect by `src/cli/commands/index.ts`.
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { register } from '../commands/shared.js';
import { listPolicyRules } from './commands/list.command.js';
import { checkPolicy } from './commands/check.command.js';
import { validatePolicy } from './commands/validate.command.js';

// ─── Subcommand dispatch ─────────────────────────────────────────────────────

register('policy', async (args) => {
  const subcmd = args[0];

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    console.log(`
${'Usage:'}
  zelto policy list [--json]
  zelto policy check <path> [--operation <op>] [--json]
  zelto policy validate [--json]

${'Subcommands:'}
  list      List all policy rules
  check     Check a path+operation against policy rules
  validate  Validate the policy.yaml configuration

${'Options:'}
  --json        Output in JSON format
  --operation   Operation to check (read|write|execute); default: write
    `);
    return 0;
  }

  if (subcmd === 'list') {
    const rest = args.slice(1);
    const isJson = rest.includes('--json');
    return listPolicyRules({ json: isJson });
  }

  if (subcmd === 'check') {
    const rest = args.slice(1);
    const pathArg = rest.find((a) => !a.startsWith('--'));
    if (!pathArg) {
      console.error('Error: <path> is required for "policy check".');
      console.error('Usage: zelto policy check <path> [--operation <op>] [--json]');
      return 1;
    }
    const opIndex = rest.indexOf('--operation');
    const operation = opIndex !== -1 && rest[opIndex + 1] ? rest[opIndex + 1] : 'write';
    const isJson = rest.includes('--json');
    return checkPolicy({ path: pathArg, operation, json: isJson });
  }

  if (subcmd === 'validate') {
    const rest = args.slice(1);
    const isJson = rest.includes('--json');
    return validatePolicy({ json: isJson });
  }

  console.error(`Unknown policy subcommand: "${subcmd}"`);
  console.error('Run "zelto policy --help" for usage.');
  return 1;
});
