/**
 * audit.ts — `zelto audit` command
 *
 * Shows the audit trail for a slice, generated from the event stream.
 * Uses the existing AuditTrail class from core/audit/.
 *
 * C6: cli/ may depend on core/, but not vice versa.
 * C4: every action writes append-only events — audit reads them
 */

import { register } from './shared.js';
import { store, events } from './shared.js';
import { AuditTrail } from '../../core/audit/trail.js';
import { colors } from '../color.js';
import { writeOutput } from '../output.js';

register('audit', async (args) => {
  // `zelto audit verify <slice-id> [--json]` —— 只读校验事件哈希链（ADR-100 §4）。
  // 只读：全程只调 `EventStream.verifyChain`（读文件、纯计算），不写任何文件（C1/C4）。
  if (args[0] === 'verify') {
    const sliceId = args[1];
    const isJson = args.includes('--json');
    if (!sliceId || sliceId.startsWith('--')) {
      console.error('Usage: zelto audit verify <slice-id> [--json]');
      return 1;
    }
    const verdict = await events.verifyChain(sliceId);
    if (isJson) {
      writeOutput({ slice: sliceId, ...verdict }, undefined, { json: true });
      return verdict.ok ? 0 : 1;
    }
    console.log(`Audit verify: ${sliceId}`);
    console.log(`Chain: ${verdict.ok ? 'OK' : 'BROKEN'}`);
    console.log(`Checked: ${verdict.checked}  Unchained(老事件): ${verdict.unchained}  Head: ${verdict.head ?? '(none)'}`);
    if (verdict.failures.length > 0) {
      console.log('Failures:');
      for (const f of verdict.failures) {
        console.log(`  #${f.index} (runSeq ${f.runSeq ?? '?'}) — ${f.reason}`);
      }
      return 1;
    }
    if (verdict.checked === 0) {
      console.log('ℹ️  该流没有已上链事件（全是老格式或空流）——无链可验，不判假。');
    }
    return 0;
  }

  const sliceId = args[0];

  if (!sliceId || sliceId === '--help' || sliceId === '-h') {
    console.log(`
${'Usage:'}
  zelto audit <slice-id> [--json]

${'Description:'}
  Show the audit trail for a slice — every state change, gate result,
  sign request, and other event recorded in the event stream.

${'Options:'}
  --json  Output in JSON format
    `);
    return 0;
  }

  const isJson = args.includes('--json');

  // Verify slice exists
  try {
    await store.read(sliceId);
  } catch {
    console.error(`Slice "${sliceId}" not found.`);
    console.error('Run "zelto slices" to list all slices.');
    return 1;
  }

  const audit = new AuditTrail(events);
  const report = await audit.forSlice(sliceId);

  if (isJson) {
    writeOutput(report, undefined, { json: true });
    return 0;
  }

  // Text output
  const text = await audit.toText(sliceId);
  console.log(text);

  // Show summary
  if (report.entries.length > 0) {
    const lastEntry = report.entries[report.entries.length - 1];
    console.log('');
    console.log(`  ${colors.dim('Latest:')} ${lastEntry.summary} ${colors.dim(`(${lastEntry.eventType})`)}`);
  }

  return 0;
});
