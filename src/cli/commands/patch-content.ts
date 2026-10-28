/**
 * patch-content.ts — `zelto patch-content` command
 *
 * Interactive CLI to split working-tree or staged git diff into
 * per-slice .patch files under .zelto/patches/.
 *
 * Supports non-interactive mode via --source and --all-to flags for
 * automation and testing.
 *
 * C4: every action writes append-only events
 * C6: cli/ depends on shared utilities from shared.ts
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { register, SLICES_DIR, ZELTO_DIR } from './shared.js';
import { colors } from '../color.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PATCHES_DIR = join(ZELTO_DIR, 'patches');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiffLine {
  index: number;
  content: string;
  /** Assigned slice id, or null if skipped */
  sliceId: string | null;
}

export interface PatchResult {
  writtenFiles: string[];
  patchesDir: string;
  source: string;
  totalLines: number;
  assignedLines: number;
  skippedLines: number;
  sliceCount: number;
}

// ─── Registration ────────────────────────────────────────────────────────────

register('patch-content', async (args: string[]) => {
  // Check for non-interactive flags
  const nonInteractiveSource = getFlagValue(args, '--source');
  const allToSlice = getFlagValue(args, '--all-to');

  if (nonInteractiveSource && allToSlice) {
    // Non-interactive mode: assign all lines to one slice
    const result = await runPatchContent(nonInteractiveSource, allToSlice);
    if (!result) return 1;
    printResult(result);
    return 0;
  }

  if (nonInteractiveSource && !allToSlice) {
    console.error('Usage: zelto patch-content --source <unstaged|staged> --all-to <slice-id>');
    console.error('  Interactive: zelto patch-content');
    return 1;
  }

  if (allToSlice && !nonInteractiveSource) {
    console.error('Usage: zelto patch-content --source <unstaged|staged> --all-to <slice-id>');
    return 1;
  }

  // ─── Interactive mode ────────────────────────────────────────────────
  return runInteractive();
});

// ─── Core Logic (shared between interactive and non-interactive) ────────────

/**
 * Run patch-content with explicit parameters (non-interactive mode).
 * Returns null on failure.
 */
