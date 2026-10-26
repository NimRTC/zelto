// Shell completion command — generates bash/zsh/fish completion scripts
// Usage: zelto completion bash | source /dev/stdin

import { register } from './shared.js';

const COMMANDS = [
  'create', 'slices', 'check', 'clarify', 'freeze', 'run', 'start',
  'admit', 'gate', 'inbox', 'sign', 'abandon', 'next', 'suggest',
  'stall', 'resume', 'events', 'init', 'summary', 'report',
  'require', 'design', 'plan', 'version', 'pipeline',
  'project', 'trace', 'impact', 'hook', 'help', 'completion',
];

register('completion', async (args) => {
  const shell = args[0] || 'bash';

  if (shell === 'bash') {
    console.log(`# zelto bash completion
# Source: source <(zelto completion bash)

_zelto_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [ \$COMP_CWORD -eq 1 ]; then
    COMPREPLY=($(compgen -W '${COMMANDS.join(' ')}' -- "\$cur"))
    return 0
  fi
}
complete -F _zelto_completions zelto
`);
  } else if (shell === 'zsh') {
    console.log(`# zelto zsh completion
#compdef zelto
_zelto() {
  local -a cmds
  cmds=(${COMMANDS.map(c => `'${c}:see zelto help'`).join(' ')})
  _arguments '1: :->command'
  case \$state in
    command) _describe 'command' cmds ;;
  esac
}
compdef _zelto zelto
`);
  } else if (shell === 'fish') {
    console.log(`# zelto fish completion
complete -c zelto -f -a '${COMMANDS.join(' ')}'
`);
  } else {
    console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
    return 1;
  }
  return 0;
});
