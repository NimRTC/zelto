// CLI command dispatcher — thin re-export layer for the commands/ directory split.
// All command implementations live in src/cli/commands/*.ts

export { runCLI } from './commands/index.js';
