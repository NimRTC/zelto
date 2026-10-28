import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolve project root: from source (tests/) or compiled (dist-test/tests/)
const isDistTest = import.meta.dirname.includes('dist-test');
const PROJECT_ROOT = isDistTest
  ? resolve(import.meta.dirname, '..', '..')
  : resolve(import.meta.dirname, '..');

describe('v1-vim-syntax: Vim syntax files', () => {
  const syntaxFile = resolve(PROJECT_ROOT, 'syntax', 'zelto-slice.vim');
  const ftdetectFile = resolve(PROJECT_ROOT, 'syntax', 'ftdetect', 'zelto-slice.vim');

  // ==========================================================================
  // File existence checks
  // ==========================================================================

  it('should have syntax/zelto-slice.vim', () => {
    assert.ok(existsSync(syntaxFile), 'syntax/zelto-slice.vim does not exist');
  });

  it('should have syntax/ftdetect/zelto-slice.vim', () => {
    assert.ok(existsSync(ftdetectFile), 'syntax/ftdetect/zelto-slice.vim does not exist');
  });

  // ==========================================================================
  // syntax/zelto-slice.vim structure checks
  // ==========================================================================

  it('should start with a Vim modeline comment', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.startsWith('"'), 'File must start with a Vim comment');
  });

  it('should have b:current_syntax guard', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('b:current_syntax'),
      'Must guard against re-applying with b:current_syntax');
    assert.ok(content.includes('finish'),
      'Must use finish to prevent re-applying');
  });

  it('should set b:current_syntax at the end', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('let b:current_syntax = "zelto-slice"'),
      'Must set b:current_syntax to "zelto-slice"');
  });

  // ==========================================================================
  // Core highlight groups
  // ==========================================================================

  const REQUIRED_HIGHLIGHT_GROUPS: string[] = [
    'zeltoYAMLFrontmatter',
    'zeltoSectionTitle',
    'zeltoStatusLine',
    'zeltoRefsSlice',
    'zeltoSliceID',
    'zeltoCodeBlock',
    'zeltoChecklistDone',
    'zeltoChecklistTodo',
    'zeltoTodo',
    'zeltoBlockquote',
    'zeltoMarkdownLink',
  ];

  for (const group of REQUIRED_HIGHLIGHT_GROUPS) {
    it(`should define highlight group "${group}"`, () => {
      const content = readFileSync(syntaxFile, 'utf-8');
      assert.ok(content.includes(group),
        `Missing highlight group: ${group}`);
    });
  }

  // ==========================================================================
  // Highlight group linking
  // ==========================================================================

  it('should link all highlight groups to standard Vim groups', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    const linkPattern = /^hi def link zelto\w+\s+\w+$/gm;
    const links = content.match(linkPattern);
    assert.ok(links !== null, 'No hi def link statements found');
    assert.ok(links.length >= REQUIRED_HIGHLIGHT_GROUPS.length,
      `Expected at least ${REQUIRED_HIGHLIGHT_GROUPS.length} hi def link statements, got ${links.length}`);
  });

  // ==========================================================================
  // Syntax match / region definitions
  // ==========================================================================

  const REQUIRED_SYNTAX_DEFINITIONS: Array<{ name: string; type: 'match' | 'region' | 'keyword' }> = [
    { name: 'zeltoYAMLFrontmatter', type: 'region' },
    { name: 'zeltoSectionTitle', type: 'match' },
    { name: 'zeltoStatusLine', type: 'match' },
    { name: 'zeltoRefsSlice', type: 'match' },
    { name: 'zeltoSliceID', type: 'match' },
    { name: 'zeltoCodeBlock', type: 'region' },
    { name: 'zeltoChecklistDone', type: 'match' },
    { name: 'zeltoChecklistTodo', type: 'match' },
    { name: 'zeltoTodo', type: 'keyword' },
    { name: 'zeltoBlockquote', type: 'region' },
    { name: 'zeltoMarkdownLink', type: 'match' },
  ];

  for (const def of REQUIRED_SYNTAX_DEFINITIONS) {
    it(`should define syntax ${def.type} "${def.name}"`, () => {
      const content = readFileSync(syntaxFile, 'utf-8');
      const pattern = def.type === 'keyword'
        ? new RegExp(`syn\\s+keyword\\s+${def.name}\\s`)
        : new RegExp(`syn\\s+${def.type}\\s+${def.name}\\s`);
      assert.ok(pattern.test(content),
        `Missing syntax ${def.type} definition for ${def.name}`);
    });
  }

  // ==========================================================================
  // Pattern correctness spot checks
  // ==========================================================================

  it('should match ## section titles', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('^## .*$'),
      'Section title pattern must match ## heading lines');
  });

  it('should match [id-xxx] slice references', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('[id') && content.includes('zeltoSliceID'),
      'Slice ID pattern must match [id-xxx] references');
  });

  it('should match fenced code blocks with ```', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('```'),
      'Code block pattern must match ``` fences');
  });

  it('should match - [ ] and - [x] checklist items', () => {
    const content = readFileSync(syntaxFile, 'utf-8');
    assert.ok(content.includes('- \\[x\\]') || content.includes('- [x]'),
      'Checklist done pattern must match - [x]');
    assert.ok(content.includes('- \\[ \\]') || content.includes('- [ ]'),
      'Checklist todo pattern must match - [ ]');
  });

  // ==========================================================================
  // ftdetect file checks
  // ==========================================================================

  it('ftdetect should set filetype for specs/slices/*.md', () => {
    const content = readFileSync(ftdetectFile, 'utf-8');
    assert.ok(content.includes('specs/slices/'),
      'ftdetect must match specs/slices/ path');
    assert.ok(content.includes('set filetype=zelto-slice'),
      'ftdetect must set filetype to zelto-slice');
  });

  it('ftdetect should use BufRead,BufNewFile autocmd', () => {
    const content = readFileSync(ftdetectFile, 'utf-8');
    assert.ok(content.includes('BufRead') || content.includes('BufNewFile'),
      'ftdetect must use BufRead or BufNewFile autocmd event');
  });
});
