// Shell completion command — generates bash/zsh/fish completion scripts
// Usage: zelto completion bash | source /dev/stdin

import { register } from './shared.js';
import { COMMAND_CATALOG } from './catalog.js';

// 命令列表来自命令目录（catalog.ts）——和 `zelto help` 同源，不会各写一份。
const COMMANDS = COMMAND_CATALOG.map((c) => c.name);

const SUBCOMMANDS: Record<string, string[]> = {
  require: ['list', 'confirm', 'refine'],
  design: ['list', 'confirm', 'refine'],
  plan: ['list', 'confirm', 'add-version'],
  version: ['status', 'start', 'deliver'],
  project: ['scan', 'init', 'design', 'slice', 'status'],
  sign: ['--approve', '--reject'],
  policy: ['list', 'show', 'check', 'validate', 'add', 'remove', 'edit'],
  hook: ['--install', '--uninstall', '--status'],
  stall: ['--auto-resolved'],
  status: ['--watch', '--json'],
  snapshot: ['list', 'show'],
  run: ['--dry-run', '--agent', '--adapter', '--hotfix', '--yes'],
  start: ['--title', '--writes', '--agent', '--yes', '--adapter'],
  create: ['--title', '--writes'],
  slice: ['--json'],
  set: ['--field', '--value'],
  config: ['get', 'set'],
  clarify: ['--auto', '--dry-run'],
  report: ['--format'],
  completion: ['bash', 'zsh', 'fish'],
  gate: ['--retry', '--dry-run', '--json'],
  trace: ['--json', '--graph', '--timeline', '--slice'],
  init: ['--force', '--with-examples'],
  merge: ['plan', '--strategy', '--dry-run', '--push'],
  artifact: ['check'],
  reservation: ['list', 'active', 'show', 'release', 'reap'],
  'spec-md': ['validate', 'run'],
  dashboard: ['--watch', '--open', '--output'],
  depgraph: ['--depends-on'],
  batch: ['--depends-on'],
};

register('completion', async (args) => {
  const shell = args[0] || 'bash';

  if (shell === 'bash') {
    // Generate bash completion with subcommand support
    console.log(`# zelto bash completion
# Source: source <(zelto completion bash)

_zelto_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local prev=\${COMP_WORDS[COMP_CWORD-1]}

  if [ \$COMP_CWORD -eq 1 ]; then
    COMPREPLY=($(compgen -W '${COMMANDS.join(' ')}' -- "\$cur"))
    return 0
  fi

  # Subcommand completions
  case \${COMP_WORDS[1]} in
${Object.entries(SUBCOMMANDS).map(([cmd, subs]) =>
    `    ${cmd}) COMPREPLY=($(compgen -W '${subs.join(' ')}' -- "\$cur")); return 0 ;;`
  ).join('\n')}
  esac
}
complete -F _zelto_completions zelto
`);
  } else if (shell === 'zsh') {
    const cmdDefs = COMMANDS.map(c => `'${c}:zelto command'`).join(' ');
    const subcmdCases = Object.entries(SUBCOMMANDS).map(([cmd, subs]) =>
      `      ${cmd}) _arguments '1: :(${subs.join(' ')})' ;;`
    ).join('\n');
    console.log(`# zelto zsh completion
#compdef zelto
_zelto() {
  local -a cmds
  cmds=(${cmdDefs})

  if [ \$CURRENT -eq 2 ]; then
    _describe 'command' cmds
  else
    case \${words[2]} in
${subcmdCases}
      *) _message 'unknown command' ;;
    esac
  fi
}
compdef _zelto zelto
`);
  } else if (shell === 'fish') {
    const fishCmds = COMMANDS.join(' ');
    const fishSubcmds = Object.entries(SUBCOMMANDS).map(([cmd, subs]) =>
      `complete -c zelto -n '__fish_use_subcommand' -a '${cmd}' -f
complete -c zelto -n '__fish_seen_subcommand_from ${cmd}' -f -a '${subs.join(' ')}'`
    ).join('\n');
    console.log(`# zelto fish completion
complete -c zelto -f -a '${fishCmds}'
${fishSubcmds}
`);
  } else {
    console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
    return 1;
  }
  return 0;
});
