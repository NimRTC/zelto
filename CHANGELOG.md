# Changelog

## [Unreleased]

### Added
- **驾驶舱现在能开到 VPN / 内网，手机端也能用了**（ADR-109）。
  需求是「周末在外面想看进度、想重启切片开发」。核实后发现
  **要的能力驾驶舱已经有了**，缺的是「手机连得上」与「窄屏能用」两件事 ——
  所以不是「做手机端」，是补两处缺口。
  - **Origin 校验改判 `Host` 头**（决策一）。原来判 `origin === this.url`
    （即等于启动时的地址），手机浏览器的 Origin 是
    `http://192.168.x.x:4321` → **所有 POST 被 403**，
    而「重启切片」恰恰全是 POST。现在改判 `Origin` 的 host:port 是否等于
    `Host` 头的 host:port —— 这是浏览器同源策略自己的定义，
    零配置、零维护，且「换个地址访问」时自动正确。
    **CSRF 防线一点没弱**：跨站请求的 Origin 永远是攻击者自己的域，
    不等于目标的 Host → 照拒；Origin 解析不出来 → fail closed 拒绝。
    token 仍是唯一授权凭据，两者是「与」不是「或」。
  - **`--host` 显式放开绑定面**（决策三）。默认**仍是 `127.0.0.1`**，
    既有行为一字不变；对外可达必须显式 `--host 0.0.0.0`。
    绑非回环时启动会打印警示横幅 —— 因为放开后**同网段任何设备
    `GET /` 就能读到会话 token**，然后替人签字 / 拉闸 / 开跑。
    这是人明确选择的取舍（信任网络隔离），代价在此记录在案。
    非法 `--host` 值**明确报错退出**，不静默回退到回环。
  - **窄屏适配**（决策四）：`@media (max-width: 720px)` 下表格转卡片
    （列名靠 `table()` 助手挂的 `data-label` 显示），
    导航按钮换行不再横向溢出，按钮触摸目标 ≥44px。
    **纯 CSS 断点、内容只有一份**，桌面端排版一像素不变。
  - 新增 `tests/web-adr109-vpn-mobile.test.ts`（22 个用例）——
    同源判据的纯函数单测 + CSRF 防线不退 + 绑定面三条 + 窄屏四条。
  - **启动横幅直接给出手机上能拨的地址**（ADR-109 落地后的实测缺口补齐）。
    原来 `--host 0.0.0.0` 时横幅只印 `http://0.0.0.0:4321` ——
    **这个地址手机拨不通**（`0.0.0.0` 是「绑定到所有网卡」的**服务端**通配，
    不是客户端可拨的目标地址；实测拨它连接失败，拨物理网卡 200）。
    于是人必须自己知道台式机的局域网 IP 才能连上。现在横幅会列出
    **本机物理网卡的地址**（手机连同一个 Wi-Fi 即可），并标注网卡名。
      - **只列物理网卡**，虚拟网卡（VPN / Hyper-V / WSL / Docker）不列 ——
        手机连同一个 Wi-Fi 只能用到物理网卡那个地址；VPN 虚拟网卡要走
        「手机也装同一个 VPN」那条完全不同的路径，混在一张清单里会误导人。
      - **物理/虚拟用系统权威判据，不按名字猜**：
        Windows 用 `Get-NetAdapter` 的 `Virtual` 属性，Linux 看
        `/sys/class/net/<if>/device` 是否存在，macOS 用
        `networksetup -listallhardwareports`。
        名字关键字不可靠 —— ZeroTier 的虚拟口就叫「ZeroTier One」，
        不含任何「虚拟」字样；且 `Win32_NetworkAdapter.PhysicalAdapter`
        会把 ZeroTier 误报成 `TRUE`。
      - **探测失败时如实说「未能确认」**，并用名字关键字**保守排除**
        （宁可漏列，也不把虚拟网卡说成物理）。
  - 新增 `tests/web-dialable-addresses.test.ts`（20 个用例）——
    筛选逻辑抽成纯函数（喂合成输入测，不依赖运行机器的网卡配置）、
    物理/虚拟标记、渲染措辞、端到端横幅。
- **Events are now a hash chain — tampering is verifiable from the outside**
  (ADR-100). The event stream was append-only (C4), but "append-only" only
  meant *zelto* wouldn't rewrite it; an external reader had no way to tell
  whether the file had been edited between two runs. `EventEnvelope` gained
  optional `prevHash`/`hash` fields: `append` finds the chain tail for the
  slice, computes `hash = SHA-256(prevHash + canonical content)` and writes
  it; `loadChain` reads the chain back; `verifyChain` recomputes each hash
  and checks the `prevHash` links. New writes always carry the chain;
  pre-chain events are counted as `unchained` rather than reported as
  tampered (see ADR-105 below for what `verify` concludes about them).
  No signing, no concurrency locks, no backfill of history — this covers
  new writes only.
- **`zelto audit verify <slice>` — a read-only tamper check** (ADR-100).
  The whole path calls `EventStream.verifyChain` (read files, pure
  computation) and modifies no audit log, no state, and no file at all
  (C1/C4). It prints the chain conclusion, `Checked`/`Unchained`/`Head`
  counts, and the exact line of every break (line number + runSeq + reason).
  Exit code 0 = chain intact or nothing to verify, 1 = chain broken.