export async function runPatchContent(
  source: string,
  allToSlice: string,
): Promise<PatchResult | null> {
  const diffArg = source === 'staged' ? '--cached' : '';

  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff ${diffArg}`,
      { encoding: 'utf-8', timeout: 15000, cwd: process.cwd() },
    ).trim();
  } catch {
    return null;
  }

  if (!diffOutput) {
    return null;
  }

  const rawLines = diffOutput.split('\n');
  const diffLines: DiffLine[] = rawLines.map((content, i) => ({
    index: i + 1,
    content,
    sliceId: allToSlice,
  }));

  return writePatchFiles(diffLines, source);
}

/**
 * Run interactive mode with @clack/prompts.
 */
async function runInteractive(): Promise<number> {
  const prompts = await import('@clack/prompts');
  const { select, text, isCancel, intro, outro, note, log } = prompts;

  intro(colors.bold('zelto patch-content'));

  // ─── Step 1: choose diff source ───────────────────────────────────────
  const diffSource = await select({
    message: 'Select diff source:',
    options: [
      { value: 'unstaged', label: 'Working tree changes (unstaged)' },
      { value: 'staged', label: 'Staged changes (--cached)' },
    ],
  });

  if (isCancel(diffSource)) {
    outro('Cancelled.');
    return 0;
  }

  // ─── Step 2: get diff ─────────────────────────────────────────────────
  const diffArg = diffSource === 'staged' ? '--cached' : '';
  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff ${diffArg}`,
      { encoding: 'utf-8', timeout: 15000, cwd: process.cwd() },
    ).trim();
  } catch {
    log.error('Failed to get git diff. Is this a git repository?');
    return 1;
  }

  if (!diffOutput) {
    note('No changes detected in the selected source.', 'Empty diff');
    return 0;
  }

  // ─── Step 3: split diff into lines ────────────────────────────────────
  const rawLines = diffOutput.split('\n');
  const diffLines: DiffLine[] = rawLines.map((content, i) => ({
    index: i + 1,
    content,
    sliceId: null,
  }));

  // ─── Step 4: show full diff preview ───────────────────────────────────
  showDiffPreview(diffLines);

  // ─── Step 5: get available slice IDs ──────────────────────────────────
  const sliceIds = getSliceIds();
  if (sliceIds.length === 0) {
    log.warn('No slices found. You can still enter slice IDs manually.');
  }

  // Default: most recently modified slice
  const defaultSliceId = getMostRecentSliceId(sliceIds);

  // ─── Step 6: interactive line-by-line assignment ──────────────────────
  let currentSliceId: string | null = defaultSliceId;
  let fastMode = false;

  log.info('Assigning each diff line to a slice...');
  note(
    `Enter slice ID for each line.\n` +
    `  ${colors.bold('[Enter]')}      → use default (${colors.cyan(currentSliceId ?? '(none)')})\n` +
    `  ${colors.bold('!')}            → fast mode: rest goes to current slice\n` +
    `  ${colors.bold('.')}            → skip this line\n` +
    `  ${colors.bold('?')}            → show available slice IDs\n` +
    `  ${colors.bold('q')}            → quit without saving`,
    'Instructions',
  );

  for (let i = 0; i < diffLines.length; i++) {
    if (fastMode) {
      diffLines[i].sliceId = currentSliceId;
      continue;
    }

    const line = diffLines[i];
    const linePreview = renderDiffLineForPrompt(line);

    // Show progress
    const progress = colors.dim(`[${i + 1}/${diffLines.length}]`);
    process.stdout.write(`\n${progress} ${linePreview}\n`);

    const answer = await text({
      message: `Slice ID for line ${line.index}:`,
      placeholder: currentSliceId ?? '(none)',
      validate: () => undefined, // accept any input
    });

    if (isCancel(answer)) {
      outro('Cancelled. No files written.');
      return 0;
    }

    const input = (answer as string).trim();

    if (input === 'q') {
      outro('Quit. No files written.');
      return 0;
    }

    if (input === '?') {
      // Show available slice IDs
      showSliceIds(sliceIds);
      i--; // re-ask this line
      continue;
    }

    if (input === '!') {
      // Fast mode: rest goes to current slice
      if (currentSliceId === null) {
        log.warn('No current slice set. Enter a slice ID first or press Enter to use default.');
        i--;
        continue;
      }
      fastMode = true;
      diffLines[i].sliceId = currentSliceId;
      log.success(`Fast mode activated. Remaining lines → ${colors.cyan(currentSliceId)}`);
      continue;
    }

    if (input === '.') {
      // Skip this line
      continue;
    }

    if (input === '') {
      // Use default
      diffLines[i].sliceId = currentSliceId;
      continue;
    }

    // User entered a slice ID
    currentSliceId = input;
    diffLines[i].sliceId = currentSliceId;
  }

  // ─── Step 7: generate .patch files ────────────────────────────────────
  const result = await writePatchFiles(diffLines, diffSource);
  if (!result) {
    log.warn('No lines were assigned to any slice. No patch files generated.');
    return 0;
  }

  printResult(result);
  log.success(`Done! ${result.writtenFiles.length} patch file(s) generated.`);
  outro(colors.green(`Done! ${result.writtenFiles.length} patch file(s) generated.`));
  return 0;
}

// ─── File Writing ────────────────────────────────────────────────────────────

/**
 * Write grouped diff lines into .patch files.
 * Returns null if no lines are assigned.
 */
