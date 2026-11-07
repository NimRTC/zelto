// TAP 解析 —— 从测试运行器的输出里读出「哪条用例、什么状态」
//
// 为什么需要它：版本级验收跑完只得到一个「过 / 不过」。但「过」这件事
// 掩盖了一个更隐蔽的坏法：**agent 把证明某个行为的用例删了**，
// 或者把它改成 `test.todo(...)`。整片测试仍然是绿的，验收也仍然通过，
// 而那个行为其实已经没人验证了。
//
// 跨版本回归基线要抓的就是这个：把「上个版本通过过哪些用例」记下来，
// 到新版本交付时对比 —— 少了、变了、退化了，就是回归。
//
// 解析口径：**只认 TAP 里明确写出来的东西**。读不出用例列表时返回
// `known: false`，调用方据此放弃判断 —— 别的测试运行器（vitest / jest）
// 输出格式不同，猜不得（与 ADR-033 的验收统计同一条原则）。

/** 单条用例的状态 */
export type TestStatus = 'pass' | 'fail' | 'skip' | 'todo';

/** 一条用例 */
export interface TestResult {
  /** 用例名 */
  name: string;
  /** 所属测试文件（能认出来时才有） */
  file: string | null;
  /** 状态 */
  status: TestStatus;
}

/** TAP 解析结果 */
export interface TapResults {
  /** 是否真的读到了 TAP 用例列表 */
  known: boolean;
  /** 用例列表 */
  tests: TestResult[];
}

/**
 * 解析 TAP 输出。
 *
 * 认的行：
 *   `ok 1 - name` / `not ok 2 - name`（允许前导缩进）
 *   行尾的 `# TODO` / `# SKIP` 标记 → 状态改成 todo / skip
 *   `# Subtest: xxx` —— 当 xxx 看起来是文件路径时，作为后续用例的所属文件
 */
export function parseTapResults(output: string): TapResults {
  const tests: TestResult[] = [];
  let currentFile: string | null = null;

  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();

    const subtest = line.match(/^\s*#\s*Subtest:\s*(.+)$/);
    if (subtest) {
      const name = subtest[1].trim();
      // 只有看起来是文件路径的 Subtest 头才算「所属文件」——
      // 用例名本身也会以 Subtest 出现，把它当文件会把名字搞乱。
      if (/\.(c|m)?(j|t)s$/.test(name)) currentFile = name;
      continue;
    }

    const m = line.match(/^\s*(not ok|ok)\s+(\d+)\s*(?:-\s*)?(.*)$/);
    if (!m) continue;

    const status: TestStatus = m[1] === 'not ok' ? 'fail' : 'pass';
    let name = m[3].trim();

    // 行尾标记：node 测试运行器把 TODO / SKIP 写在用例名后面
    let effective: TestStatus = status;
    if (/#\s*TODO\b/i.test(name)) {
      effective = 'todo';
      name = name.replace(/\s*#\s*TODO\b.*$/i, '').trim();
    } else if (/#\s*SKIP\b/i.test(name)) {
      effective = 'skip';
      name = name.replace(/\s*#\s*SKIP\b.*$/i, '').trim();
    }

    if (!name) continue;
    tests.push({ name, file: currentFile, status: effective });
  }

  return { known: tests.length > 0, tests };
}

/**
 * 合并多段输出（版本级验收会跑多条命令）的解析结果。
 *
 * 同一文件里的同名用例可能出现多次（不同命令跑同一批测试）——
 * 合并时按「文件 + 用例名」去重，状态取**更差**的那个：
 * 只要有一条记录是 fail，整体就算 fail。
 */
export function mergeTapResults(results: TapResults[]): TapResults {
  const merged = new Map<string, TestResult>();
  let known = false;

  for (const result of results) {
    if (!result.known) continue;
    known = true;
    for (const test of result.tests) {
      const key = `${test.file ?? ''}::${test.name}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...test });
        continue;
      }
      if (rank(test.status) > rank(existing.status)) {
        merged.set(key, { ...test });
      }
    }
  }

  return { known, tests: [...merged.values()] };
}

function rank(status: TestStatus): number {
  switch (status) {
    case 'fail':
      return 3;
    case 'todo':
      return 2;
    case 'skip':
      return 1;
    default:
      return 0;
  }
}

/** 用例的稳定标识（文件 + 名字） */
export function testKey(test: TestResult): string {
  return `${test.file ?? ''}::${test.name}`;
}
