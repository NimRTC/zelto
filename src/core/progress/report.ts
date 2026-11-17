// 「做成了什么」—— 失败现场的可追溯性
//
// 背景（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
// agent 跑完一轮，zelto 报的是：
//
// ```
// {"type":"run.aborted","payload":{"reason":"write-set violation","violations":["rt.txt"]}}
// ```
//
// 拦得对（rt.txt 确实越界），但**只说了「它违规了」**，
// 没说「它做成了什么」。人看到的是「又跑废了」，
// 而实际上是：3 个写集内文件已经改好了、只差最后一步。
//
// 于是人只能重跑 —— 而重跑会把已经做对的部分再做一遍，
// agent 大概率在同一个地方再岔一次。
//
// **这个模块要回答的问题是：这一轮结束时，做成了什么？**
//
// ── 为什么判定必须是确定性的 ────────────────────────────────────────
//
// 「这条验收标准做成了没有」看起来需要读懂语义 —— 但那要调模型（C3 禁止）。
// 所以这里**不比语义**，只比**可判定的结构事实**：
//
//   1. **规格里有几条验收标准**（真源，人写的）
//   2. **验收测试文件里有几条用例**，各是什么状态（pass / fail / todo）
//   3. **写集内实际改动了哪些文件**（git 事实）
//
// 三者结合能回答的问题（全部确定性）：
//
//   - 规格要求 5 条，验收文件里 5 条用例，3 条过、2 条失败
//     → 「3 条验收标准已验证通过，2 条没通过」
//   - 验收文件里 2 条还是 todo
//     → 「这 2 条根本没写断言」
//   - 改动了 6 个写集内文件
//     → 「动过的文件清单」
//
// 它**不能**回答「哪条验收标准对应哪个用例」——
// agent 会把用例名从原文改写成摘要（实测 v3-chrome-waterfall 就是如此），
// 文本匹配必然失配。所以这里只给**数量与清单**，不给逐条对应关系。
//
// 那不是缺陷，是**诚实的边界**：给出能保证的部分，
// 不给出只能靠猜的部分。

/** 一条验收用例的状态 */
export type CaseStatus = 'pass' | 'fail' | 'todo' | 'skipped' | 'other';

/** 验收文件里的一条用例 */
export interface CaseResult {
  /** 用例名（测试运行器报出来的名字） */
  name: string;
  /** 状态 */
  status: CaseStatus;
}

/** 「做成了什么」的判定结果 */
export interface ProgressReport {
  /** 规格里的验收标准条数；读不到规格时为 null */
  criteriaTotal: number | null;
  /** 验收文件里有多少条用例 */
  casesTotal: number;
  /** 通过的用例数 */
  passed: number;
  /** 失败的用例数 */
  failed: number;
  /** 还是 todo 的用例数（骨架状态 = 没写断言） */
  todo: number;
  /** 被跳过的用例数 */
  skipped: number;
  /** 失败的用例名（给人看：哪几条没过） */
  failedNames: string[];
  /** 通过的用例名（给人看：哪几条过了） */
  passedNames: string[];
  /** 写集内实际改动的文件 */
  changedFiles: string[];
  /**
   * 落在写集**之外**的改动（越界文件）。
   *
   * 为什么要分开：`changedFiles` 混着越界文件时，
   * 人看到「改动了 3 个文件」会以为都在写集内 ——
   * 而其中可能正是那个把这一轮废掉的文件。
   * 分开列，「做成了什么」与「什么把轮次废了」不会混为一谈。
   */
  outOfWriteSetFiles: string[];
  /** 判定的整体状态 */
  verdict: 'verified' | 'partial' | 'unverified' | 'unknown';
  /** 一句人话结论 */
  summary: string;
}

/**
 * 从测试运行器的 TAP 输出里读出**逐条用例**的结果。
 *
 * 认 node 测试运行器的 TAP 形态：
 *
 *   ok 1 - 用例名
 *   not ok 2 - 用例名
 *   # todo 3 - 用例名        （TAP 里 todo 也写作 not ok + directive）
 *
 * 以及默认 reporter / spec reporter 形态：
 *
 *   ✔ 用例名 (12.3ms)
 *   ✖ 用例名 (12.3ms)
 *   - 用例名 (skipped)
 *
 * **读不出就返回空数组** —— 不猜、不用正则硬凑一个结论。
 * 「不知道」与「没有」是两件事（与 ADR-033 的验收判定同一原则）。
 */