- **`zelto why <path>` — the decision, explained** (M2 of the 0.7.0 plan).
  For any path it answers: allow / deny / ask, the rule id and the basis
  that decided it, the owning slice and its reserved write-set, and what to
  do about it. It **assembles existing capabilities** rather than adding a
  new judgement: `core/policy/engine.ts#evaluatePolicy` + `ReservationStore`
  + the managed-spec exception + the protected domain (ADR-100's plan,
  `docs/plan-0.7.0-verifiability.md`). It only explains judgements, it
  never makes them (C3); it reads, it never writes. `--json` is there for
  the web cockpit and for scripts. Guide: `docs/guide-zelto-why.md`.
- **Help is now layered in three levels** (M4 of the 0.7.0 plan). L1 is the
  top level (`zelto help` shows two essential groups, `zelto help --all`
  shows all seven); L2 is a command (`zelto help <command>` — usage line
  plus options); L3 is a sub-command or parameter (`zelto help <command>
  <param>` — name, description, constraints/defaults). `..` goes up one
  level, `top` goes back to the top, and `--help`/`-h` adapt to the level
  you're at. The single source of truth is `COMMAND_CATALOG` in
  `catalog.ts`; an unknown group/command/parameter gets a recognisable
  hint and exit code 0 — it never crashes. Guide:
  `docs/guide-help-layers.md`.
- **The gate can be scoped by write-set, and re-run failures can be narrowed**
  (ADR-096 / ADR-097). A gate re-run used to be a full re-run: on the
  nimrtc-v14 battlefield the gate wall was 4494s (1.25 hours), 90% of it
  in the `test` command. Now `zelto gate` builds and runs only what the
  slice's write-set actually touches (measured: `v2-ice` went from 2387
  cases to ~200), and `--rerun-failed` re-runs only the cases that failed
  the last time. The scope is recorded in the event stream (`scoped`,
  `scopeLabels`, `scopeTestCount`, `scopeTotalTestCount`) — and ADR-104
  makes the **sign-off judgement** read those fields, so the person
  signing can see that the gate really ran this slice's tests.
- **The cockpit can act, not just look** (ADR-086 / ADR-094).
  The cockpit now has the brakes, never the accelerator: `freeze` / `gate`
  / `run` / `resume` stay CLI-only, but the sign card gained a **reject**
  button, the slice detail page gained an answer box, and the top bar
  carries a permanent **halt** button. All four actions call the same
  core implementations the CLI uses — no re-implementation, no forked
  verdicts. Writing to the cockpit's endpoints now requires
  `Content-Type: application/json`, because `fetch(mode:'no-cors')` can
  send a `text/plain` body that a token + Origin check alone will not
  stop.
- **The cockpit survives a crash, and the runtime budget is guarded**
  (ADR-092). A crashed cockpit used to take the running batch's state with
  it. There is now a crash guard and a runtime budget guard, both with
  recovery paths.
- **Specs are drafted from the real repository, not from guesses** (ADR-012 /
  ADR-098 / ADR-099). The spec generator now scans the real repo before
  designing, so module paths are not guessed; it gets the *body* of the
  requirement items and auto-links them; and the drafting context is
  density-controlled with read-only references plus an overflow fallback
  instead of dumping everything into the prompt.
- **Specification conformance is now judged, and there is a glossary**
  (ADR-057 / ADR-098). `zelto spec-check` judges whether the slice
  actually implements what the spec says, and a domain glossary
  (`zelto glossary`) keeps the same word meaning the same thing across
  specs and code.
- **The human gate has three actions, and PRs are traceable**
  (ADR-094 / ADR-095). A person can now say something about a slice
  (reject / ask / answer) instead of only approving; `zelto forge` opens a
  PR whose traceability block points back at the slice, and the PR block
  no longer writes "验收过了" where gate② has not passed — **saying
  something false is worse than having no traceability chain at all**.

### Fixed
- **提问标记少写三个尖括号，整轮白跑（ADR-137 / ZD-065）**。
  `parseQuestion()` 只认 `<<<ZELTO_QUESTION` 这**一个精确串**，
  agent 写成 `ZELTO_QUESTION` 就**完全收不到**。
  病灶（nimrtc-v14 `v1-transport-manager-pacing`，2026-11-27）：
  agent 停下来问了人（问题完全正确 —— 新文件要注册 CMake 源列表，
  但 `src/engine/CMakeLists.txt` 不在写集里），标记却少写三个尖括号 →
  问题**从未登记** → 「agent 停下问人」被当成「agent 成功完成」→
  门禁在一个**零改动**的 worktree 上跑 → 报
  `Error: .../build is not a directory`。
  **那条报错指错了方向** —— 人看到会去查构建配置，
  而真正该做的（回答那个问题）已经静默消失。
  代价：整轮白跑（$2.78）+ 一条误导性的错误信息。
  修法：**外壳宽松，内容严格** —— 标记的**识别**认得 0..3 个前导 `<`、
  空白、代码块围栏与尾冒号；**字段的解析**一个字都不松
  （`type` 仍须是三种之一、`question` 仍须非空）。
  缺收尾标记 `>>>` 时取引用块到输出末尾，而不是整条丢掉。
  宁可**多认**一个不是问题的标记（后面被字段校验挡掉），
  也不要**漏认**一个真的是问题的标记 ——
  后者让 agent 的提问静默消失。
  七个外壳变体 + 三个内容严格性用例已进
  `tests/core/question/protocol.test.ts`。