export async function writePatchFiles(
  diffLines: DiffLine[],
  source: string,
): Promise<PatchResult | null> {
  if (!existsSync(PATCHES_DIR)) {
    mkdirSync(PATCHES_DIR, { recursive: true });
  }

  // Group lines by slice ID (skipping nulls)
  const sliceGroups = new Map<string, DiffLine[]>();
  for (const line of diffLines) {
    if (line.sliceId === null) continue;
    if (!sliceGroups.has(line.sliceId)) {
      sliceGroups.set(line.sliceId, []);
    }
    sliceGroups.get(line.sliceId)!.push(line);
  }

  if (sliceGroups.size === 0) return null;

  // Determine sequence order by first occurrence
  const orderedSliceIds: string[] = [];
  const seen = new Set<string>();
  for (const line of diffLines) {
    if (line.sliceId && !seen.has(line.sliceId)) {
      seen.add(line.sliceId);
      orderedSliceIds.push(line.sliceId);
    }
  }

  // Write patch files
  const writtenFiles: string[] = [];
  let seq = 1;
  for (const sliceId of orderedSliceIds) {
    const lines = sliceGroups.get(sliceId)!;
    const patchContent = lines.map((l) => l.content).join('\n') + '\n';

    const seqStr = String(seq).padStart(3, '0');
    const filename = `${sliceId}-${seqStr}.patch`;
    const filePath = join(PATCHES_DIR, filename);
    writeFileSync(filePath, patchContent, 'utf-8');
    writtenFiles.push(filename);
    seq++;
  }

  // Write event log
  try {
    const eventsDir = join(ZELTO_DIR, 'events');
    if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
    const eventEntry = JSON.stringify({
      ts: new Date().toISOString(),
      type: 'patch-content',
      actor: 'cli',
      payload: {
        source,
        totalLines: diffLines.length,
        assignedLines: diffLines.filter((l) => l.sliceId !== null).length,
        skippedLines: diffLines.filter((l) => l.sliceId === null).length,
        sliceCount: sliceGroups.size,
        files: writtenFiles,
      },
    });
    const eventFile = join(eventsDir, `patch-content-${Date.now()}.jsonl`);
    writeFileSync(eventFile, eventEntry + '\n', 'utf-8');
  } catch {
    // Non-fatal
  }

  return {
    writtenFiles,
    patchesDir: PATCHES_DIR,
    source,
    totalLines: diffLines.length,
    assignedLines: diffLines.filter((l) => l.sliceId !== null).length,
    skippedLines: diffLines.filter((l) => l.sliceId === null).length,
    sliceCount: sliceGroups.size,
  };
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

function showDiffPreview(diffLines: DiffLine[]): void {
  const maxPreview = process.stdout.isTTY ? 60 : diffLines.length;
  const previewLines = diffLines.slice(0, maxPreview);
  const previewContent = previewLines
    .map((l) => {
      const lineNum = String(l.index).padStart(4);
      const firstChar = l.content[0] ?? ' ';
      let colored: string;
      if (firstChar === '+') {
        colored = colors.green(l.content);
      } else if (firstChar === '-') {
        colored = colors.red(l.content);
      } else if (l.content.startsWith('@@')) {
        colored = colors.cyan(l.content);
      } else if (
        l.content.startsWith('diff --git') ||
        l.content.startsWith('index ') ||
        l.content.startsWith('---') ||
        l.content.startsWith('+++') ||
        l.content.startsWith('new file') ||
        l.content.startsWith('deleted file')
      ) {
        colored = colors.bold(l.content);
      } else {
        colored = l.content;
      }
      return `  ${colors.dim(lineNum)} ${colored}`;
    })
    .join('\n');

  // Use console.log directly since note() doesn't handle multi-line well
  console.log('');
  console.log(colors.bold('Full diff preview:'));
  console.log(previewContent);
  if (diffLines.length > maxPreview) {
    console.log(`  ${colors.dim(`... ${diffLines.length - maxPreview} more lines`)}`);
  }
  console.log('');
}

function showSliceIds(sliceIds: string[]): void {
  const cols = 3;
  const rows = Math.ceil(sliceIds.length / cols);
  console.log(colors.bold('Available slice IDs:'));
  for (let r = 0; r < rows; r++) {
    const rowParts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = r + c * rows;
      if (idx < sliceIds.length) {
        rowParts.push(`  ${colors.cyan(sliceIds[idx].padEnd(28))}`);
      }
    }
    console.log(rowParts.join(''));
  }
  console.log('');
}

