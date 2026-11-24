// 门禁失败的**精准证据提取** —— 从测试输出里抽「哪个用例挂了、断言说了什么」
// See docs/实战缺陷记录-nimrtc-v14.md（ZD-027）
//
// ── 战场病灶（nimrtc-v14 实测，2026-11-23）────────────────────────────────
//
// 门禁 `test` 命令 `exit=8`，门禁把失败记进 `gate.result` 事件 —— 但存下来的
// stdout 只有**前 5 行**（原实现 `r.stdout.slice(0, 500)`），而那 5 行正好是
// **排在最前面、通过了**的用例：
//
//     Test project .../build
//               Start    1: BwePluginSeam.RegisterDefaultPluginsRegistersAimd
//        1/2333 Test    #1: ...  Passed    0.01 sec
//               Start    2: BwePluginSeam.UnknownIdReturnsNullptr
//        2/2333 Test    #2: ...  Passed    0.01 sec
//
// 真正失败的用例在中间段（第 300~2000 号之间），**被截掉了**。
// stderr 只剩一句 `Errors while running CTest`。
//
// 于是 agent 和人拿到的失败反馈是：「2333 个用例里错了，但错哪个、错在哪，
// 不知道」。人只能自己进 worktree 重跑一遍全量测试去找 ——
// 每次 250~400 秒。这就是 nimrtc-v14 里 14 次门禁、1.64 小时「门禁墙钟」
// 之外**额外**花掉的排查时间。
//
// ── 这个模块做什么 ────────────────────────────────────────────────────────
//
// 把一段测试运行器的**原始输出**喂进来，抽出一份结构化摘要：
//   { testName, message, line }[]  —— 失败用例清单 + 断言尾部
//
// 覆盖主流运行器：CTest、node --test（TAP + spec reporter）、vitest、jest、gtest。
// 抽不出时返回空清单 —— **空不等于通过**，调用方据此保持诚实（不编造）。
//
// ── 为什么不调模型、不读文件以外的东西（C3）──────────────────────────────
// 纯字符串计算：同样的输入永远得到同样的摘要。判定可复现。
// 本模块在 core/ 内，不依赖 adapters/、不发网络请求（C2 / C6）。

/**
 * 一条失败用例摘要。
 *
 * 字段都尽量**保留原文**（不加工、不翻译）—— 人要看到的是
 * 「测试自己怎么说的」，转述会把关键细节转掉（见 feedback.ts 同一原则）。
 */
export interface GateFailureSummary {
  /**
   * 失败的用例名（运行器给的名字）。
   *
   * 对不上名字时为空串（例如只抽出断言文本、没有用例名），由展示层兜底。
   */
  test: string;
  /** 失败消息 / 断言尾部（尽量保留原文，截断到上限）。 */
  message: string;
  /** 用例所在的位置信息（文件:行），抽不到就省略。 */
  location?: string;
}

/**
 * 摘要结果的元信息。
 *
 * `runner` 让我们知道**怎么认出来的**；识别不出时是 `unknown`，
 * `failures` 为空 —— 这时不能把「抽不出」当作「没有失败」。
 */
export interface GateFailureExtraction {
  runner: 'ctest' | 'node-tap' | 'node-spec' | 'vitest' | 'jest' | 'gtest' | 'unknown';
  failures: GateFailureSummary[];
  /**
   * 原文里声明的失败总数（`X tests failed` / `tests failed out of N`）。
   * 抽出比总数少时，展示层要说「还有 N 条没抽到」—— 不许假装全抽到了。
   * 抽不出就是 null。
   */
  reportedFailureCount: number | null;
}

/** 单条 message 的最大字符数 —— 够看清一条断言，又不会把上下文挤爆。 */
const MAX_MESSAGE_CHARS = 600;
/** 最多抽多少条 —— 与 feedback.ts 的条数上限一个量级。 */
const MAX_FAILURES = 50;

/**
 * 从一段测试输出里抽取失败用例（runner 自动识别）。
 *
 * 识别顺序有讲究：先认**特征最鲜明**的（CTest 的 `Test #N:` 行、
 * node 的 `# Subtest`、gtest 的 `[  FAILED  ]`），再认弱特征的。
 * 同一种输出命中多个解析器时，取**抽出条数最多**的那个 ——
 * 宁可多抽一条真的，也不要因为顺序问题漏掉整批。
 */
