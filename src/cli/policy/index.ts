/**
 * policy/index.ts — `zelto policy` command group
 *
 * Registers the `policy` command with subcommands (list, check, validate, …).
 * Imported as a side effect by `src/cli/commands/index.ts`.
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { register, optionValueStrict } from '../commands/shared.js';
import { isValidAction } from '../../core/policy/validator.js';
import { listPolicyRules } from './commands/list.command.js';
import { checkPolicy } from './commands/check.command.js';
import { validatePolicy } from './commands/validate.command.js';
import { addPolicyRule } from './commands/add.command.js';
import { removePolicyRule } from './commands/remove.command.js';
import { editPolicyRule } from './commands/edit.command.js';
import { showPolicyRuleCommand } from './commands/show.command.js';
import { lockPolicy } from './commands/lock.command.js';
import {
  addArchGuardCommand,
  editArchGuardCommand,
  listArchGuardsCommand,
  removeArchGuardCommand,
  ARCH_KINDS,
} from './commands/arch.command.js';

// ─── Subcommand dispatch ─────────────────────────────────────────────────────

register('policy', async (args) => {
  const subcmd = args[0];

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    console.log(`
${'Usage:'}
  zelto policy list [--json]
  zelto policy check <path> [--operation <op>] [--json]
  zelto policy validate [--update] [--json]
  zelto policy add <rule-id> --path <path> [--operation <op>] --action <action> --basis <basis> [options]
  zelto policy remove <rule-id> [--json]
  zelto policy edit <rule-id> [--path <path>] [--operation <op>] [--action <action>] [--basis <basis>] [options]
  zelto policy lock [--update] [--json]

${'Arch guard rules (the "arch:" section):'}
  zelto policy arch list [--json]
  zelto policy arch add <kind> --action <action> --basis <basis> [--guidance <text>]
  zelto policy arch edit <kind> [--action <action>] [--basis <basis>] [--guidance <text>]
  zelto policy arch remove <kind> [--json]

${'Subcommands:'}
  list      List all policy rules
  check     Check a path+operation against policy rules
  validate  Validate the policy.yaml configuration (--update re-anchors on mismatch)
  add       Add a new rule to policy.yaml
  remove    Remove a rule from policy.yaml
  edit      Edit an existing rule in policy.yaml
  lock      Show the policy hash anchor (policy/lock.json); --update re-anchors explicitly
  arch      Manage the arch: section (architecture guard rules)

${'Options:'}
  --json        Output in JSON format
  --operation   Operation to check (read|write|execute); default: write
  --path        Glob pattern for the rule (add/edit)
  --action      Action for the rule: allow|deny|ask (add/edit)
  --basis       Justification basis for the rule (add/edit)
  --guidance    Guidance message for the rule (add/edit)
  --description Human-readable description (add/edit)
  --priority    Rule priority, lower = higher precedence (add/edit)
  --update      Re-anchor the policy hash explicitly (policy lock / policy validate)
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
    return validatePolicy({ json: isJson, update: rest.includes('--update') });
  }

  // ─── arch: 段（架构护栏规则的编辑器，ADR-068）────────────────────────
  if (subcmd === 'arch') {
    return runArchSubcommand(args.slice(1));
  }

  if (subcmd === 'show') {
    const rest = args.slice(1);
    const ruleId = rest.find((a) => !a.startsWith('--'));
    if (!ruleId) {
      console.error('Error: <rule-id> is required for "policy show".');
      console.error('Usage: zelto policy show <rule-id> [--json]');
      return 1;
    }
    const isJson = rest.includes('--json');
    return showPolicyRuleCommand({ ruleId, json: isJson });
  }

  if (subcmd === 'add') {
    const rest = args.slice(1);
    const ruleId = rest.find((a) => !a.startsWith('--'));
    if (!ruleId) {
      console.error('Error: <rule-id> is required for "policy add".');
      console.error('Usage: zelto policy add <rule-id> --path <path> [--operation <op>] --action <action> --basis <basis>');
      return 1;
    }
    const pathIndex = rest.indexOf('--path');
    const path = pathIndex !== -1 && rest[pathIndex + 1] ? rest[pathIndex + 1] : undefined;
    if (!path) {
      console.error('Error: --path is required for "policy add".');
      return 1;
    }
    const opIndex = rest.indexOf('--operation');
    const operation = opIndex !== -1 && rest[opIndex + 1] ? rest[opIndex + 1] : undefined;
    const actionIndex = rest.indexOf('--action');
    const action = actionIndex !== -1 && rest[actionIndex + 1] ? rest[actionIndex + 1] as 'allow' | 'deny' | 'ask' : undefined;
    if (!action) {
      console.error('Error: --action is required for "policy add".');
      return 1;
    }
    const basisIndex = rest.indexOf('--basis');
    const basis = basisIndex !== -1 && rest[basisIndex + 1] ? rest[basisIndex + 1] : undefined;
    if (!basis) {
      console.error('Error: --basis is required for "policy add".');
      return 1;
    }
    const guidanceIndex = rest.indexOf('--guidance');
    const guidance = guidanceIndex !== -1 && rest[guidanceIndex + 1] ? rest[guidanceIndex + 1] : undefined;
    const descIndex = rest.indexOf('--description');
    const description = descIndex !== -1 && rest[descIndex + 1] ? rest[descIndex + 1] : undefined;
    const priorityIndex = rest.indexOf('--priority');
    const priority = priorityIndex !== -1 && rest[priorityIndex + 1] ? Number.parseInt(rest[priorityIndex + 1], 10) : undefined;
    const isJson = rest.includes('--json');
    return addPolicyRule({
      ruleId,
      path,
      operation,
      action,
      basis,
      guidance,
      description,
      priority: priority !== undefined && !Number.isNaN(priority) ? priority : undefined,
      json: isJson,
    });
  }

  if (subcmd === 'remove') {
    const rest = args.slice(1);
    const ruleId = rest.find((a) => !a.startsWith('--'));
    if (!ruleId) {
      console.error('Error: <rule-id> is required for "policy remove".');
      console.error('Usage: zelto policy remove <rule-id> [--json]');
      return 1;
    }
    const isJson = rest.includes('--json');
    return removePolicyRule({ ruleId, json: isJson });
  }

  if (subcmd === 'edit') {
    const rest = args.slice(1);
    const ruleId = rest.find((a) => !a.startsWith('--'));
    if (!ruleId) {
      console.error('Error: <rule-id> is required for "policy edit".');
      console.error('Usage: zelto policy edit <rule-id> [--path <path>] [--operation <op>] [--action <action>] [--basis <basis>] [options]');
      return 1;
    }
    const pathIndex = rest.indexOf('--path');
    const path = pathIndex !== -1 && rest[pathIndex + 1] ? rest[pathIndex + 1] : undefined;
    const opIndex = rest.indexOf('--operation');
    const operation = opIndex !== -1 && rest[opIndex + 1] ? rest[opIndex + 1] : undefined;
    const actionIndex = rest.indexOf('--action');
    const action = actionIndex !== -1 && rest[actionIndex + 1] ? rest[actionIndex + 1] as 'allow' | 'deny' | 'ask' : undefined;
    const basisIndex = rest.indexOf('--basis');
    const basis = basisIndex !== -1 && rest[basisIndex + 1] ? rest[basisIndex + 1] : undefined;
    const guidanceIndex = rest.indexOf('--guidance');
    const guidance = guidanceIndex !== -1 && rest[guidanceIndex + 1] ? rest[guidanceIndex + 1] : undefined;
    const descIndex = rest.indexOf('--description');
    const description = descIndex !== -1 && rest[descIndex + 1] ? rest[descIndex + 1] : undefined;
    const priorityIndex = rest.indexOf('--priority');
    const priority = priorityIndex !== -1 && rest[priorityIndex + 1] ? Number.parseInt(rest[priorityIndex + 1], 10) : undefined;
    const isJson = rest.includes('--json');
    return editPolicyRule({
      ruleId, path, operation, action, basis, guidance, description,
      priority: priority !== undefined && !Number.isNaN(priority) ? priority : undefined,
      json: isJson,
    });
  }

  if (subcmd === 'lock') {
    const rest = args.slice(1);
    const isJson = rest.includes('--json');
    return lockPolicy({ update: rest.includes('--update'), json: isJson });
  }

  console.error(`Unknown policy subcommand: "${subcmd}"`);
  console.error('Run "zelto policy --help" for usage.');
  return 1;
});

// ─── arch 子命令组（ADR-068）─────────────────────────────────────────────

/**
 * `zelto policy arch <sub>` 的分发。
 *
 * `arch:` 段的标识是**固定的 `kind`**（六类硬偏离之一），
 * 不是任意的 `id` —— 所以每个子命令的参数空间是单一的，
 * 不需要「猜这个参数是 rule-id 还是 kind」。
 */
