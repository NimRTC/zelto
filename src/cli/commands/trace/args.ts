// Argument parsing for the trace command

/** Parsed arguments for the trace command */
export interface TraceArgs {
  /** The requirement ID to trace */
  reqId: string;
  /** Output format */
  format: 'json' | 'text' | 'graph' | 'timeline';
  /** Whether --help was requested */
  help: boolean;
}

/**
 * Parse CLI arguments for the trace command.
 * Expected usage: zelto trace <requirement-id> [--json|--graph|--timeline]
 */
export function parseTraceArgs(args: string[]): TraceArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { reqId: '', format: 'text', help: true };
  }

  if (args.includes('--help') || args.includes('-h')) {
    return { reqId: '', format: 'text', help: true };
  }

  const reqId = args[0];

  let format: TraceArgs['format'] = 'text';
  if (args.includes('--json')) {
    format = 'json';
  } else if (args.includes('--graph')) {
    format = 'graph';
  } else if (args.includes('--timeline')) {
    format = 'timeline';
  }

  return { reqId, format, help: false };
}

/** Print the help/usage message for the trace command */
export function printTraceHelp(): void {
  console.log('Usage: zelto trace <requirement-id> [--json|--graph|--timeline]');
  console.log('');
  console.log('Trace a requirement through its design, plan, and slice chain.');
  console.log('');
  console.log('Arguments:');
  console.log('  <requirement-id>  The requirement to trace');
  console.log('');
  console.log('Options:');
  console.log('  --json           Output as JSON');
  console.log('  --graph          Render as ASCII tree graph');
  console.log('  --timeline       Render as vertical timeline view');
  console.log('  --help, -h       Show this help message');
}