export function extractGateFailures(output: string): GateFailureExtraction {
  if (!output || output.trim().length === 0) {
    return { runner: 'unknown', failures: [], reportedFailureCount: null };
  }

  const candidates: GateFailureExtraction[] = [
    parseCtest(output),
    parseGtest(output),
    parseNodeTap(output),
    parseNodeSpec(output),
    parseJest(output),
    parseVitest(output),
  ];

  // 取抽出条数最多的；平手时按上面的先后顺序（更可信的解析器在前）。
  let best: GateFailureExtraction = { runner: 'unknown', failures: [], reportedFailureCount: null };
  for (const c of candidates) {
    if (c.failures.length > best.failures.length) best = c;
    // 条数相同但当前 best 还没识别出 runner：用已识别的那个。
    else if (best.runner === 'unknown' && c.failures.length > 0) best = c;
    // 一个失败用例都没抽到、但某个解析器认出了「运行器 + 失败总数」：
    // 保留那条元信息（例如 CTest 的 `0 tests failed out of N`）——
    // 「认出了运行器、确认 0 个失败」是有价值的事实，别丢成 null。
    else if (
      best.failures.length === 0 &&
      c.failures.length === 0 &&
      best.reportedFailureCount === null &&
      c.reportedFailureCount !== null
    ) {
      best = { ...best, runner: c.runner, reportedFailureCount: c.reportedFailureCount };
    }
  }

  // 失败条数超上限时截断，但 reportedFailureCount 保留原值。
  if (best.failures.length > MAX_FAILURES) {
    best = { ...best, failures: best.failures.slice(0, MAX_FAILURES) };
  }
  return best;
}

// ─── CTest ───────────────────────────────────────────────────────────────────

/**
 * CTest 输出形态（`--output-on-failure` 会把失败用例的标准输出夹进来）：
 *
 * ```text
 *    1234/2333 Test #1234: VideoCapture.SwitchDevice .......***Failed    0.42 sec
 *    1235/2333 Test #1235: Audio.TurnTaken .................   Passed    0.01 sec
 *
 *  1234: [----------] 2 tests from VideoCapture
 *  1234: [ RUN      ] VideoCapture.SwitchDevice
 *  1234: /path/test_vc.cpp:88: Failure
 *  1234: Expected equality of these values:
 *  1234:   a
 *  1234:     Which is: 1
 *  1234:   b
 *  1234:     Which is: 2
 *
 *  The following tests FAILED:
 *     1234 - VideoCapture.SwitchDevice (Failed)
 *
 *  100% tests passed, 0 tests failed out of 2333
 * ```
 *
 * 失败行有两种标记：`***Failed` / `***Exception` / `***Timeout` / `***SIGSEGV` 等，
 * 以及最后的 `The following tests FAILED:` 清单。两处互补：
 * - 结尾清单给出「哪几条失败」（权威、简洁）；
 * - 中间夹带的标准输出给出「为什么失败」（断言值）。
 *
 * 主名从结尾清单取（最可靠）；断言尾部从「带 `<N>: ` 前缀的 gtest 行」取。
 */
