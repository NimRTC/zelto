# Changelog

## [0.1.0] — 2026-10-19

### Added
- Full slice lifecycle: create, freeze, check, run, gate, sign, abandon
- CLI with 17 commands: summary, init, slices, create, start, check, freeze,
  run, gate, inbox, sign, abandon, events, next, hook, help
- Policy engine with YAML-based rules and protected domains
- Git hook integration (pre-commit, pre-push) for policy enforcement
- Event stream with 29 typed event types, append-only JSONL storage
- Audit trail and metrics collector (rework rate, cycle time, stall counts)
- Budget tracking (BudgetCollector: getSpent, getLimit, isExhausted)
- Clarify engine with 5 question types, interactive and auto modes
- Scheduler with parallel admission, write-set conflict detection
- Gate executor with command running, retry, and timeout
- Sign manager with request/approve/reject workflow
- 31 signed slices, 34 test files, 11 core modules

### Infrastructure
- TypeScript + Node 22 ESM, strict mode
- Biome for formatting and linting
- Node --test for test runner
- Conventional Commits with Refs-Slice trailers
