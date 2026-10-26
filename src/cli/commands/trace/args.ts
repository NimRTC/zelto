// Argument parsing for the trace command

/** Parsed arguments for the trace command */
export interface TraceArgs {
  /** The requirement ID to trace */
  reqId: string;
  /** Output format */
  format: 'json' | 'text';
  /** Whether --help was requested */
  help: boolean;
}

/**
 * Parse CLI arguments for the trace command.
 * Expected usage: zelto trace <requirement-id> [--json]
 */
export function parseTraceArgs(args: string[]): TraceArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { reqId: '', format: 'text', help: true };
  }

  if (args.includes('--help') || args.includes('-h')) {
    return { reqId: '', format: 'text', help: true };
  }

  const reqId = args[0];
  const format = args.includes('--json') ? 'json' : 'text';

  return { reqId, format, help: false };
}

/** Print the help/usage message for the trace command */
export function printTraceHelp(): void {
  console.log('Usage: zelto trace <requirement-id> [--json]');
  console.log('');
  console.log('Trace a requirement through its design, plan, and slice chain.');
  console.log('');
  console.log('Arguments:');
  console.log('  <requirement-id>  The requirement to trace');
  console.log('');
  console.log('Options:');
  console.log('  --json           Output as JSON');
  console.log('  --help, -h       Show this help message');
}
