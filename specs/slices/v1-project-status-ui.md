# Slice: v1-project-status-ui

**ID:** `v1-project-status-ui`
**Status:** Draft
**Created:** 2026-10-29
**Depends on:** v1-status-command (completed)

## 1. Problem

The CLI `status` command currently outputs a raw table of slices with their
statuses.  While functional, the table is hard to parse at a glance — the
user must scan columns and mentally aggregate counts.  Teams want a
one-screen "project health" overview they can share in a terminal window or
embed in CI output.

## 2. Solution

Add `--summary` / `-s` flag to the existing `status` command.  When present,
the command emits a compact, single-block summary before the existing table.
The summary block includes:

- Project name (from `config.yaml` or CWD basename)
- Total / Completed / In-progress / Not-started slice counts
- A 40-column ASCII bar showing completion ratio
- The date of the most-recent event in the slice event log

The detailed table follows the summary unchanged so existing parsers and
grep-based workflows keep working.

## 3. Unchanged Behaviour

Everything the existing `status` command does must remain exactly as-is when
`--summary` is NOT passed.  The summary block must be the very first output,
before the table header, so a reader sees it immediately.

## 4. Interfaces

### CLI

```
zelto status --summary
zelto status -s
zelto status --summary --detailed   # show both summary and detailed table
```

### stdout (example)

```
━━━ Project Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Project:       my-agent
  Slices:        12 total  •  7 completed  •  3 in-progress  •  2 not-started
  Progress:      ██████████████████████████░░░░░░░░░░  58%
  Last activity:  2026-10-28T14:32:00Z
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Configuration

The summary colours and progress-bar width (default 40) are NOT
configurable in this slice.  They will be made configurable in a future
slice.

## 5. Data Dependencies

The slice counts are derived from `src/core/slice/slice-state.ts` (the same
aggregation used by the current `status` command).  The last-activity date
comes from the most recent event timestamp in
`.zelto/events/<slice-id>/`.

## 6. Error Handling

- If `.zelto/events/` is missing or empty, `Last activity` shows `—` (em
dash).
- If `config.yaml` is missing the `project` field, use CWD basename.
- If the project has zero slices, show `0 total  •  0 completed` and a full
  empty bar.

## 7. Test Scenarios

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Status summary with slices | `zelto status --summary` | Summary block printed, then table |
| 2 | Status without summary flag | `zelto status` | Only table, no summary block |
| 3 | Status with --detailed flag | `zelto status --summary --detailed` | Summary block printed, then table |
| 4 | Empty project (no slices) | `zelto status --summary` | Summary shows 0 total, empty bar |
| 5 | Missing events directory | `zelto status --summary` | Last activity shows `—` |
| 6 | Missing config project field | `zelto status --summary` | Uses CWD basename |
| 7 | All slices completed | `zelto status --summary` | Bar is full at 40 chars |
| 8 | Zero completed slices | `zelto status --summary` | Bar is empty (40 dots/blank) |
| 9 | Mixed progress slices | `zelto status --summary` | Bar length matches ratio |
| 10 | Invalid summary flag | `zelto status --summry` | Error: unknown flag |

## 8. Slice boundary (not in this slice)

- Configuration of summary colours / bar width (future slice)
- Alternative output formats (JSON, YAML) — only the ASCII summary is added
- Watch / live-refresh mode
- CI-optimised output (GitHub Actions annotations)

## 9. Commit trailer

```
Refs-Slice: v1-project-status-ui
```