- **`audit verify` now distinguishes three states, not two**
  (ADR-105, ADR-100 §3). `verifyChain` returned a single boolean `ok`, so
  "the chain is intact and I checked every line" and "there is no chain
  to check at all" (the stream doesn't exist / is empty / is entirely
  pre-chain events) both came back as `ok: true`. For a command whose job
  is to prove *the evidence was not touched*, that is a real bug: an
  external reader takes `ok: true` to mean "it was verified", when it
  actually means "there was nothing to verify". The verdict now carries
  `status: 'ok' | 'broken' | 'no-chain'`, and the CLI prints `Chain: OK` /
  `Chain: BROKEN` / `Chain: NO CHAIN` (with a line saying there is no
  chained event to verify). The boolean `ok` is kept for existing callers
  but its meaning is narrowed to `status !== 'broken'` — so `no-chain`
  still exits 0 (it does not falsely report tampering, per ADR-100 §3),
  but it no longer claims to be a verification. **New code reads
  `status`.**
- **`audit verify` on a stream that does not exist no longer reports a
  green "verified"** — the companion fix to the one above, and the reason
  the acceptance suite for it could only pass on the author's machine: it
  asserted against the repo's local `.zelto` event stream, which is
  gitignored and therefore absent on a clean checkout and on CI. The
  acceptance test now **builds its own chain** in a temporary directory,
  so it verifies the same thing on every machine, and covers all three
  states.
- **A spec file inside the write-set is no longer judged as a tampered
  managed file** (ADR-106). ADR-014 §3.3 says the worktree's *copy* of a
  spec is a file zelto put there, so changing it is tampering — but when
  the spec is **in the write-set**, zelto itself told the agent "You may
  only modify these paths" and that path is on the list. The result was
  **zelto asking the agent to change the spec and then blocking the whole
  run for changing it**: the agent's work was complete (state machine,
  wiring, 17 unit tests, acceptance file, ADR, docs, CHANGELOG — all on
  the tree), yet the slice rolled back to `frozen` and gate never ran.
  "Changing the spec is automatically changing the spec" does not hold
  when the spec is in the write-set: the spec is then *human-approved
  work*, not zelto's managed copy. The exemption is **not** unconditional:
  the changed spec must still contain every requirement materialised at
  freeze time (ADR-032 §3.3) — **text included**, not just the count,
  because keeping the count while swapping the content is the standard
  way to weaken an acceptance criterion. A missing or rewritten
  criterion is judged tampering, at the same severity as "managed file
  changed". The judgement is a pure function, read-only, no network (C3).
- **The write-set judgement now converges on the one matcher C9 uses**
  (ADR-106 §5). Whether a spec is in the write-set is decided in **two**
  places — `zeltoOwnedPaths()` (does it need protecting?) and
  `buildSpecIntegrity()` (does it get an anchor?) — and both used strict
  equality, while the runtime guard uses `pathInWriteSet`, which
  understands **globs** (`specs/slices/*.md`) and **directory prefixes**
  (`specs/`, `specs/slices/`, `specs`). So when a person wrote the
  write-set any of those four ways, C9 said "in the write-set" while the
  audit said "not in the write-set". The two sides disagreed, and the
  outcome was one of two bad results, depending on which side ran first:
  either **zelto asks the agent to change the spec and then blocks it for
  changing it** (the exact contradiction ADR-106 fixes — just with a
  different spelling it didn't fix), or the anchor side says "not in the
  write-set", gives no anchor, the "frozen requirements are still there"
  check never fires, and **the agent can delete acceptance criteria
  without being stopped** — a miss. Fixing one side only turns the
  contradiction into the miss. **Both sides must use the same matcher.**
  The same hole in ADR-046's acceptance-directory exemption is fixed too:
  `tests/acceptance/**/*.cjs` as a write-set entry now works.
- **The 14 `.cjs` acceptance suites that had never run now run**
  (D-59). They existed on the tree but the test runner collected `.ts`
  unit tests only, so they were dead weight: a suite that never runs is
  not a verification. They now execute, and the one that asserted against
  the repo's local `.zelto` state was rewritten to be hermetic.
- **`.cjs` acceptance suites are now collected by branch, not by directory**
  (ZD-036). The runner collected every `.test.cjs` under
  `tests/acceptance/**` in the **working tree**, regardless of whether it
  belonged to the current branch. So acceptance suites from another
  branch (untracked, asserting a version number and a lock file that
  cannot exist on this branch) were pulled into this branch's CI — and
  they were **red for a reason that had nothing to do with the code**:
  the red was not "the code is broken", it was "the scope was wrong". The
  criterion is now `git ls-files`: **an acceptance test that is not in the
  repository is not part of this repository's contract.** (Without git
  available it falls back to collecting them all.)
