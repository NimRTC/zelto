// spec-md command: validate and run checklists from slice spec files
// C3: deterministic only — no model calls, no network

import { SpecMdExecutor } from '../../core/spec/SpecMdExecutor.js';
import { resolve } from 'node:path';
import { register } from './shared.js';

function getSliceRoot(): string {
  return resolve(process.cwd(), 'specs', 'slices');
}

register('spec-md', async (args) => {
  const subcommand = args[0]; // validate | run
  const sliceId = args[1];

  if (!subcommand || subcommand === '--help') {
    console.error('Usage: zelto spec-md <validate|run> <slice-id>');
    return 1;
  }

  if (!sliceId) {
    console.error('Error: please specify a slice ID');
    console.error('Usage: zelto spec-md <validate|run> <slice-id>');
    return 1;
  }

  const executor = new SpecMdExecutor(getSliceRoot());

  switch (subcommand) {
    case 'validate': {
      const result = await executor.validate(sliceId);
      if (result.valid) {
        console.log(`✅ ${sliceId}: spec file validation passed`);
      } else {
        console.error(`❌ ${sliceId}: spec file validation failed`);
        for (const err of result.errors) {
          console.error(`   - ${err}`);
        }
        return 1;
      }
      break;
    }

    case 'run': {
      const results = await executor.runChecklists(sliceId);
      let allPassed = true;
      for (const r of results) {
        if (r.passed) {
          console.log(`  ✅ ${r.text}`);
        } else {
          console.error(`  ❌ ${r.text}${r.error ? ` (${r.error})` : ''}`);
          allPassed = false;
        }
      }
      if (allPassed) {
        console.log(`\n✅ ${sliceId}: all checklists passed`);
      } else {
        console.error(`\n❌ ${sliceId}: some checklists failed`);
        return 1;
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error('Usage: zelto spec-md <validate|run> <slice-id>');
      return 1;
  }

  return 0;
});