function parseCtest(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);

  // 1) 「The following tests FAILED:」清单 —— 权威的失败用例名。
  const failedNames: string[] = [];
  let inFailedBlock = false;
  let reportedFailureCount: number | null = null;
  for (const line of lines) {
    if (/The following tests FAILED:/i.test(line)) {
      inFailedBlock = true;
      continue;
    }
    if (inFailedBlock) {
      // 清单行形如 `  1234 - VideoCapture.SwitchDevice (Failed)`
      const m = line.match(/^\s*(\d+)\s*-\s*(.+?)\s*\((?:Failed|Timeout|Not Run|Exception|Subprocess aborted|[^)]*)\)\s*$/i);
      if (m) {
        failedNames.push(m[2].trim());
        continue;
      }
      // 空行 / 非清单行 → 结束清单
      if (line.trim().length === 0 || /^\s*\d+% tests passed/i.test(line)) {
        inFailedBlock = false;
      }
    }
    const summary = line.match(/^(\d+)% tests passed,\s*(\d+) tests failed out of\s*(\d+)/i);
    if (summary) {
      reportedFailureCount = Number.parseInt(summary[2], 10);
    }
  }

  // 2) 逐行 `N/M Test #N: <name> ...***Failed` 也记一份（清单缺失时的兜底）。
  const failedMarkers = new Set<string>();
  for (const line of lines) {
    const m = line.match(/Test\s+#?\d+:\s*(.+?)\s*\.*\s*\*{2,}(Failed|Timeout|Exception|Subprocess aborted|SEGFAULT|SIGSEGV|[A-Z]+)\b/i);
    if (m) failedMarkers.add(m[1].trim());
  }

  // 合并失败用例名（清单优先，去重保序）。
  const names: string[] = [];
  const seen = new Set<string>();
  for (const n of [...failedNames, ...failedMarkers]) {
    if (!seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }

  if (names.length === 0) {
    return { runner: 'unknown', failures: [], reportedFailureCount };
  }

  // 3) 从夹带的 gtest 输出里给每条失败用例找断言尾部。
  //    夹带行都带 `<testNum>: ` 前缀（CTest 的 --output-on-failure 行为）。
  const failures: GateFailureSummary[] = names.map((name) => ({
    test: name,
    message: extractCtestMessage(lines, name),
  }));

  return { runner: 'ctest', failures, reportedFailureCount };
}

/**
 * 给一条失败的 CTest 用例抽断言尾部。
 *
 * 定位该用例在夹带输出里的 `[ RUN      ] <name>` 段，取其后到下一个
 * `[ RUN      ]` / `[----------]` 之前的内容；再从中挑出含失败关键词的行。
 * 抽不到就退回「夹带输出里最后一段非空文本」—— 至少给点线索。
 */
function extractCtestMessage(lines: string[], testName: string): string {
  // CTest 夹带行的前缀是 `<数字>: `（用例编号）。
  const strip = (l: string): string => l.replace(/^\s*\d+:\s?/, '');

  // 找 `[ RUN      ] <name>` 段
  const collected: string[] = [];
  let capturing = false;
  for (const raw of lines) {
    const content = strip(raw);
    if (/\[\s*RUN\s*\]/.test(content)) {
      if (capturing) break; // 进入下一条用例，本段结束
      if (content.includes(testName)) capturing = true;
      continue;
    }
    if (capturing) {
      if (/\[\s*(?:-{2,}|={2,}|-{2,}.*-{2,})\s*\]/.test(content) && /\[\s*-{10,}/.test(content)) {
        break; // 段分隔符
      }
      const t = content.trim();
      if (t.length > 0) collected.push(t);
    }
  }

  const meaningful = pickAssertionLines(collected);
  if (meaningful.length > 0) return clip(meaningful.join('\n'));
  if (collected.length > 0) return clip(collected.slice(0, 8).join('\n'));
  return '';
}

// ─── gtest（裸跑，无 CTest 包裹）──────────────────────────────────────────

/**
 * GoogleTest 自己的输出：
 *
 * ```text
 * [ RUN      ] VideoCapture.SwitchDevice
 * /path/test_vc.cpp:88: Failure
 * Expected equality of these values:
 *   expected: 2
 *     actual: 1
 * [  FAILED  ] VideoCapture.SwitchDevice (0 ms)
 * ...
 * [  FAILED  ] 1 test, listed below:
 * [  FAILED  ] VideoCapture.SwitchDevice
 * ```
 */
function parseGtest(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);
  const failures: GateFailureSummary[] = [];

  // 逐条 `[ RUN ]` 段，若该段内有 `Failure` 且段末是 `[  FAILED  ] <name>`，
  // 就把断言尾部收进来。
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^\s*\[\s*RUN\s*\]\s*(.+?)\s*$/);
    if (!run) continue;
    const name = run[1];
    const body: string[] = [];
    let failed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*\[\s*RUN\s*\]/.test(l)) break;
      const failLine = l.match(/^\s*\[\s*FAILED\s*\]\s*(.+?)\s*$/);
      if (failLine) {
        // `[ FAILED ] <name> (ms)` 或 `[ FAILED ] N tests, listed below:`
        if (failLine[1].replace(/\s*\([^)]*\)$/, '').trim() === name) {
          failed = true;
        }
        break;
      }
      body.push(l);
    }
    if (failed) {
      const message = pickAssertionLines(body.map((l) => l.trim()).filter(Boolean));
      const loc = body.join('\n').match(/([^\s:]+\.(?:cc|cpp|cxx|h|hpp|ts|js):\d+)/);
      failures.push({
        test: name,
        message: clip(message.length > 0 ? message.join('\n') : body.join('\n').trim()),
        ...(loc ? { location: loc[1] } : {}),
      });
      i = j;
    }
  }

  const reported = output.match(/\[\s*FAILED\s*\]\s*(\d+)\s+tests?,\s*listed below/i);
  return {
    runner: failures.length > 0 ? 'gtest' : 'unknown',
    failures,
    reportedFailureCount: reported ? Number.parseInt(reported[1], 10) : null,
  };
}

// ─── node --test：TAP reporter ──────────────────────────────────────────────

/**
 * TAP 输出：
 *
 * ```text
 * TAP version 13
 * ok 1 - first test
 * not ok 2 - second test
 *   ---
 *   duration_ms: 1.2
 *   type: 'test'
 *   location: '/path/file.test.js:10:3'
 *   failureType: 'testCodeFailure'
 *   error: 'expected 2 but got 1'
 *   code: 'ERR_ASSERTION'
 *   ...
 * not ok 3 - a subtest within a group
 * ```
 *
 * 主名取 `not ok N - <name>`；断言取 YAML 诊断块里的 `error:` 字段
 * （多行时取到 `code:` 或块结束）。
 */