- **The gate's CTest fixtures now work on Linux as well as Windows**
  (the Windows CI job was green while the Linux one was red). The fixture
  built a `cmd /c "<path>\ctest.cmd"` batch file, so on Linux the command
  did not exist. The fixture is now platform-aware: a `ctest.cmd` on
  Windows, an executable `ctest.sh` (mode 0755) on POSIX. Three test files
  were affected (`adr096`, `adr097`, `zd027`).
- **The gate's narrowing parameters are no longer inserted inside the
  path's quotes** (the same Linux red, and the one that survived the
  fixture fix). The narrowing argument (`--tests-from-file` /
  `--show-only=json-v1`) landed **inside** the quoted path:
  `"/tmp/gate/ctest.sh --tests-from-file m.txt" --test-dir build`. In a
  POSIX shell the quotes are the shell's — everything inside is **one
  token**, so the whole "path + narrowing argument" became a **file
  name**: `No such file or directory`, and the gate reported an error
  that had nothing to do with the code under test. On Windows this is
  not a problem: `cmd /c "..."` has cmd do the quote pairing, so an
  argument inside the quotes is still a separate argument (verified in
  ADR-096). So it was never "the Windows form is right and the POSIX
  form is wrong" — it was **one form behaving differently under two
  quote semantics**, and the insertion point has to make both work.
  The insertion point now steps over the closing quote. While there, the
  **duplicated** ctest-token logic in `scope.ts` (a verbatim copy of the
  copy in `diagnostics.ts`) was **collapsed into one implementation** —
  the copy had the same hole, so both sides broke together (ADR-106 §5:
  two judgements of one thing will drift apart).
- **The runtime-budget guard test no longer hangs the event loop on Node 22**
  (the same Linux red). The fake adapter had no child process, so nothing
  kept the event loop alive; the watchdog timer is `unref()`'d, so the loop
  drained and the test ended before the thing it was testing. The fake
  adapter now holds a ref'd keep-alive handle and releases it on `stop()`.
- **The gate failure diagnostics no longer depend on Windows-only
  semantics** (the same Linux red).
- **The version base point can now be pinned explicitly**, instead of only
  being derivable from the preceding version or from `HEAD` (ZD-009), and
  the design generator's module names now accept the bracketed short name
  (ZD-010 / ZD-011), with a missing module section in the design filled in.
- **A submodule pointer mismatch no longer blocks an unrelated merge.**
- **The gate re-run now feeds the previous round's failure evidence back to
  the agent** (ZD-013).
- **The placeholder check stops reading API names as placeholders**
  (ZD-019).
- **The frozen-admission checks no longer have three false positives** —
  backticked commands, `basename` counting as coverage, and `install` not
  being a file (ZD-006).
- **The spec coverage check no longer misses a new file when a bare
  filename borrows the directory of the neighbouring "header/implementation"**
  (ZD-024).
- **The halt request now has a 30-minute TTL**, so a stale brake no longer
  blocks every subsequent slice (ZD-023), and the admission refusal of
  `zelto run` no longer starts a run while a pause is in effect (ZD-023).
- **The submodule sync does not touch the network, does not hang, and its
  failure must be sayable** (ZD-073 / ADR-103) — including the case of a
  submodule that is missing two files (ZD-026).
- **The git baseline snapshot retries on a transient timeout** (so a
  momentary hiccup no longer fails a slice), and **the `zelto set` array
  fields now accept JSON arrays** (ZD-022).
- **The Cockpit's frontend script was a syntax error** — the page rendered
  nothing but "加载中…" (ADR-093).
- **The frontend script moved from template strings into standalone
  files** (ADR-093).
- **The `run` command's wait limit went from 30 seconds to 2 minutes**,
  because the preparation phase has to build the worktree and sync
  submodules.

### Infrastructure
- **CI now runs on two platforms.** Linux (`ubuntu-latest`) runs the full
  `pnpm test` and is the main gate; Windows (`windows-latest`, Node 22,
  explicit `shell: bash`) runs `build + test:quick + lint` from the same
  scripts. The historical Windows-only traps (a newline eating a commit
  trailer, path separators, leftover locks, `cmd` pipe characters, a BOM
  header) only ever surface on Windows, so both platforms have to be in
  CI for them to surface at all.
- **A no-model "out-of-bounds write gets blocked" end-to-end test**
  (`tests/guard-deny-e2e.test.ts`). It builds a temporary project and
  worktree, drives the `PreToolUse` judgement with a synthetic
  `contracts/schemas/hook-io.json` payload for all three harness
  envelopes (Claude / Cursor / Codex), and asserts: an out-of-bounds
  write is denied per-write; an unreserved path is denied as
  `reservation:missing`; the git-audit backstop reports non-empty
  `violations` (including `other/evil.ts`); the conclusion lands on disk
  as a `policy.violation` event; and a path that is both in the write-set
  and allowed by the policy is let through — the counter-example that
  proves the denial is not a blanket "deny everything".

## [0.7.1] — 未发布（Unreleased）

