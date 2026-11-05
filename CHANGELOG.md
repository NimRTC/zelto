# Changelog

## [Unreleased]

### Added
- Planning confirmation is now a review view instead of a wall of markdown:
  `zelto require|design|plan show <id>` prints a summary, the **decision points**
  (acceptance criteria, modules, module dependencies, versions, slices — each
  marked added / removed / changed) and, with `--diff`, the change against the
  previous revision; `--full` appends the body (ADR-023).
- Draft revisions are snapshotted before every refine, so "what changed" is
  always visible. Snapshots live in `.zelto/revisions/<kind>/<id>/`.
- New event types `draft.created` / `draft.revised` / `draft.confirmed` —
  changes to a requirement, design or version plan are now traceable.
- `zelto pipeline status` lists the drafts that still need confirmation and
  the exact command to review them.
- LLM credentials can come from the environment instead of a file:
  `ZELTO_LLM_API_KEY` > `DEEPSEEK_API_KEY` > `llm.apiKey` in `.zelto/config.yaml`
  (ADR-022). `baseUrl` / `model` / `pricing` stay in the config file so the
  project remains reproducible.
- The config file can point at the environment itself: `apiKey: "${NIMRTC_LLM_API_KEY}"`
  in `.zelto/config.yaml` is replaced with that variable's value, so the key never
  touches disk (ADR-026). If the variable is unset, zelto reports "no key" with a
  warning — the literal `${...}` text is never sent as a credential. Only whole-value
  references are expanded; `"prefix-${FOO}"` is left as-is.
- `pnpm check:credentials` — scans changed, untracked and tracked files for
  credentials before a commit; wired into CI as a gate

### Fixed
- `zelto config` with no subcommand now shows the configuration instead of
  printing usage text — the "show configuration" branch was unreachable.
- `zelto config get llm.apiKey` masks the credential by default; the real
  value requires an explicit `--raw`. Previously the full key went to stdout,
  which is a leak vector in terminals and CI logs. `zelto config set` masks
  the value it echoes back for secret keys too.
- Files written with a UTF-8 BOM (common on Windows) no longer break requirement
  / design / plan / revision parsing; `show` reports a readable error instead
  of throwing a stack trace.
- The Claude Agent SDK adapter now passes its `AbortController` to the SDK, so
  `stop()` and the timeout actually terminate the spawned Claude Code process.
  Previously the controller was created but never wired up, which left the child
  process running and made "halt" a no-op in practice.
- `waitForExit()` no longer hangs when the session already exited before the
  call
- `run*.txt` is git-ignored — test-run logs are local artifacts, not sources

## [0.4.0] — 2026-11-04

### Added
- `zelto halt` — emergency halt for a running batch; halted slices roll back to
  `frozen` with `human_halt` (ADR-020)
- `zelto batch` — admission review for a batch of slices: freeze / traceability /
  acceptance / budget checks plus dependency layering and write-set conflict detection
- `zelto merge` — merge is now an explicit action, decoupled from signing;
  `--push` lives on `merge` (ADR-018)
- `sign --revoke` — revoke an approved sign-off; writes `sign.revoked`, keeps the record (ADR-021)
- Version-level orchestration and a single parallel execution path
  (`executeSlicesParallel()`) shared by `run --parallel` and `version start` (ADR-017)
- Phased execution — topological layering by slice dependencies; overlapping write
  sets within a phase degrade to serial (ADR-019)
- Git hooks are installed only into managed projects; default-deny rules warn
  instead of blocking

### Changed
- `sign --approve` no longer auto-merges
- `zelto run --hotfix` requires an explicit `--yes`
- Removed `zelto version start --auto`

### Fixed
- Acceptance-test mock commands now use `process.exitCode=N`, fixing a POSIX shell
  syntax error that failed 8 tests on Linux CI

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