function parseNodeTap(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);
  const failures: GateFailureSummary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    // 找到紧随的 `---` 诊断块
    let k = i + 1;
    while (k < lines.length && lines[k].trim().length === 0) k++;
    let error = '';
    let location: string | undefined;
    if (k < lines.length && lines[k].trim().startsWith('---')) {
      const block: string[] = [];
      k++;
      for (; k < lines.length; k++) {
        const t = lines[k].trim();
        if (t === '...' || t.startsWith('...')) break;
        block.push(lines[k]);
      }
      error = extractYamlField(block, 'error') ?? extractYamlField(block, 'failureType') ?? '';
      const loc = extractYamlField(block, 'location');
      if (loc) location = stripQuotes(loc);
    }
    failures.push({
      test: name,
      message: clip(error),
      ...(location ? { location } : {}),
    });
    i = k;
  }

  // TAP 末尾可能没有明确总数；`# fail N` 是 node 的汇总行。
  const failLine = output.match(/^\s*#\s*fail\s+(\d+)\s*$/im);
  return {
    runner: failures.length > 0 ? 'node-tap' : 'unknown',
    failures,
    reportedFailureCount: failLine ? Number.parseInt(failLine[1], 10) : null,
  };
}

// ─── node --test：spec reporter ────────────────────────────────────────────

/**
 * spec reporter 输出：
 *
 * ```text
 * ✖ second test (1.2ms)
 *   AssertionError [ERR_ASSERTION]: expected 2 but got 1
 *       at TestContext.<anonymous> (file:///path/file.test.js:12:3)
 * ...
 * ℹ fail 1
 * ```
 *
 * `✔` 是通过，`✖` 是失败。失败消息是 `✖` 行下面缩进的若干行，直到
 * 下一条顶层（无缩进）的 ✔/✖ 或汇总行。
 */
function parseNodeSpec(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);
  const failures: GateFailureSummary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[✖✗×]\s*(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      // 顶层标记（无缩进）结束本段
      if (/^\s*[✔✖✗×]/.test(l) && !/^\s{2,}/.test(l)) break;
      if (/^\s*(?:ℹ|#)\s*(pass|fail|tests|suites|duration|cancelled|skipped|todo)\b/i.test(l)) break;
      body.push(l);
    }
    // 取断言消息：优先含 AssertionError / Error 的行，否则取非空首行。
    const nonEmpty = body.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    let message = nonEmpty.find((l) => /(?:AssertionError|Error|throw|expected|but got)/i.test(l)) ?? nonEmpty[0] ?? '';
    message = message.trim();
    const loc = nonEmpty.join('\n').match(/((?:file:\/\/)?[^\s()]+\.(?:m?[jt]s):\d+:\d+)/);
    failures.push({
      test: name,
      message: clip(message),
      ...(loc ? { location: loc[1] } : {}),
    });
    i = j;
  }

  const failLine = output.match(/^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/im);
  return {
    runner: failures.length > 0 ? 'node-spec' : 'unknown',
    failures,
    reportedFailureCount: failLine ? Number.parseInt(failLine[1], 10) : null,
  };
}

// ─── jest ───────────────────────────────────────────────────────────────────

/**
 * jest 输出：
 *
 * ```text
 *   ● suite name › test name
 *
 *     expect(received).toBe(expected)
 *
 *     Expected: 2
 *     Received: 1
 *
 *       at Object.<anonymous> (file.test.js:12:3)
 *
 * Tests:       1 failed, 1 total
 * ```
 *
 * 失败用例的主名在 `● ` 行；断言在其后的缩进段；末尾 `Tests: N failed` 给总数。
 */
function parseJest(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);
  const failures: GateFailureSummary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*●\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*●\s+/.test(lines[j])) break;
      if (/^\s*(?:Tests:|Test Suites:|Snapshots:)/i.test(lines[j])) break;
      body.push(lines[j]);
    }
    const meaningful = pickAssertionLines(body.map((l) => l.trim()).filter(Boolean));
    const loc = body.join('\n').match(/\(([^()]+\.(?:m?[jt]sx?):\d+:\d+)\)/);
    failures.push({
      test: name,
      message: clip(meaningful.length > 0 ? meaningful.join('\n') : body.join('\n').trim()),
      ...(loc ? { location: loc[1] } : {}),
    });
    i = j;
  }

  const reported = output.match(/Tests:\s+(\d+)\s+failed/i);
  return {
    runner: failures.length > 0 ? 'jest' : 'unknown',
    failures,
    reportedFailureCount: reported ? Number.parseInt(reported[1], 10) : null,
  };
}

// ─── vitest ─────────────────────────────────────────────────────────────────

/**
 * vitest 输出：
 *
 * ```text
 *  FAIL  src/foo.test.ts > suite > test name
 * AssertionError: expected 2 to be 1
 *
 *  Test Files  1 failed (1)
 *       Tests  1 failed | 1 passed (2)
 * ```
 *
 * `FAIL` 行同时带文件与用例名（用 ` > ` 分隔）。
 */