### Added
- **发布前的依赖一致性校验**（ADR-108）。`scripts/version-check.mjs` 现在校验
  `package.json` 与 `pnpm-lock.yaml` 的依赖声明**逐条一致**（每条依赖的存在性 +
  版本范围字符串），并在仓库里出现 `package-lock.json` / `npm-shrinkwrap.json` 时
  直接失败。脚本挂在 `prepublishOnly` 末尾，**发布前跑，不装任何东西**。
- **`version-check.mjs` 缺失依赖时给人话**：改用动态 `import()` 加载 `js-yaml`，
  装不上时输出可读错误，而不是抛 Node 的 `ERR_MODULE_NOT_FOUND` 堆栈。

### Fixed
- **发布闸门被换小了**（ADR-108）。`prepublishOnly` 曾经被改成只剩
  `node scripts/version-check.mjs` —— 原来的「清理 → 构建 → 全量测试」三步
  整个没了，于是 `npm publish` 之前**不构建、不跑测试**。现已恢复成
  `pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs`。
  闸门只能加，不能换小。
- **假 npm 锁文件**（ADR-108）。仓库里那个 `package-lock.json` 是从 pnpm 本地
  store 生成的**假锁文件**（`resolved` 指向 `../../../node_modules/.pnpm/...`，
  且**零个** `integrity` 哈希）—— `npm ci` 在别的机器上必然失败。本仓库用
  pnpm，真锁文件是 `pnpm-lock.yaml`。假文件已删除。
- **README 与 `package.json` 的版本号对不上**。`package.json` 是 `0.7.1`，
  而中英文 README 都还写 `v0.6.0`。两处 README 现已更新到 `v0.7.1`，并
  同步了发布措辞。
- **发布状态真源与现实一致**。`release-status.json` 现在是
  `published: false` —— `0.7.1` 还没发到 npm（npm 上只有 `0.6.0`），
  之前的 `published: true` + `npmVersion: 0.6.0` 说的是另一个版本的事。

## [0.6.0] — 2026-11-18

### Published
- **First release on npm.** `npm install -g zelto` installs the CLI and the
  standalone hook. This is the first release that actually reached the
  registry — the 0.5.0 entry below was written before the publish had
  happened, and it has been corrected rather than left to mislead.
  `release-status.json` records the state; the release pipeline maintains it.

### Added
- **The write-set reservation is now enforced at runtime for Cursor and Codex, not just Claude Code** (ADR-083). C9 says the reservation is enforced "primarily by a per-write PreToolUse hook, with a post-run git audit as backstop" — but the audit backstop is **fail open** (it reports, it doesn't block). So "the hook isn't installed" meant "the only hard gate is off, and all that remains is a witness who reports but doesn't stop". The judgment core (`judgeWriteTargets`) is **untouched**: each harness's input is normalized into a unified payload, and the verdict is rendered back into that harness's envelope. `preToolUse` for Cursor, `PreToolUse` for Codex, `zelto hook --install` now installs all three by default, and the `harness` field in the event stream records the **real** source instead of a hardcoded `claude-code`. Cursor's hook **fails open by default**, so the config must set `failClosed: true` explicitly — the status command reports "installed but NOT failClosed" rather than a reassuring "installed". DeepSeek Harness needs no code: its bridge reads the very same `hooks.json`.
- **The cockpit can now be taken over** (ADR-084). ADR-072 promised "read-only view + one sign action" and the sign action was already there — but the gap was real: you could approve but not reject, could not answer an agent's question, and could not pull the emergency brake. Those are exactly the moments the cockpit exists for: an agent blocked on a question sent you back to the terminal. Now the sign card has a "reject" button, the slice detail page has an answer box, and the top bar carries a permanent "halt" button — handing control back should never require hunting for a view first. **All four actions call the same core implementations the CLI uses** (no re-implementation, so no forked verdicts). "Answer" only **records** the answer; resuming the agent stays in the CLI, because a live agent session does not belong inside an HTTP request. The cockpit has the brakes, not the accelerator: `run` / `gate` / `freeze` / `resume` are still CLI-only. A third layer of defense was added to the write endpoints: `Content-Type: application/json` is now required, since `fetch(mode:'no-cors')` can send a `text/plain` body that token + Origin alone will not stop.
- **The publish status has a single source of truth** (`release-status.json`). The README and this changelog used to claim "Published to npm" while `npm view zelto` returned 404 — the same shape as D-63 and D-73: **the claim and the reality disagree, and the document is the one that is wrong.** The release pipeline now flips `published: true` after a successful `npm publish`, and both documents follow that file instead of being updated by hand.
- **Dead slices can now be cleaned up in one command** (ADR-053). ADR-047 made
  a failed agent stop stranding its slice in `running`, but the leftovers from
  before that fix were still sitting there: they occupied the "running" count
  in `zelto status`, and the only way out was `zelto resume`, one slice at a
  time. `zelto halt --rollback` could not help — it hunts for slices whose
  *reserved* process died (a crashed batch), while a dead slice holds no
  reservation at all (the agent died, the reservation was released). Two
  different diseases, so two different commands. `zelto stall --reap` now
  reverts every slice that is still `running` with a stall classification back
  to `frozen`, and lists them in `zelto stall` so the "still stuck" ones are
  distinguishable from the "waiting to be handled" ones. The classification
  is deliberately **kept**: `resume` means "a human looked at this", reaping
  only means "the state is runnable again" — the stall still stands until
  someone deals with it. Slices waiting for an answer (`agent_question`) are
  excluded: that agent is still alive, just waiting for a human. `--dry-run`
  lists without touching anything; `--json` is machine-readable.
- **The constraint bundle now carries the gate commands** (ADR-045). The gate
  runs on the tree the agent left behind, but zelto only put the write-set,
  the protected paths and the policy rules into the bundle — so the agent had
  to *guess* which build system, which generator and which binary directory
  the gate would use. In the field that guess cost a full 30-minute agent
  round: the agent configured `build/` with NMake, the gate reconfigured the
  *same* directory with Visual Studio, and CMake refused
  (`generator platform: x64 does not match the platform used previously`).
  The agent's work was correct — the build and test steps passed; only
  `configure` failed. The error pointed at "the environment", not at "the
  product", so the next agent round configured it the same wrong way and the
  loop repeated. The bundle now states the gate's commands verbatim (the same
  selection logic the gate itself uses) and tells the agent to verify with
  exactly those. It is a statement of fact, not a constraint: the agent may
  still run anything else, it just knows what the gate will do.
