#!/usr/bin/env node
// zelto CLI — entry point

import { runCLI } from './commands.js';

const exitCode = await runCLI(process.argv.slice(2));
process.exit(exitCode);