function parseVitest(output: string): GateFailureExtraction {
  const lines = output.split(/\r?\n/);
  const failures: GateFailureSummary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*FAIL\s+(.+?)\s*$/);
    if (!m) continue;
    const full = m[1].trim();
    // 拆出「文件名 > suite > 用例名」；文件名在第一段 `>` 之前。
    const parts = full.split(/\s+>\s+/);
    const file = parts[0];
    const testName = parts.length > 1 ? parts.slice(1).join(' > ') : parts[0];
    // 断言在紧随的缩进段里，直到下一个 FAIL / 汇总行。
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*FAIL\s+/.test(lines[j])) break;
      if (/^\s*(?:Test Files|Tests|Duration|Start at)\b/i.test(lines[j])) break;
      body.push(lines[j]);
    }
    const meaningful = pickAssertionLines(body.map((l) => l.trim()).filter(Boolean));
    failures.push({
      test: testName,
      message: clip(meaningful.length > 0 ? meaningful.join('\n') : body.join('\n').trim()),
      location: file,
    });
    i = j;
  }

  const reported = output.match(/Tests\s+(\d+)\s+failed/i);
  return {
    runner: failures.length > 0 ? 'vitest' : 'unknown',
    failures,
    reportedFailureCount: reported ? Number.parseInt(reported[1], 10) : null,
  };
}

// ─── 公共工具 ───────────────────────────────────────────────────────────────

/**
 * 从一堆文本行里挑「像断言/错误」的那几行。
 *
 * 判据是弱特征：含 failure/error/expect/assert/got 等关键词，或含
 * `file:line` 定位、或形如 `expected:` / `actual:` 的对照行。
 * 挑不到时返回空数组（调用方退回整段）。
 */
function pickAssertionLines(lines: string[]): string[] {
  const picked: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t.length === 0) continue;
    if (
      /(?:assert|expect|error|fail|throw|exception|mismatch|does not|expected|actual|but got|which is)/i.test(t) ||
      /^\s*(?:expected|actual|received|value of|which is)\b/i.test(t) ||
      /[^\s:]+\.(?:c|cc|cpp|cxx|h|hpp|m?[jt]sx?):\d+/.test(t)
    ) {
      picked.push(t);
    }
  }
  return picked;
}

/**
 * 从 TAP 诊断块里取一个 YAML 字段的值。
 *
 * 只处理 `key: value` 与 `key: 'quoted value'` 两种最常见形态；
 * 值里可能带转义（node 把断言消息里的换行写成 `\n`），保持原样不动。
 */
function extractYamlField(block: string[], key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (const line of block) {
    const m = line.match(re);
    if (m) return stripQuotes(m[1].trim());
  }
  return null;
}

/** 去掉值两端成对的单/双引号（不处理内部转义，保持原文）。 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** 截断到上限，并标注「已截断」。 */
function clip(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_MESSAGE_CHARS) return t;
  return `${t.slice(0, MAX_MESSAGE_CHARS)}… (truncated)`;
}

/** 供测试与展示层复用的常量。 */
export const DIAGNOSTICS_LIMITS = { MAX_MESSAGE_CHARS, MAX_FAILURES } as const;

// ─── 只重跑失败用例（ZD-027）────────────────────────────────────────────────

/**
 * 从一组 CTest 失败用例名构造 `-R` 用的正则。
 *
 * CTest 的 `-R <regex>` 按正则匹配测试名；名字里可能有 `.` `(` `+` 等
 * 正则元字符（gtest 用例名形如 `Suite.Test`），必须逐个转义，
 * 否则会误匹配到别的用例、或把正则弄坏导致 ctest 直接报错。
 *
 * 用 `^(?:...)$` 包住，**整名精确匹配** —— 不许 `Foo` 顺带匹配到
 * `FooBar`（那会多跑不属于上次失败集的用例，重跑就失去意义了）。
 *
 * 没有用例名时返回 null（调用方据此退回全量）。
 */
export function buildCtestRerunFilter(failedNames: string[]): string | null {
  const names = failedNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return null;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}

/**
 * 收窄清单文件的前缀（ADR-096）。
 *
 * 清单文件写在**门禁工作目录**（worktree 根）下，名字固定 + 切片 id：
 * - 固定名 → 命令行里只需要一个相对路径，避开 Windows 绝对路径的空格/引号；
 * - 带切片 id → 多个切片并行跑门禁不会互相覆盖；
 * - 跑完删掉 → 不留垃圾。
 *
 * **放在这里而不是各文件各自定义**：executor（内部重试）与
 * lifecycle（--rerun-failed）都要用它 —— 两处各写一份前缀，
 * 迟早会改一处漏一处，导致两边的清单文件名对不上。
 */