- **A failed agent no longer strands the slice in `running`** (ADR-047). Four
  paths were all blocked at once: `run` refused to run it (admission only
  accepts `frozen` / `completed`), `merge` would not take it (unsigned),
  `resume` cleared the stall classification but left the state at `running`
  — so the "you can re-run it now" message was untrue — and the only way
  out was `abandon`, throwing away the spec. One agent hiccup meant the
  slice was dead. ADR-037 had fixed this same disease for out-of-bounds
  writes but only on that one path. Now the stall has a **single landing
  point** (`markSliceStalled`): revert the state to `frozen`, write the
  classification, write the events — in that order, so a failure part-way
  through still leaves a re-runnable slice. All three execution paths
  (foreground, parallel, background) go through it; the parallel path
  previously wrote no stall at all, so a failed slice in a batch was neither
  visible nor re-runnable. `resume()` now moves the state as well, and the
  admission refusal says what to do next instead of only stating the
  precondition. Dead slices also stop blocking other slices from the
  write-set — except the ones waiting for an answer, where the agent is
  still alive and still holds the reservation.

### Fixed
- **The auto-retry budget can now be reset — but only on purpose** (ADR-052).
  `stall.autoResolved` is a slice-level counter that only goes up, and
  `resume` never cleared it. So a slice that had exhausted its automatic
  retries, stalled, been fixed by a person and re-run would find the counter
  still at `maxRetries` — **the first failure would stall it again, with no
  automatic retry at all**. The person saw "I fixed the environment, I
  re-ran it"; what actually happened was "I re-ran it, and the automatic
  retry was gone". ADR-047 fixed the slice getting stranded in `running`,
  which is what made this reachable at all — before that the slice could
  never run a second time, so the semantics had never been triggered.
  `zelto resume <id> --reset-retry` now resets it explicitly. It is
  deliberately not automatic: clearing it silently would mean "re-running
  once makes the budget infinite", trading one real problem for another.
  The budget exists to stop zelto burning money on a broken slice, but the
  person owns the environment, and environment failures are exactly the
  kind a person can fix. The default `resume` behaviour is unchanged. The
  exhausted budget is now visible where the decision gets made —
  `zelto stall <id>` says `EXHAUSTED (2/2)`, `zelto resume` warns before
  you re-run, and the stall notification says the next failure will stall
  immediately unless you reset it.
- **The acceptance skeleton is now inside the write-set** (ADR-046). zelto
  generated an acceptance file full of `test.todo` placeholders (ADR-034),
  required it to contain real assertions (ADR-033: "todos and skips do not
  count as verification"), and then refused to let anyone touch it — the
  skeleton was not in the write-set and the runtime hook blocked writes to
  it. The agent did nothing wrong; it was told "you may only modify these
  paths". The result: **every slice that went through `zelto spec draft`
  was guaranteed to fail gate②** unless a person added the file to the
  write-set by hand. zelto was manufacturing a thing it would not allow to
  be changed. The skeleton now goes into the write-set when the draft is
  created, and the instructions say explicitly that every `test.todo` has to
  become a real assertion — being in the write-set does not mean the agent
  will change it, and the instruction has to say so.
- **Multi-line gate commands in `.zelto/config.yaml` are no longer swallowed**
  (ADR-041). YAML's idiomatic way of writing a long shell command is a folded
  block scalar (`run: >`), but the config parser only understood a single-line
  `run: <one line>` — so `run: >` was read as the literal command `>`, and the
  gate failed instantly with a syntax error that pointed at the *build*, not at
  the parser. The failure was in the wrong place: the code that was actually
  broken (the parser) reported nothing, and the error surfaced several layers
  downstream. The parser now understands block scalars (`>` folded, `|`
  literal) in all four places they may appear (gate commands, slice-level
  acceptance, agent command, target-project gate), and the cursor advances
  exactly past the block. A folded value never contains a newline — a value
  with newlines would turn "one command" into "several commands".
- **The slice ledger now matches what actually happened** (ADR-041). Three
  fields were structurally present but never filled in, so a person reading a
  slice's state file was reading fiction. `runs` was a dead field (nothing in
  the repository ever pushed to it) and the clarification round number was
  derived from it, so the round was always 1 — asking the same questions in
  every round and colliding on question ids; each agent run now appends a
  `{ at, ok, exitCode }` record and the clarification round has its own
  monotonic counter. `baseCommit` was always `null`, which made the merge
  guard's "the base moved — block the merge" rule a no-op; the base commit is
  now written back when the worktree is created (an existing base is never
  overwritten). A slice in a terminal state (`completed` / `abandoned`) no
  longer carries a stall classification — "this slice is stuck" is simply not
  true of a finished slice — and legacy state files are corrected when read.

