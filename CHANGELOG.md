# Changelog

## [Unreleased]

### Added
- **Trace judgment is now a gate, not a suggestion** (ADR-032). `zelto freeze`,
  `version start` and the scheduler's admission check all refuse to let a slice
  through when its trace is incomplete — a slice with no requirement trace used
  to freeze, run an agent, pass gate② and land in the sign queue. The spec's
  「验收标准」section is materialised into the requirement trace, so the
  "every line traces to an approved spec" promise is now enforced on the path
  people actually use.
- **Slice-level acceptance** (ADR-033). `zelto spec draft` generates an
  acceptance-test skeleton (one `todo` per acceptance criterion), and gate②
  now runs *this slice's* acceptance files instead of only the whole-project
  commands. Not configured is recorded as `skipped`, never silently skipped;
  configured but unrunnable is `failed`.
- **Spec generation with human confirmation** (ADR-034).
  `zelto spec draft <id>` produces a spec draft (via the LLM when one is
  configured, deterministic fallback otherwise) plus an acceptance skeleton;
  `zelto spec confirm <id>` is what makes it the "approved source" a trace can
  point at. Drafts never participate in any judgment (C7).
- **Agent spend is now metered, and the budget gate actually closes**
  (ADR-035). Both executor adapters report their real cost via the optional
  `getUsage(sessionId)` port; the CLI records it as a `budget.spent` event
  (`source: 'agent'`) after the agent exits and re-checks the budget. A slice
  that reaches its limit **does not enter gate② and gets no sign request** —
  it stops at `frozen` and waits for a human to add budget or cut scope.
  `run.finished` now carries `costUsd`; `null` means "not measured" and is
  deliberately distinct from zero.
- **Contract evolution check and cross-version regression baseline**
  (ADR-036). `zelto contract check` compares the contracts in
  `contracts/schemas/` against a **human-confirmed baseline** and reports
  which changes are breaking, split by direction: *writer* (the new contract
  no longer accepts old data) and *reader* (the new data breaks old programs).
  The baseline is only ever updated by an explicit `zelto contract baseline` —
  accepting a break is a human's signature, never an automatic step.
  `zelto version deliver` now runs the contract check as a precondition and
  records a regression baseline from the acceptance output, comparing it with
  the previous delivered version to catch the case where a slice deletes the
  test that proved a behaviour (regressed / degraded / missing). A detected
  regression blocks delivery; `--accept-regression` records an explicit
  acceptance instead.

### Fixed
- **`zelto check` now exits non-zero on failure in text mode too** (ADR-032).
  It always returned 0, so it could not be chained into a script or a hook.
  The spec engine (`validateDeterministic` / `analyzeSemantic`) is now wired
  into `check` instead of being reachable only from tests: deterministic
  findings block, semantic heuristics only advise (C7).
- **`budgetLimitUsd: 0` now means "unlimited"** (ADR-035). The config comment
  said so, the implementation treated `0` as invalid and fell back to the
  default `1.0` — comment and code disagreeing means the setting is a lie.

## [0.5.0] — 2026-11-06

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
- `zelto arch check` and the architecture guard now pick the **project baseline
  design** (`zelto project design`, tagged `__project__`) by default instead of
  "the most recently created confirmed design". Picking a local feature design
  and comparing it against the whole repo marked every unrelated file as
  unmapped — the report was misleading and the guard could block legitimate
  write sets. Other confirmed designs are listed in the report so `--design
  <id>` is discoverable.

### Fixed
- **Policy YAML parsing now ignores quote style and inline key order**
  (ADR-028). A `deny` rule written as `path: 'secrets/**'` was parsed into the
  literal `'secrets/**'`, which never matches a real path — so the rule was
  silently skipped and the write was allowed by a broader `allow` rule.
  **Strategy written more strictly was easier to bypass.** Single quotes,
  double quotes and unquoted values are now equivalent, and
  `match: { operation: ..., path: ... }` parses the same as
  `match: { path: ..., operation: ... }`. Fixed in all three parsers
  (`core/policy/yaml.ts`, `hook/index.ts`, `hook/pretool.ts`); equivalence is
  locked by `tests/policy-parser-parity.test.ts`.
- The `arch:` section of `policy.yaml` no longer contaminates the last
  `rules:` entry in the hook parser — its `action:` / `basis:` used to be
  attached to the previous rule, which could turn an `allow` rule into a
  `deny`.
- The protected domain now has a single source of truth: `PROTECTED_PATTERNS`
  is exported from `core/policy/engine.ts` and reused by the report layer; the
  hook keeps its own copy (it must compile standalone) and
  `tests/protected-domain-parity.test.ts` asserts the two copies and their glob
  semantics stay identical.
- Every event type now has a dedicated audit summary — `sign.revoked`,
  `draft.created`, `draft.revised` and `draft.confirmed` previously fell back
  to the generic `Event: <type>` text. A test covers all 52 event types.
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