export const GATE_NARROWING_MANIFEST_PREFIX = '.zelto-gate-tests-';

/**
 * 把切片 id 变成能安全当文件名的串。
 *
 * 切片 id 一般已经是 `[a-z0-9-]` 这类安全字符，但**不保证** ——
 * 这里把任何非 `[A-Za-z0-9_-]` 的字符换成 `_`，杜绝路径穿越
 * （切片 id 若含 `../` 就能写到工作目录外面去）。
 */
export function sanitizeForFilename(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.length > 0 ? safe : 'slice';
}

/**
 * CTest 工具在命令行里的**完整词元**。
 *
 * 捕获组 1 是要插入参数的**位置** —— 必须是整个词元（含扩展名），
 * 不能只匹配 `ctest` 三个字母，否则 `ctest.exe` 会被插成
 * `ctest --tests-from-file m.txt.exe`（把文件名劈开了）。
 *
 * 后置边界：空白、引号、命令连接符或串尾。
 */
const CTEST_TOKEN = /(\bctest(?:\.[A-Za-z0-9]+)?)(?=["'\s&|)]|$)/;

/**
 * 词元**前面**的合法分隔符（不含路径分隔符 —— 路径形态另走一套判定）。
 */
const CTEST_PREFIX = /[\s"'=;&|(]/;

/**
 * 当 ctest 以**路径**形态出现时，允许的扩展名。
 *
 * 只认「真正能被当作可执行文件跑」的扩展名。这样就把
 * `node "C:/tmp/x/ctest.cjs"`（ctest 只是脚本名，扩展名 `.cjs`）
 * 挡在外面 —— 它是**别的工具的参数**，不是被执行的 ctest 工具。
 *
 * 反过来 `C:/cmake/bin/ctest.exe` 是货真价实的 ctest 工具，要认。
 */
const CTEST_EXEC_EXTENSIONS = new Set(['exe', 'cmd', 'bat', 'com', 'sh']);

/**
 * 判断一个**路径形态**的词元指向的是不是 ctest 工具。
 *
 * `token` 是完整的词元（如 `ctest.exe` / `ctest`），`prefix` 是它前面的部分。
 *
 * 真正的判据是**扩展名**：`ctest.exe` / `ctest.cmd` 是工具，
 * `ctest.cjs` / `ctest.py` 是脚本 —— 后者是**别的工具的参数**
 * （如 `node "/tmp/ctest.cjs"`），不是被执行的 ctest。
 *
 * 没扩展名（`/usr/bin/ctest`）也算工具 —— POSIX 下 ctest 就是无扩展名的。
 */
function isPathToCtestTool(prefix: string, token: string): boolean {
  const dot = token.indexOf('.');
  if (dot < 0) return true; // 无扩展名 —— POSIX 的 ctest
  const ext = token.slice(dot + 1).toLowerCase();
  return CTEST_EXEC_EXTENSIONS.has(ext);
}

/**
 * 判断一条门禁命令是不是 CTest 测试命令（能接受收窄）。
 *
 * 判据：命令行里出现独立的 `ctest` 词元（见 `CTEST_TOKEN`）。
 *
 * **为什么要放宽到引号边界（ADR-096）**：真实项目的命令常被 `cmd /c` 包一层：
 *
 * ```text
 * cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"
 * ```
 *
 * 旧判据 `[\s&|;(]` 不含 `"`，于是 `cmd /c "ctest ..."` 判为**不是** ctest
 * 命令 —— 收窄逻辑恰好在它被开发出来的那个项目上不工作（实测确认）。
 *
 * 前后都要卡边界，否则 `echo ctester`、`myctest` 这类会被误判。
 *
 * 这里只判「能不能收窄」，不改命令本身。
 */
export function isCtestCommand(run: string): boolean {
  return findCtestTokenEnd(run) !== null;
}

/**
 * 找出命令里 ctest 词元的**结束位置**（插入点）。
 *
 * 找不到合法的 ctest 词元时返回 null。
 *
 * 判定分两步：
 * 1. `CTEST_TOKEN` 匹配出词元（含扩展名），并确认其后是分隔符或串尾 ——
 *    这一步挡住 `ctester` / `myctest`。
 * 2. 确认词元**前面**是命令分隔符（空白、引号、`=`、`&`、`;`、`|`、`(`）
 *    或串首 —— 这一步挡住 `node "/tmp/ctest.cjs"`（路径里含 ctest）。
 */
function findCtestTokenEnd(run: string): number | null {
  const m = CTEST_TOKEN.exec(run);
  if (!m) return null;
  const before = run.slice(0, m.index);
  if (before.length === 0) return m.index + m[1].length;
  const lastChar = before[before.length - 1];
  // 前面是普通分隔符 → 词元独立，直接认。
  if (CTEST_PREFIX.test(lastChar)) return m.index + m[1].length;
  // 前面是路径分隔符 → 整条路径必须指向 ctest **工具**（按扩展名判）。
  if (lastChar === '/' || lastChar === '\\') {
    return isPathToCtestTool(before, m[1]) ? m.index + m[1].length : null;
  }
  // 其它字符（字母数字、`-` 等）→ 是别的词的一部分，不认。
  return null;
}

/**
 * 把一条 CTest 命令改写成「只跑失败的用例」——**用 `-R` 正则**（旧形态）。
 *
 * 在 `ctest` 之后插入 `-R "<filter>"`；如果命令里已经带了 `-R` / `--tests-regex`，
 * 就不改（尊重人显式写的过滤，不叠加）。
 *
 * 返回 null 表示「这条命令不适合收窄」—— 调用方保留原命令。
 * 纯字符串拼接，不执行任何东西（C3）。
 *
 * **为什么默认不用它（ADR-096）**：`-R` 的值是命令行里的正则，
 * 而 Windows 上 `cmd` 把 `|` 当**管道符**。实测
 * `cmd /c "ctest -R "^(?:A|B)$" ..."` 直接把命令打崩（exit 255，
 * `'B)$' 不是内部或外部命令`）—— 门禁报的是一个与被测代码毫不相干的错。
 *
 * 保留它是为了兼容 POSIX 项目（那里 `|` 在单引号内安全）。
 */
export function narrowCtestCommand(run: string, filter: string | null): string | null {
  if (!filter) return null;
  if (!isCtestCommand(run)) return null;
  // 已经带了过滤参数 → 不叠加（会互相覆盖/冲突）
  if (/(?:^|\s)(?:-R|--tests-regex)(?:\s|=)/.test(run)) return null;
  // ctest 可能带 `--test-dir build` 这类前缀参数 —— 在 `ctest` 后紧接插入 -R
  return insertAfterCtestToken(run, `-R "${filter}"`);
}

/**
 * 把一条 CTest 命令改写成「只跑失败的用例」——**用 `--tests-from-file`**。
 *
 * 这是 ADR-096 选定的形态：CTest 从一个文件里读**精确**用例名
 * （每行一个），而不是从命令行读正则。
 *
 * 为什么用它（而不是 `-R`）：
 * - 用例名是精确串（`Suite.Test`），本来就不需要正则；
 * - 精确串没有 `|` `(` `)` `.` 等元字符 —— Windows 上没有引号/管道符陷阱；
 * - 实测在 `cmd /c "ctest ..."` 里插入该参数正常工作，退出码语义正确。
 *
 * **代价（已知并接受）**：`--tests-from-file` 在「没匹配到任何用例」时
 * 退出码是 **0**（stderr 打印 `No tests were found!!!`）—— 这是假绿陷阱。
 * 由 `verifyNarrowedTestsRan` 在判定层堵住（见该函数注释）。
 *
 * `manifestFile` 是清单文件的**相对路径**（相对于门禁工作目录）——
 * 用相对路径可以避开 Windows 绝对路径里的空格与引号问题。
 *
 * 返回 null 表示「这条命令不适合收窄」—— 调用方保留原命令。
 * 纯字符串拼接，不执行任何东西（C3）。
 */
export function narrowCtestCommandByFile(run: string, manifestFile: string): string | null {
  if (!manifestFile) return null;
  if (!isCtestCommand(run)) return null;
  // 已经带了过滤参数 → 不叠加（会互相覆盖/冲突）
  if (/(?:^|\s)(?:-R|--tests-regex|--tests-from-file)(?:\s|=)/.test(run)) return null;
  // 在 `ctest` 后紧接插入。`cmd /c "ctest ..."` 里 `ctest` 后面紧跟的是空格，
  // 插进去的参数仍在引号内 —— 实测可用。
  return insertAfterCtestToken(run, `--tests-from-file ${manifestFile}`);
}

/**
 * 在命令里 ctest 词元的**后面**插入一段参数。
 *
 * 为什么不能直接 `run.replace(/(\bctest\b)/, ...)`：
 * - `ctest.exe` 会被插成 `ctest --tests-from-file m.txt.exe`（劈开文件名）；
 * - `node "/tmp/ctest.cjs"` 里的 `ctest` 是路径的一部分，插进去就毁了命令。
 *
 * 所以这里用 `CTEST_TOKEN` 匹配**完整词元**（含扩展名），
 * 并确认词元前面不是路径分隔符，再在词元末尾插入。
 *
 * 找不到合法词元时返回 null（调用方保留原命令）。
 */
function insertAfterCtestToken(run: string, args: string): string | null {
  const end = findCtestTokenEnd(run);
  if (end === null) return null;
  return `${run.slice(0, end)} ${args}${run.slice(end)}`;
}

/**
 * 判断「收窄后的 ctest 是不是真的跑到了用例」。
 *
 * **这是 `--tests-from-file` 的安全阀（ADR-096 决策二）**：
 * ctest 在「没匹配到任何用例」时退出码是 0（`No tests were found!!!`），
 * 于是「筛选用例名写错了」会表现成**门禁假绿** —— 最危险的一种失败。
 *
 * 判据（任一命中即视为「没跑到」）：
 * 1. 输出里出现 `No tests were found` —— ctest 明说没找到用例；
 * 2. 输出里**看不到任何一个**被筛选用例名 —— CTest 会打印 `Test #N: <name>`
 *    与 `The following tests FAILED:`，看不到就说明没跑到。
 *
 * 反过来（跑到了、且退出码非 0）才算「真的验过了」。
 *
 * 纯字符串判定（C3）。
 */
export function verifyNarrowedTestsRan(
  output: string,
  expectedTestNames: string[],
): { ran: boolean; reason?: string } {
  const names = expectedTestNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return { ran: false, reason: '筛选清单是空的 —— 没跑任何用例' };
  if (/No tests were found/i.test(output)) {
    return {
      ran: false,
      reason: 'ctest 没找到任何匹配的用例（用例名与实际不符）—— 收窄条件可能已过期',
    };
  }
  const hit = names.some((n) => output.includes(n));
  if (!hit) {
    return {
      ran: false,
      reason: `输出里看不到被筛选用例（${names.slice(0, 3).join(', ')}）—— 收窄条件可能已过期`,
    };
  }
  return { ran: true };
}

/**
 * 根据「上次失败的命令 → 失败用例名」收窄命令集合（--rerun-failed 的纯逻辑）。
 *
 * 只收窄**与失败命令同名**的 ctest 命令：例如上次 `test` 挂了，
 * 就只给 `test` 加 `-R`，`build` / `lint` 原样跑。
 *
 * `failedByName` 只放**确定是 CTest 失败**的条目（调用方先按 runner==='ctest'
 * 过滤）—— 本函数不再判断 runner，职责单一、便于测试。
 *
 * 返回 `{ commands, filter }` 表示至少收窄了一条；返回 null 表示一条都没动
 * （没有对应失败、或命令都不适合收窄）—— 调用方据此退回全量。
 */
export function narrowCommandsToFailedTests(
  commands: Array<{ name: string; run: string }>,
  failedByName: Map<string, string[]>,
): { commands: Array<{ name: string; run: string }>; filter: string } | null {
  if (failedByName.size === 0) return null;

  let anyNarrowed = false;
  let usedFilter = '';
  const next = commands.map((c) => {
    const names = failedByName.get(c.name);
    if (!names) return c;
    const filter = buildCtestRerunFilter(names);
    const narrowed = narrowCtestCommand(c.run, filter);
    if (narrowed && narrowed !== c.run) {
      anyNarrowed = true;
      usedFilter = filter ?? '';
      return { name: c.name, run: narrowed };
    }
    return c;
  });

  return anyNarrowed ? { commands: next, filter: usedFilter } : null;
}

/**
 * `narrowCommandsToFailedTests` 的**清单文件版**（ADR-096 选定的形态）。
 *
 * 与正则版的区别只在「过滤条件怎么传给 ctest」：
 * 正则版把 `^(?:A|B)$` 塞进命令行；清单版把精确用例名写进文件，
 * 命令行只多一个 `--tests-from-file <相对路径>`。
 *
 * `manifestFiles` 是「命令名 → 清单文件相对路径」的映射 ——
 * 每条被收窄的命令用**自己**的清单文件（一个文件只能对应一条命令，
 * 因为每条命令的失败用例集不同）。
 *
 * 返回 `{ commands, narrowed }`；返回 null 表示一条都没收窄 —— 调用方据此退回全量。
 */
export function narrowCommandsToFailedTestsByFile(
  commands: Array<{ name: string; run: string }>,
  failedByName: Map<string, string[]>,
  manifestFiles: Map<string, string>,
): {
  commands: Array<{ name: string; run: string }>;
  narrowed: Map<string, string[]>;
} | null {
  if (failedByName.size === 0) return null;

  let anyNarrowed = false;
  const narrowed = new Map<string, string[]>();
  const next = commands.map((c) => {
    const names = failedByName.get(c.name);
    if (!names) return c;
    const manifest = manifestFiles.get(c.name);
    if (!manifest) return c;
    const rewritten = narrowCtestCommandByFile(c.run, manifest);
    if (rewritten && rewritten !== c.run) {
      anyNarrowed = true;
      narrowed.set(c.name, names);
      return { name: c.name, run: rewritten };
    }
    return c;
  });

  return anyNarrowed ? { commands: next, narrowed } : null;
}