## [0.5.0] — 2026-11-10

### Added
- **Taking over an existing project now actually takes over** (ADR-040).
  Managed files are tracked in three states — `generated` / `legacy` /
  `manual` — instead of two. Files zelto generated *before* ADR-038 have no
  marker line, so the hash comparison classified them as hand-written and the
  takeover path stopped working: gate commands stayed generic, write-set rules
  were not derived from the real modules, and root-level build manifests had no
  rule at all, so an agent editing the top-level `CMakeLists.txt` was rejected
  by the PreToolUse hook. `legacy` files are recognised by content signature
  and rebuilt only when the old rule set is provably covered by the new one;
  strategies that contain hand-written rules, or configurations with custom
  gate commands, are left byte-for-byte untouched and reported. A deprecated
  `anchors:` section no longer fails `policy validate` — it is reported as a
  warning, and the old anchor is moved into `policy/lock.json` without being
  overwritten, so a mismatch still surfaces. The migration is recorded as a
  `project.policy_migrated` event (C4). **Breaking:** `initializeProject` is
  now asynchronous, because it has to write that event.
- **Five follow-ups to taking over an existing project** (ADR-039). The
  remaining gaps on the path a person actually walks: registering the current
  code as baseline slices now writes a `slice.baseline_registered` event (C4 —
  the event stream is the only carrier of evidence, so a registration with no
  event did not happen); the policy hash anchor moved **out of the policy file**
  into `policy/lock.json`, because a file that declares its own hash proves
  nothing — changing the policy no longer silently changes the standard it was
  judged by (C5); the pre-merge guard now tells zelto's own spec files apart
  from code changes, so uncommitted `specs/slices/**` no longer blocks a merge
  forever; `zelto init` and `zelto project init` now register the *same*
  baseline through one function; and baseline write sets are directory
  globs, so files added to a module later still fall inside the baseline.
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
- **The dashboard now reports token usage, not just money.** `zelto dashboard`
  (TTY / JSON / HTML) sums the `budget.spent` and `llm.called` events into one
  set of numbers: agent execution and planning-time LLM drafts are kept apart,
  and input/output tokens are broken out on each side — so "is the agent
  expensive because it re-reads the codebase, or because it keeps rewriting?"
  has an answer. The dashboard also shows the per-slice budget ceiling next to
  the most expensive slice, and a **Token 消耗 Top** table. Cost and token
  collection lives in one module (`src/cli/commands/dashboard-cost.ts`) so the
  three renderings cannot drift apart; "measured as zero" stays strictly
  separate from "not measured" (ADR-035).
- **"Completed" and "delivered" are now two separate things on the dashboard.**
  `completed` means both "gate② passed" and "a human signed off" (ADR-018:
  signing does not change the state), so a project overview could show
  `completed: 12` while three of those slices were still sitting outside the
  main branch and two had never been sent for signature at all. The new
  delivery view sorts every finished slice into one of six states —
  **已合入主干 / 已签字·待合并 / 门禁通过·待签字 / 门禁通过·未发起签字 /
  基线切片·无分支 / 已作废** — and shows them on `zelto dashboard` (TTY, JSON,
  HTML), `zelto suggest` and `zelto summary`. The classification reads the same
  sources as `zelto inbox` / `zelto merge` (sign requests, merge candidates),
  so the dashboard cannot disagree with the commands that do the work; the
  verdict itself is a pure function (`classifyDelivery`) locked by unit tests.
- **One wording for a run outcome, whichever path produced it.** The same
  ending — write-set violation, audit failure, budget exhausted, agent
  failure — used to be announced differently by `zelto run`, `zelto run
  --parallel` and `zelto run --background`. People then acted on the wrong
  path's advice. The wording now lives in one module (`run-messages.ts`) and
  every path says the same thing: this round does not count, the slice is
  back at `frozen` (not dead), and here is the exact command to run next.
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
- **npm is the only distribution channel.** The release pipeline is wired up
  (releases run from a tag: `v<version>` must match the version in
  `package.json`, the tarball is installed into a clean directory and
  exercised — `zelto init` + policy-anchor self-check — before
  `npm publish --provenance` runs), and the repository's `Dockerfile` and
  `docker-compose.yml` stay as development conveniences that do not carry
  releases. **At the time this entry was written the first publish had not
  happened yet** (`npm view zelto` returned 404) and installation was
  from source; the actual first release is 0.6.0 above.
  `release-status.json` is the single source of truth for whether the package
  is actually on the registry — the README and this changelog both follow it.