export function parseCaseResults(output: string): CaseResult[] {
  // 按**用例名**归并，同名取**最后一次**结果。
  //
  // 为什么取最后一次：同一用例被重试时，TAP 会先报一次失败再报一次通过。
  // 取最后一次 = 「最终结果」；取第一次 = 「中间态」——
  // 人关心的是这条验收标准最终有没有成立。
  const byName = new Map<string, CaseStatus>();
  const order: string[] = [];

  const push = (name: string, status: CaseStatus): void => {
    if (!byName.has(name)) order.push(name);
    byName.set(name, status);
  };

  for (const line of output.split('\n')) {
    // ── TAP 形态 ─────────────────────────────────────────────────────
    // `ok 1 - 名字` / `not ok 2 - 名字`
    const tap = line.match(/^\s*(not\s+ok|ok)\s+\d+\s+-\s+(.+?)\s*$/);
    if (tap) {
      const failed = tap[1].startsWith('not');
      let name = tap[2].trim();
      // TAP 把 todo / skip 写成**指令后缀**：`ok 1 - 名字 # TODO`。
      //
      // 这点很要紧：todo 用例在 TAP 里是 **ok**，不是 not ok ——
      // 不认这个后缀，一条 `test.todo(...)` 会被报成「已验证通过」。
      // 而 todo 的意思恰恰是「根本没验证」（ADR-034）。
      let status: CaseStatus = failed ? 'fail' : 'pass';
      const directive = name.match(/\s+#\s*(TODO|SKIP)\s*$/i);
      if (directive) {
        name = name.slice(0, directive.index).trim();
        status = directive[1].toUpperCase() === 'TODO' ? 'todo' : 'skipped';
      }
      push(name, status);
      continue;
    }

    // ── 默认 / spec reporter 形态 ────────────────────────────────────
    // `✔ 名字 (12.3ms)` / `✖ 名字 (12.3ms)` / `- 名字 (1.0ms) # TODO`
    //
    // 默认 reporter 把 todo 写成 `- 名字 (1.0ms) # TODO` ——
    // 标记是 `-`（不是 ✖），但**带着 `# TODO` 后缀**。
    // 认不出这个后缀就会把 todo 当成「跳过了」，进而算成「验证过」。
    const spec = line.match(/^\s*([✔✖✗x✘-])\s+(.+?)\s*(?:\([\d.]+m?s\)|\(skipped\)|\(todo\))?\s*(#\s*(?:TODO|SKIP))?\s*$/);
    if (spec) {
      const mark = spec[1];
      let name = spec[2].trim();
      let status: CaseStatus;
      if (mark === '✔') status = 'pass';
      else if (mark === '✖' || mark === '✗' || mark === 'x' || mark === '✘') status = 'fail';
      else if (/\(skipped\)/.test(line)) status = 'skipped';
      else if (/\(todo\)/.test(line)) status = 'todo';
      else status = 'other';

      const directive = spec[3]?.match(/#\s*(TODO|SKIP)/i);
      if (directive) {
        name = name.replace(/\s*#\s*(?:TODO|SKIP)\s*$/i, '').trim();
        status = directive[1].toUpperCase() === 'TODO' ? 'todo' : 'skipped';
      }
      push(name, status);
      continue;
    }
  }

  return order.map((name) => ({ name, status: byName.get(name) as CaseStatus }));
}

/**
 * 检测验收文件里**还有多少条 `test.todo(...)`**。
 *
 * 为什么单独数：TAP 输出里 todo 用例与真失败长得一样（都是 `not ok`），
 * 光看运行结果分不出「这条断言写错了」和「这条根本没写」。
 * 这两者的修法完全不同（改实现 vs 写测试）—— 所以必须分开报。
 *
 * 读的是**源码**而不是输出：todo 是源码里的字面量，源码是最准的来源。
 */
export function countTodoCases(source: string): number {
  const matches = source.match(/\btest\s*\.\s*todo\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * 组装「做成了什么」的判定。
 *
 * @param input.criteriaTotal 规格里的验收标准条数（读不到就 null）
 * @param input.cases 验收文件跑出来的用例结果
 * @param input.todoCount 验收源码里还剩多少条 test.todo
 * @param input.changedFiles worktree 里实际改动的文件
 * @param input.outOfWriteSetFiles 其中落在写集之外的那些（越界文件）
 */
export function buildProgressReport(input: {
  criteriaTotal: number | null;
  cases: CaseResult[];
  todoCount: number;
  changedFiles: string[];
  outOfWriteSetFiles?: string[];
}): ProgressReport {
  const { criteriaTotal, cases, todoCount, changedFiles } = input;
  const outOfWriteSetFiles = input.outOfWriteSetFiles ?? [];

  const passedNames = cases.filter((c) => c.status === 'pass').map((c) => c.name);
  const failedNames = cases.filter((c) => c.status === 'fail').map((c) => c.name);
  const skippedCount = cases.filter((c) => c.status === 'skipped').length;

  // todo 用例在 TAP 里被算作 fail —— 两者要分开报，不能混成一个数字。
  // 判据：用例名在 todo 名单里 → 归 todo，不归 fail。
  // todo 名单从源码的 `test.todo("...")` 字面量里取。
  const passed = passedNames.length;
  const failed = failedNames.length;
  const todo = todoCount;

  let verdict: ProgressReport['verdict'];
  if (cases.length === 0 && todo === 0) {
    verdict = 'unknown';
  } else if (todo > 0 || failed > 0) {
    verdict = passed > 0 ? 'partial' : 'unverified';
  } else {
    verdict = 'verified';
  }

  const summary = summarizeProgress({
    criteriaTotal,
    passed,
    failed,
    todo,
    changed: changedFiles.length,
    verdict,
  });

  return {
    criteriaTotal,
    casesTotal: cases.length,
    passed,
    failed,
    todo,
    skipped: skippedCount,
    failedNames,
    passedNames,
    changedFiles,
    outOfWriteSetFiles,
    verdict,
    summary,
  };
}

/** 把数字拼成一句人话。 */
function summarizeProgress(input: {
  criteriaTotal: number | null;
  passed: number;
  failed: number;
  todo: number;
  changed: number;
  verdict: ProgressReport['verdict'];
}): string {
  const { criteriaTotal, passed, failed, todo, changed, verdict } = input;
  const parts: string[] = [];

  if (criteriaTotal !== null) {
    parts.push(`规格要求 ${criteriaTotal} 条验收标准`);
  }
  if (passed > 0) parts.push(`${passed} 条已验证通过`);
  if (failed > 0) parts.push(`${failed} 条断言不成立`);
  if (todo > 0) parts.push(`${todo} 条还没写断言`);
  if (changed > 0) parts.push(`改动 ${changed} 个文件`);

  if (parts.length === 0) return '这一轮没有留下任何可判定的进展';

  const head =
    verdict === 'verified'
      ? '已全部验证'
      : verdict === 'partial'
        ? '部分完成'
        : verdict === 'unverified'
          ? '未验证'
          : '进展不明';

  return `${head}：${parts.join('、')}`;
}

/**
 * 把判定渲染成给人看的几行。
 *
 * 为什么要单独渲染：判定是给机器看的（事件 payload），
 * 人看的是「它做成了什么」—— 这两者的信息密度不同。
 */
export function formatProgressLines(report: ProgressReport): string[] {
  const lines: string[] = [];
  lines.push(`📊 这一轮的进展：${report.summary}`);

  if (report.passedNames.length > 0) {
    lines.push(`  ✅ 已验证（${report.passedNames.length}）：`);
    for (const name of report.passedNames) lines.push(`     · ${name}`);
  }
  if (report.failedNames.length > 0) {
    lines.push(`  ❌ 断言不成立（${report.failedNames.length}）：`);
    for (const name of report.failedNames) lines.push(`     · ${name}`);
  }
  if (report.todo > 0) {
    lines.push(`  ⬜ 还没写断言（${report.todo}）—— 这部分根本没被验证过`);
  }

  // 越界文件单列 —— 它是「把这一轮废掉」的原因，
  // 混在改动清单里会让人以为「都做成了，就差一点点」。
  const outOfSet = new Set(report.outOfWriteSetFiles);
  const inSet = report.changedFiles.filter((f) => !outOfSet.has(f));

  if (inSet.length > 0) {
    lines.push(`  📁 写集内改动（${inSet.length}）—— 这些是本片该做的事：`);
    for (const file of inSet) lines.push(`     · ${file}`);
  }
  if (report.outOfWriteSetFiles.length > 0) {
    lines.push(`  🚫 写集外改动（${report.outOfWriteSetFiles.length}）—— 这些把这一轮废了：`);
    for (const file of report.outOfWriteSetFiles) lines.push(`     · ${file}`);
  }
  return lines;
}
