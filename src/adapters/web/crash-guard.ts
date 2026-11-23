// Web 驾驶舱的**崩溃兜底** —— 让「服务突然消失」变成「服务还活着，但出了事」
//
// ── 病灶 ──────────────────────────────────────────────────────────────
//
// 驾驶舱是**前台进程**（ADR-072 §10：不是常驻 daemon）。
// 这意味着它的生死完全绑在那个终端窗口上 —— 终端一关、Ctrl+C、
// 机器休眠、远程会话注销，进程就没了。浏览器标签页还留着，
// 停在最后一次轮询的画面上，看着像「卡住」。
//
// 但还有**另一种**消失方式，而且它更让人措手不及：
//
//   驾驶舱是**长跑**的 —— 开着跑几十分钟没问题。
//   期间任何一次逃出 `handle()` 那个 try/catch 的异步异常，
//   Node 的默认行为是「打印栈 → 退出进程」。
//   于是驾驶舱**瞬间消失**，终端里只剩一行红字，
//   浏览器里那个页面看起来跟平常一模一样（只是不再更新）。
//
// 后者是可以修的：这类异常**不该**让服务整个消失。
// 驾驶舱是个**只读为主**的观察窗 —— 一次写事件失败、
// 一次文件读抖了，都不该让整块仪表盘连同人在意的所有页面一起蒸发。
//
// ── 为什么是「记录 + 继续服务」而不是「记录 + 退出」────────────────────
//
// 退出的话，人面对的还是「页面不动了，但不知道为什么」——
// 与现状没区别，只是多了一行红字。
// 继续服务的话，页面还在、还在刷新、顶栏会明确标出「出过一次错」。
//
// 之所以敢这么取舍，是因为驾驶舱的判定都在 `core/` 里跑（纯计算、C3），
// 而 Web 侧**不重写任何判定**（ADR-072 §4）。一次外围的 I/O 抖动
// 不会污染任何判定结论 —— 它只会让这一次请求失败。
//
// ── 边界 ──────────────────────────────────────────────────────────────
//
// 只兜「外围异常」。**不改任何判定**，也不吞掉错误：
//   - 错误照样进 stderr（带完整栈）—— 人要能查
//   - 错误照样计入「出了几次事」—— 顶栏要能显示
//
// 真正不可恢复的（OOM、进程被外部杀掉）不在这里讨论 ——
// 那些本来也救不回来。

/** 驾驶舱出过一次事时的记录。 */
export interface CockpitCrashRecord {
  /** 时刻（ISO） */
  at: string;
  /** 错误类型 */
  kind: 'uncaughtException' | 'unhandledRejection';
  /** 错误消息 */
  message: string;
  /** 栈（可选） */
  stack?: string;
}

/** 兜底器的对外接口。 */
export interface CockpitCrashGuard {
  /** 出过几次事 */
  readonly count: number;
  /** 最近一次出事的记录（没有则为 null） */
  readonly last: CockpitCrashRecord | null;
  /** 全部记录（按时间序） */
  readonly records: readonly CockpitCrashRecord[];
  /** 撤掉监听（停服务时调用） */
  dispose(): void;
}

/** 兜底器的可选参数。 */
export interface CockpitCrashGuardOptions {
  /** 出事时怎么报告（默认写 stderr） */
  onCrash?: (record: CockpitCrashRecord) => void;
  /** 最多留多少条记录（防止长跑时无限增长） */
  maxRecords?: number;
}

/**
 * 装上崩溃兜底。
 *
 * 返回的 `dispose()` 必须在停服务时调用 —— 否则监听器会留在进程上，
 * 而进程本来就要退了，留着无害；但**测试里**必须撤干净，
 * 否则一个测试装上的兜底会兜住另一个测试的异常。
 */
export function installCockpitCrashGuard(
  options: CockpitCrashGuardOptions = {},
): CockpitCrashGuard {
  const maxRecords = options.maxRecords ?? 50;
  const records: CockpitCrashRecord[] = [];
  let last: CockpitCrashRecord | null = null;

  const report =
    options.onCrash ??
    ((record: CockpitCrashRecord) => {
      // 默认报告：写到 stderr，并明确说清「服务还活着」。
      //
      // 为什么一定要说「还活着」：人看到红字的第一反应是
      // 「驾驶舱挂了」→ 关标签页 → 重新跑 zelto web。
      // 而实际上服务还好好的，只是有一次请求没能完成。
      // 把这个差别说清楚，人就不必做那次重启。
      console.error(
        `⚠️  zelto 驾驶舱出了一次错（${record.kind}）：${record.message}\n` +
          `    服务仍在运行 —— 这一处只是没完成，不影响其它页面。\n` +
          (record.stack ? `${record.stack}\n` : '') +
          `    完整上下文见终端输出。`,
      );
    });

  const record = (kind: CockpitCrashRecord['kind'], err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const entry: CockpitCrashRecord = {
      at: new Date().toISOString(),
      kind,
      message,
      ...(stack ? { stack } : {}),
    };
    last = entry;
    records.push(entry);
    while (records.length > maxRecords) records.shift();
    try {
      report(entry);
    } catch {
      // 报告本身失败（比如 stderr 写不进去）—— 那也不能让进程死。
    }
  };

  const onUncaught = (err: unknown): void => {
    record('uncaughtException', err);
  };
  const onUnhandled = (reason: unknown): void => {
    record('unhandledRejection', reason);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);

  return {
    get count() {
      return records.length;
    },
    get last() {
      return last;
    },
    get records() {
      return records;
    },
    dispose(): void {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    },
  };
}