function printResult(result: PatchResult): void {
  const summaryLines = result.writtenFiles.map((f) => `  ${colors.green('✓')} ${f}`).join('\n');
  console.log('');
  console.log(colors.bold('Generated patch files:'));
  console.log(summaryLines);
  console.log(`  ${colors.dim(`→ ${result.patchesDir}/`)}`);
  console.log('');
  console.log(`  ${colors.dim('Source:')}       ${result.source}`);
  console.log(`  ${colors.dim('Total lines:')}   ${result.totalLines}`);
  console.log(`  ${colors.dim('Assigned:')}      ${result.assignedLines}`);
  console.log(`  ${colors.dim('Skipped:')}       ${result.skippedLines}`);
  console.log(`  ${colors.dim('Slices used:')}   ${result.sliceCount}`);
}

function renderDiffLineForPrompt(line: DiffLine): string {
  const maxLen = 80;
  let display = line.content;
  if (display.length > maxLen) {
    display = display.slice(0, maxLen - 3) + '...';
  }

  const firstChar = display[0] ?? ' ';
  if (firstChar === '+') return colors.green(display);
  if (firstChar === '-') return colors.red(display);
  if (display.startsWith('@@')) return colors.cyan(display);
  return colors.dim(display);
}

// ─── Slice ID Helpers ────────────────────────────────────────────────────────

/**
 * Read slice IDs from .zelto/slices/ (.json files).
 * Falls back to specs/slices/ (.md files) if the json directory is empty.
 */
export function getSliceIds(): string[] {
  // Primary: .zelto/slices/*.json
  if (existsSync(SLICES_DIR)) {
    const jsonIds = readdirSync(SLICES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    if (jsonIds.length > 0) return jsonIds;
  }

  // Fallback: specs/slices/*.md
  const specsDir = join('specs', 'slices');
  if (existsSync(specsDir)) {
    const mdIds = readdirSync(specsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    if (mdIds.length > 0) return mdIds;
  }

  return [];
}

/**
 * Find the most recently modified slice by checking git log timestamps.
 */
export function getMostRecentSliceId(sliceIds: string[]): string | null {
  if (sliceIds.length === 0) return null;

  let mostRecent: string | null = null;
  let mostRecentTime = 0;

  for (const id of sliceIds) {
    // Check .zelto/slices/<id>.json first
    const jsonPath = join(SLICES_DIR, `${id}.json`);
    if (existsSync(jsonPath)) {
      try {
        const stat = execSync(
          `git log -1 --format=%ct "${jsonPath}" 2>nul || echo "0"`,
          { encoding: 'utf-8', timeout: 5000, cwd: process.cwd() },
        ).trim();
        const time = Number.parseInt(stat, 10);
        if (time > mostRecentTime) {
          mostRecentTime = time;
          mostRecent = id;
        }
      } catch { /* ignore */ }
    }

    // Also check spec file
    const specPath = join('specs', 'slices', `${id}.md`);
    if (existsSync(specPath)) {
      try {
        const stat = execSync(
          `git log -1 --format=%ct "${specPath}" 2>nul || echo "0"`,
          { encoding: 'utf-8', timeout: 5000, cwd: process.cwd() },
        ).trim();
        const time = Number.parseInt(stat, 10);
        if (time > mostRecentTime) {
          mostRecentTime = time;
          mostRecent = id;
        }
      } catch { /* ignore */ }
    }
  }

  return mostRecent;
}

// ─── Arg Helper ──────────────────────────────────────────────────────────────

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}