async function runArchSubcommand(rest: string[]): Promise<number> {
  const sub = rest[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
${'Usage:'}
  zelto policy arch list [--json]
  zelto policy arch add <kind> --action <action> --basis <basis> [--guidance <text>]
  zelto policy arch edit <kind> [--action <action>] [--basis <basis>] [--guidance <text>]
  zelto policy arch remove <kind> [--json]

${'Subcommands:'}
  list      List the arch: section (architecture guard rules)
  add       Add an arch guard rule
  edit      Edit an existing arch guard rule
  remove    Remove an arch guard rule

${'Options:'}
  --json        Output in JSON format
  --action      Action for the guard rule: allow|deny|ask
  --basis       Justification basis for the guard rule
  --guidance    Guidance message for the guard rule

${'Kinds:'}
  ${ARCH_KINDS.join(', ')}
    `);
    return 0;
  }

  const isJson = rest.includes('--json');

  // **子命令名自己不是位置参数** —— `rest[0]` 是 'add' / 'edit' / 'remove'。
  // 取位置参数必须从 `rest[1]` 开始找，否则会把子命令名当成 kind。
  const positional = rest.slice(1).filter((a) => !a.startsWith('--'));

  if (sub === 'list') {
    return listArchGuardsCommand({ json: isJson });
  }

  if (sub === 'add') {
    const kind = positional[0];
    if (!kind) {
      console.error('Error: <kind> is required for "policy arch add".');
      console.error(`Usage: zelto policy arch add <kind> --action <action> --basis <basis>`);
      console.error(`Kinds: ${ARCH_KINDS.join(', ')}`);
      return 1;
    }
    const action = optionValueStrict(rest, '--action');
    if (!action) {
      console.error('Error: --action is required for "policy arch add".');
      console.error('Usage: zelto policy arch add <kind> --action <allow|deny|ask> --basis <basis>');
      return 1;
    }
    if (!isValidAction(action)) {
      console.error(`Error: --action must be one of: allow, deny, ask (got "${action}")`);
      return 1;
    }
    const basis = optionValueStrict(rest, '--basis');
    if (!basis) {
      console.error('Error: --basis is required for "policy arch add".');
      console.error('Usage: zelto policy arch add <kind> --action <action> --basis <basis>');
      return 1;
    }
    const guidance = optionValueStrict(rest, '--guidance');
    return addArchGuardCommand({
      kind,
      action,
      basis,
      ...(guidance !== undefined ? { guidance } : {}),
      json: isJson,
    });
  }

  if (sub === 'edit') {
    const kind = positional[0];
    if (!kind) {
      console.error('Error: <kind> is required for "policy arch edit".');
      console.error('Usage: zelto policy arch edit <kind> [--action <action>] [--basis <basis>] [--guidance <text>]');
      return 1;
    }
    const action = optionValueStrict(rest, '--action');
    if (action !== undefined && !isValidAction(action)) {
      console.error(`Error: --action must be one of: allow, deny, ask (got "${action}")`);
      return 1;
    }
    const basis = optionValueStrict(rest, '--basis');
    const guidance = optionValueStrict(rest, '--guidance');
    return editArchGuardCommand({
      kind,
      ...(action !== undefined ? { action } : {}),
      ...(basis !== undefined ? { basis } : {}),
      ...(guidance !== undefined ? { guidance } : {}),
      json: isJson,
    });
  }

  if (sub === 'remove') {
    const kind = positional[0];
    if (!kind) {
      console.error('Error: <kind> is required for "policy arch remove".');
      console.error('Usage: zelto policy arch remove <kind> [--json]');
      return 1;
    }
    return removeArchGuardCommand({ kind, json: isJson });
  }

  console.error(`Unknown policy arch subcommand: "${sub}"`);
  console.error('Run "zelto policy arch --help" for usage.');
  return 1;
}
