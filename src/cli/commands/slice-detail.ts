// Slice detail command — show single slice details
// Usage: zelto slice <id> [--json]

import { register, store, events, hashSpecFile, resolveSpecDir } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── slice (detail) ────────────────────────────────────────────────────────

register('slice', async (args) => {
  const [subcommandOrId, ...rest] = args;
  const f = getDefaultFormatter();

  // Route subcommands
  if (subcommandOrId === 'create') {
    return handleSliceCreate(rest, f);
  }
  if (subcommandOrId === 'validate') {
    return handleSliceValidate(rest, f);
  }
  if (subcommandOrId === 'version') {
    return handleSliceVersion(rest, f);
  }

  // Default: show slice detail
  const id = subcommandOrId;
  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice <slice-id> [--json]');
    f.out('       zelto slice create <id> [--title <title>]');
    f.out('       zelto slice validate <id>');
    f.out('       zelto slice version <id>');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);
    const evts = await events.read(id);

    if (isJson) {
      f.data({
        id: slice.id,
        title: slice.title,
        state: slice.state,
        spec: slice.spec,
        acceptance: slice.acceptance,
        baseCommit: slice.baseCommit,
        drift: slice.drift,
        trace: slice.trace,
        writes: slice.writes,
        runs: slice.runs,
        stall: slice.stall,
        createdAt: slice.createdAt,
        updatedAt: slice.updatedAt,
        eventCount: evts.length,
      });
      return 0;
    }

    const specHashOk = slice.spec.frozenHash
      ? (hashSpecFile(slice.spec.path) === slice.spec.frozenHash ? '✅' : '⚠️ changed')
      : '⬜ not frozen';

    const stateIcons: Record<string, string> = {
      draft: '📝', clarifying: '❓', frozen: '❄️',
      running: '▶️', completed: '✅', abandoned: '🗑️',
    };

    f.out(`${stateIcons[slice.state] ?? '📄'} ${slice.id}`);
    f.out(`  Title:     ${slice.title}`);
    f.out(`  State:     ${slice.state}`);
    f.out(`  Spec:      ${slice.spec.path} ${specHashOk}`);
    f.out(`  Created:   ${slice.createdAt.slice(0, 10)}`);
    f.out(`  Updated:   ${slice.updatedAt.slice(0, 10)}`);
    f.out(`  Base:      ${slice.baseCommit ?? '(not set)'}`);
    f.out(`  Writes:    ${slice.writes.length > 0 ? slice.writes.join(', ') : '(none)'}`);
    f.out(`  Events:    ${evts.length}`);

    if (slice.trace.requirements.length > 0) {
      f.out(`  Reqs:      ${slice.trace.requirements.join(', ')}`);
    }
    if (slice.trace.contracts.length > 0) {
      f.out(`  Contracts: ${slice.trace.contracts.join(', ')}`);
    }
    if (slice.trace.tests.length > 0) {
      f.out(`  Tests:     ${slice.trace.tests.join(', ')}`);
    }

    if (slice.drift.detected) {
      f.out(`  Drift:     ⚠️ ${slice.drift.reason}`);
    }

    if (slice.stall.class) {
      f.out(`  Stall:     ⚠️ ${slice.stall.class} (auto-resolved: ${slice.stall.autoResolved})`);
    }

    if (slice.runs.length > 0) {
      f.out(`  Runs:      ${slice.runs.length}`);
      for (const run of slice.runs.slice(-3)) {
        f.out(`    - ${run.at.slice(0, 19).replace('T', ' ')}  ${run.ok ? '✔ ok' : '✘ failed'}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`);
      }
      if (slice.runs.length > 3) f.out(`    ... (${slice.runs.length - 3} more)`);
    }

    // Show last 5 events
    if (evts.length > 0) {
      f.out(`\n  Recent events:`);
      for (const e of evts.slice(-5)) {
        f.out(`    [${e.ts?.slice(0, 19) ?? '?'}] ${e.type} (${e.actor})`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('READ_ERROR', `Error reading slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});

// ─── slice set (edit slice fields) ─────────────────────────────────────────

const SLICE_SETTABLE_FIELDS = new Set([
  'title', 'traceWaiver', 'writes', 'acceptance.dir',
  'trace.requirements', 'trace.contracts', 'trace.tests',
  'baseCommit', 'baseline', 'spec.gateCommands',
]);

register('set', async (args) => {
  const [id] = args;
  const f = getDefaultFormatter();

  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto set <slice-id> --field <name> --value <val> [--json]');
    f.out('');
    f.out('Settable fields:');
    for (const field of [...SLICE_SETTABLE_FIELDS].sort()) {
      f.out(`  ${field}`);
    }
    return 1;
  }

  const isJson = args.includes('--json');
  const fieldIdx = args.indexOf('--field');
  const valueIdx = args.indexOf('--value');

  if (fieldIdx < 0 || valueIdx < 0) {
    f.error('MISSING_ARGS', 'Both --field and --value are required');
    return 1;
  }

  const field = args[fieldIdx + 1];
  const rawValue = args[valueIdx + 1];

  if (!field || !rawValue) {
    f.error('MISSING_ARGS', 'Both --field and --value require a value');
    return 1;
  }

  if (!SLICE_SETTABLE_FIELDS.has(field)) {
    f.error('INVALID_FIELD', `Unknown field: "${field}". Use --help to list settable fields.`);
    return 1;
  }

  try {
    const slice = await store.read(id);
    const prevState = slice.state;

    // Parse value: comma-separated for array fields, boolean for boolean fields
    if (field === 'writes' || field === 'trace.requirements' || field === 'trace.contracts' || field === 'trace.tests') {
      const values = rawValue.split(',').map((v: string) => v.trim()).filter(Boolean);
      if (field === 'writes') {
        // 写集路径统一成**正斜杠**并去重（ADR-051 配套）：
        // 写集路径要与策略引擎、hook 的判定对齐，那些地方都按正斜杠归一。
        // 不归一时同一个文件会出现两次（`a/b` 与 `a\b`）——
        // 重复项让「写集覆盖了什么」这件事说不清。
        const seen = new Set<string>();
        slice.writes = values
          .map((v: string) => v.replace(/\\/g, '/'))
          .filter((v: string) => {
            if (seen.has(v)) return false;
            seen.add(v);
            return true;
          });
      }
      else if (field === 'trace.requirements') slice.trace.requirements = values;
      else if (field === 'trace.contracts') slice.trace.contracts = values;
      else if (field === 'trace.tests') slice.trace.tests = values;
    } else if (field === 'baseline') {
      slice.baseline = rawValue === 'true' || rawValue === '1';
    } else if (field === 'title') {
      slice.title = rawValue;
    } else if (field === 'traceWaiver') {
      slice.traceWaiver = rawValue || null;
    } else if (field === 'acceptance.dir') {
      slice.acceptance.dir = rawValue;
    } else if (field === 'baseCommit') {
      slice.baseCommit = rawValue || null;
    } else if (field === 'spec.gateCommands') {
      // 格式：JSON 数组（ADR-051）。
      //
      // 为什么用 JSON 而不是 `name=run` 逗号分隔：门禁命令里**经常**有逗号
      // （`-DFOO=a,b`、多参数 cmake 调用），也经常有引号（`-G "Visual Studio 17 2022"`）。
      // 任何基于分隔符的格式都会在这里切错 —— 实测就把
      // `-G "Visual Studio 17 2022"` 切成了两半。
      //
      // JSON 是无歧义的：值是一个数组，每项 {name, run}。
      //
      // 还支持 `@<文件路径>`：值从文件读。命令行里的引号经过 shell 转义
      // 会被吃掉（Windows 上尤其明显），文件是可靠的通道。
      let raw = rawValue;
      if (raw.startsWith('@')) {
        raw = readFileSync(raw.slice(1).trim(), 'utf-8');
      }
      let parsed: Array<{ name: string; run: string }>;
      try {
        const rawJson = JSON.parse(raw);
        if (!Array.isArray(rawJson)) throw new Error('期望一个数组');
        parsed = rawJson.map((item: unknown) => {
          if (typeof item === 'string') {
            throw new Error('数组元素应为 {name, run} 对象，不是字符串');
          }
          const entry = item as { name?: unknown; run?: unknown };
          if (typeof entry.name !== 'string' || typeof entry.run !== 'string') {
            throw new Error('每个元素都要有字符串的 name 与 run');
          }
          return { name: entry.name, run: entry.run };
        });
      } catch (err) {
        throw new Error(
          `门禁命令格式应为 JSON 数组，如 [{"name":"build","run":"cmake --build build"}]：` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      slice.spec.gateCommands = parsed;
    }

    await store.write(slice);
    await events.append(id, 'spec.drafted', 'cli', {
      sliceId: id, field, fromValue: prevState, action: 'slice.set',
    });

    if (isJson) {
      f.data({ success: true, id, field, value: rawValue });
      return 0;
    }

    f.out(`zelto set ${id} — ✅ Updated ${field}`);
    f.out(`  ${field}: ${rawValue}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('SET_ERROR', `Error updating slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});

// ─── Spec template generator ──────────────────────────────────────────────

/**
 * Generate the standard slice spec markdown template.
 */
function generateSpecTemplate(id: string, title: string): string {
  return [
    `# Slice: ${id}`,
    '',
    '## 目的',
    title,
    '',
    '## 范围',
    '',
    '## 验收标准',
    '',
    '## 风险',
    '- 无',
    '',
    '## 参考',
    '',
  ].join('\n');
}

// ─── slice create ──────────────────────────────────────────────────────────

async function handleSliceCreate(args: string[], f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  const id = args[0];
  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice create <id> [--title <title>]');
    return 1;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    f.error('INVALID_ID', `Invalid slice ID: "${id}". Use only letters, numbers, hyphens, and underscores.`);
    return 1;
  }

  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args[titleIdx + 1] : '';

  const specDir = resolveSpecDir();
  const specPath = join(specDir, `${id}.md`);

  if (existsSync(specPath)) {
    f.error('EXISTS', `Spec file already exists: ${specPath}`);
    return 1;
  }

  // Create spec directory if needed
  if (!existsSync(specDir)) {
    mkdirSync(specDir, { recursive: true });
  }

  const content = generateSpecTemplate(id, title);
  writeFileSync(specPath, content, 'utf-8');

  f.out(`zelto slice create ${id} — ✅ Created`);
  f.out(`  File:  ${specPath}`);
  f.out(`  Title: ${title || '(edit ## 目的 to fill in)'}`);
  f.out(`  Next:  Edit ${specPath} with the spec details, then:`);
  f.out(`         zelto create ${id} --from-spec`);
  return 0;
}

// ─── slice validate ────────────────────────────────────────────────────────

const REQUIRED_SPEC_SECTIONS = ['## 目的', '## 范围', '## 验收标准', '## 风险'];

async function handleSliceValidate(args: string[], f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  const id = args[0];
  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice validate <id>');
    f.out('       zelto slice validate --all');
    return 1;
  }

  // Validate all specs
  if (id === '--all') {
    return validateAllSpecs(f);
  }

  const specDir = resolveSpecDir();
  const specPath = join(specDir, `${id}.md`);

  if (!existsSync(specPath)) {
    f.error('NOT_FOUND', `Spec file not found: ${specPath}`);
    return 1;
  }

  const content = readFileSync(specPath, 'utf-8');
  const errors = validateSpecContent(id, content);

  if (errors.length === 0) {
    f.out(`zelto slice validate ${id} — ✅ Valid`);
    return 0;
  }

  f.error('VALIDATION_ERRORS', `zelto slice validate ${id} — ❌ ${errors.length} issue(s):`);
  for (const err of errors) {
    f.out(`  - ${err}`);
  }
  return 1;
}

/**
 * Validate a spec file's content against the standard format.
 * Returns a list of error messages (empty = valid).
 */
function validateSpecContent(id: string, content: string): string[] {
  const errors: string[] = [];

  // Check # Slice: <id> header
  if (!content.includes(`# Slice: ${id}`) && !content.includes(`# Slice: ${id.replace(/-/g, ' ')}`)) {
    errors.push(`Missing or mismatched "# Slice: ${id}" header`);
  }

  // Check required sections
  for (const section of REQUIRED_SPEC_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // Check that 范围 has at least one bullet
  const lines = content.split('\n');
  let inScope = false;
  let hasScopeItems = false;
  for (const line of lines) {
    if (line.startsWith('## 范围')) {
      inScope = true;
      continue;
    }
    if (line.startsWith('## ')) {
      inScope = false;
      continue;
    }
    if (inScope && line.trimStart().startsWith('-')) {
      hasScopeItems = true;
    }
  }
  if (!hasScopeItems) {
    errors.push('## 范围 section has no bullet items');
  }

  // Check that 验收标准 has at least one numbered item
  let inAcceptance = false;
  let hasAcceptanceItems = false;
  for (const line of lines) {
    if (line.startsWith('## 验收标准')) {
      inAcceptance = true;
      continue;
    }
    if (line.startsWith('## ')) {
      inAcceptance = false;
      continue;
    }
    if (inAcceptance && /^\s*\d+\.\s+/.test(line)) {
      hasAcceptanceItems = true;
    }
  }
  if (!hasAcceptanceItems) {
    errors.push('## 验收标准 section has no numbered criteria');
  }

  return errors;
}

// ─── slice version ────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the parsed frontmatter as a record, or null if no frontmatter exists.
 * Frontmatter must be delimited by `---` at the start of the file.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx < 0) return null;

  const fmLines = content.slice(4, endIdx).split('\n');
  const result: Record<string, string> = {};

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sepIdx = trimmed.indexOf(':');
    if (sepIdx < 0) continue;
    const key = trimmed.slice(0, sepIdx).trim();
    let value = trimmed.slice(sepIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }

  return result;
}

/**
 * Show the version of a slice from its spec file's frontmatter.
 * Usage: zelto slice version <id>
 * Output: <id> v<version>
 */
async function handleSliceVersion(args: string[], f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  const [id] = args;

  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice version <id>');
    return 1;
  }

  const specDir = resolveSpecDir();
  const specPath = join(specDir, `${id}.md`);

  if (!existsSync(specPath)) {
    f.error('NOT_FOUND', `slice ${id} not found`);
    return 1;
  }

  const content = readFileSync(specPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter || !frontmatter.version) {
    f.error('NO_VERSION', `slice ${id} has no version`);
    return 1;
  }

  f.out(`${id} v${frontmatter.version}`);
  return 0;
}

/**
 * Validate all spec files in the spec directory.
 */
async function validateAllSpecs(f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  const { readdirSync } = await import('node:fs');
  const specDir = resolveSpecDir();

  if (!existsSync(specDir)) {
    f.error('NOT_FOUND', `Spec directory not found: ${specDir}`);
    return 1;
  }

  const files = readdirSync(specDir).filter((fn) => fn.endsWith('.md'));
  if (files.length === 0) {
    f.out('No spec files found.');
    return 0;
  }

  let validCount = 0;
  let invalidCount = 0;

  for (const file of files) {
    const sliceId = file.replace(/\.md$/, '');
    const content = readFileSync(join(specDir, file), 'utf-8');
    const errors = validateSpecContent(sliceId, content);
    if (errors.length === 0) {
      f.out(`  ✅ ${sliceId}`);
      validCount++;
    } else {
      f.error('INVALID', `  ❌ ${sliceId}`);
      for (const err of errors) {
        f.out(`      - ${err}`);
      }
      invalidCount++;
    }
  }

  f.out(`\n${validCount} valid, ${invalidCount} invalid`);
  return invalidCount > 0 ? 1 : 0;
}
