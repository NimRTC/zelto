// Wrap auto-gate in useSdk check so it only fires with --sdk flag
import { readFileSync, writeFileSync } from 'node:fs';

let c = readFileSync('src/cli/commands.ts', 'utf-8');

// Pattern 1: start command's auto-gate (after exitCode === 0 in start)
// Look for the auto-gate block after "Auto-running gate②" and wrap it in if (useSdk)

// For the start command (first occurrence)
const startMarker1 = `console.log(\`\\n── Auto-running gate② ──\`);`;
const startReplacement1 = `if (useSdk) {
      console.log(\`\\n── Auto-running gate② ──\`);`;

// For the run command (second occurrence)
const startMarker2 = `console.log(\`\\n── Auto-running gate② ──\`);`;
// After the first replacement, the second occurrence still says `console.log(...`

// Actually, let's use a different approach - find the exact blocks

// In the start command, after the successful completion section
// Find: `      console.log(\`\\n── Auto-running gate② ──\`);`
// and before that add: `if (useSdk) {`
// After the auto-gate block's closing `} else {` (for gate failure), add `} else {`

// This is complex. Let me just add `if (useSdk) {` before each auto-gate block
// and close them properly.

// First, let's see what the current structure looks like
const idx1 = c.indexOf('Auto-running gate②');
if (idx1 >= 0) {
  console.log('First auto-gate at', idx1);
  console.log('Context:', c.substring(idx1 - 50, idx1 + 50));
}

const idx2 = c.indexOf('Auto-running gate②', idx1 + 10);
if (idx2 >= 0) {
  console.log('Second auto-gate at', idx2);
  console.log('Context:', c.substring(idx2 - 50, idx2 + 50));
}

// Now let's replace each occurrence
// We need to add `if (useSdk) {` before each auto-gate block
// And after the gate's else clause, we need to add the non-SDK fallback

// First occurrence (start command): add `if (useSdk) {` before the auto-gate line
// and add the non-SDK message in the else
c = c.replace(
  `      console.log(\`\\n── Auto-running gate② ──\`);`,
  `      if (useSdk) {
        console.log(\`\\n── Auto-running gate② ──\`);`
);

// For the start command, after the gate result, find the `return 0;` and add the else
c = c.replace(
  `      if (gateReport.passed) {
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(id, 'zelto');
        console.log(\`\\nzelto start \${id} — ✅ Gate passed — Sign request created (\${signReq.id})\`);
        console.log(\`  Next: zelto sign \${id} --approve\`);
      } else {
        console.log(\`\\nzelto start \${id} — ❌ Gate failed (\${gateReport.totalDurationMs.toFixed(0)}ms)\`);
        console.log(\`  Run "zelto gate \${id}" to retry manually.\`);
      }
      return 0;`,
  `      if (gateReport.passed) {
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(id, 'zelto');
        console.log(\`\\nzelto start \${id} — ✅ Gate passed — Sign request created (\${signReq.id})\`);
        console.log(\`  Next: zelto sign \${id} --approve\`);
      } else {
        console.log(\`\\nzelto start \${id} — ❌ Gate failed (\${gateReport.totalDurationMs.toFixed(0)}ms)\`);
        console.log(\`  Run "zelto gate \${id}" to retry manually.\`);
      }
      } else {
        console.log(\`  Next: zelto gate \${id}\`);
      }
      return 0;`
);

// For the run command, same pattern
// The auto-gate block in the run command is slightly different
c = c.replace(
  `      if (gateReport.passed) {
        // Auto-create sign request
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(id, 'zelto');
        console.log(\`\\n✅ Gate passed — Sign request created (\${signReq.id})\`);
        console.log(\`  Next: zelto sign \${id} --approve\`);
      } else {
        console.log(\`\\n❌ Gate failed (\${gateReport.totalDurationMs.toFixed(0)}ms)\`);
        console.log(\`  Run "zelto gate \${id}" to retry manually.\`);
      }`,
  `      if (gateReport.passed) {
        // Auto-create sign request
        const signManager = new SignManager(ZELTO_DIR, events, store);
        const signReq = await signManager.request(id, 'zelto');
        console.log(\`\\n✅ Gate passed — Sign request created (\${signReq.id})\`);
        console.log(\`  Next: zelto sign \${id} --approve\`);
      } else {
        console.log(\`\\n❌ Gate failed (\${gateReport.totalDurationMs.toFixed(0)}ms)\`);
        console.log(\`  Run "zelto gate \${id}" to retry manually.\`);
      }
      } else {
        console.log(\`  Next: zelto gate \${id}\`);
      }`
);

writeFileSync('src/cli/commands.ts', c, 'utf-8');
console.log('Done - auto-gate now gated by useSdk flag');