### Fixed
- **The installed package was never actually exercised.** The `files`
  whitelist decided *which* files ship, but nothing checked that the files
  that shipped *worked*. Three real defects were hiding in the gap:
  `bin/zelto.sh` pointed at `bin/dist/cli/index.js` while `dist/` sits next to
  `bin/`, so the wrapper had never run successfully since it landed; the
  package shipped `policy/` — zelto's own write-set rules, which the user's
  project never reads (`zelto init` generates a policy from the modules it
  detects) and which are actively misleading once they land in someone else's
  repository; and this repository's own `policy/lock.json` was still in the
  pre-ADR-039 format, so the anchor reader could not parse it and zelto
  reported itself as *unanchored* — C5's protection was silently inert on the
  one repository where it mattered most. `tests/package-availability.test.ts`
  now packs, installs and runs the real CLI in a clean directory, so these
  cannot come back.
- **Four event types could be emitted but were not in the contract.**
  ADR-036 added `contract.evolution_checked`, `contract.baseline_updated`,
  `version.regression_recorded` and `version.regression_detected`, but the
  enum in `contracts/schemas/event-envelope.json` — the declared source of
  truth — was never updated, so the code could write events the contract did
  not recognise. The enum now lists all 57 event types, and the gap is
  closed for good: the event list is a runtime array (`EVENT_TYPES`) that the
  `EventType` union is derived from, the audit summary map is typed
  `Record<EventType, ...>` (so a missing summary is a **compile error**, not a
  runtime degradation to `Event: <type>`), and `tests/event-contract-parity.test.ts`
  reconciles contract ↔ code ↔ audit summaries ↔ documentation on every test
  run.
- **A write-set audit failure no longer leaves the slice stuck in `running`.**
  When the post-run audit could not read git state, the slice was neither
  advanced nor rolled back — `run` / `merge` / `resume` were all blocked and
  the only way out was `abandon`, i.e. "the audit environment is broken" threw
  the work away. The slice now returns to `frozen` like a real violation does,
  with a `run.aborted` event whose reason is `write-set audit failed`. The
  message distinguishes it from an actual violation, because the next step
  differs: fix the audit environment vs. widen the write set.
- **A write-set violation is no longer announced twice on the background
  path.** `enforceWriteSet` already writes the `run.aborted` event and rolls
  the slice back; the caller wrote a second `run.aborted` on top of it. In an
  append-only event stream a duplicate entry reads as "this happened twice".
- **`zelto check` now exits non-zero on failure in text mode too** (ADR-032).
  It always returned 0, so it could not be chained into a script or a hook.
  The spec engine (`validateDeterministic` / `analyzeSemantic`) is now wired
  into `check` instead of being reachable only from tests: deterministic
  findings block, semantic heuristics only advise (C7).
- **`budgetLimitUsd: 0` now means "unlimited"** (ADR-035). The config comment
  said so, the implementation treated `0` as invalid and fell back to the
  default `1.0` — comment and code disagreeing means the setting is a lie.
- **The dashboard's "pending approval" hint never appeared.** It looked for
  `.zelto/inbox`, a directory that does not exist — sign requests live in
  `.zelto/locks/sign-*.json`. The hint now reads the same source as
  `zelto inbox` / `zelto next` / `zelto merge` and points at `zelto inbox`
  (the suggested `zelto sign --list` was not a command that exists).
- **The dashboard's HTML output now escapes dynamic text.** Slice titles and
  event actors come from files any process can append to; they were
  interpolated raw, so a title could inject markup into the generated page.
- **A slice whose measured cost is zero no longer disappears from the
  dashboard's cost view.** The old filter kept only slices with non-zero cost
  or at least one LLM call, which silently dropped "measured, and it was
  free" — the same distinction ADR-035 draws between `null` and `0`.
- **An agent failure no longer hides a write-set violation that happened in the
  same round.** When the agent exited non-zero *and* had written outside its
  write set, the single-slice and background paths printed only "agent exited
  with code N" — the list of offending files was computed, written to the event
  stream, and then never shown to a human. The violation message is now printed
  alongside the failure message on both paths, so the file list that decides
  "widen the write set or redo the spec" is not lost.
- **The parallel path now audits slices whose agent failed.** `zelto run
  --parallel` skipped the post-run write-set audit entirely when the agent
  exited non-zero, so on that path the C9 audit fallback simply did not exist:
  a slice that failed *and* wrote outside its write set was reported as a
  plain failure, with no violation event and no rollback to `frozen`. Failed
  slices are now audited like successful ones; the violation is reported and
  the slice goes back to `frozen` so it can be re-run after the write set is
  widened.
- **The background path writes `run.aborted` once, not twice.** The
  de-duplication added with the unified run messages only covered the
  `exitCode === 0` branch; an agent failure combined with a violation still
  produced two `run.aborted` entries, which reads as "this happened twice" in
  an append-only stream. The second entry is now written only when the audit
  did not already write one.
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
