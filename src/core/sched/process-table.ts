// 进程表快照 —— 「这个 agent 到底还活着吗」需要看到**整棵进程树**
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   zelto 在 Windows 上用 `shell: true` 起 agent，记录下来的 pid 是
//   **外层 cmd.exe** 的 pid。而真正的 agent（`claude.exe`）是孙进程：
//
//     cmd.exe(记录在案)  →  cmd.exe  →  node/npx  →  claude.exe（真 agent）
//
//   外层 cmd.exe 退出后，claude.exe **还活着**，还在改文件、还在烧 token。
//   但 zelto 的活性判定只看记录的那个 pid：
//
//     「进程 48092 已经不在了」→ 判 `dead` → 看门狗/重跑逻辑认为
//     「这片跑挂了」→ 在**同一个 worktree** 上又起了一个 agent。
//
//   现场后果：v2-input-binder 同时有两个 agent 在写同一个 worktree
//   （13:16 一个、14:01 一个），互相覆盖对方的产出。
//
// 修法有两条，缺一不可：
//
//   1. **记录真 agent 的 pid**（`agentPid`）—— 活性判定以它为准；
//   2. **兜底看整棵树**（`isProcessTreeAlive`）—— 记录没写、或写的是
//      包装进程时，仍能通过后代进程证明「还活着」。
//
// C2: core/ 零第三方运行时依赖（只用 Node 内置）；
// C3: 纯本地进程查询，不调模型、不触网。

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/** 进程表里的一行。 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  /** 命令行（可能为空 —— 有些系统进程拿不到） */
  cmdline: string;
}

/**
 * 进程表快照的缓存。
 *
 * 拿进程表在 Windows 上要起一个 `powershell` 子进程（~1s），
 * 而活性判定在 `status` / 看板 / 看门狗里都会被调用 —— 每次都查会拖垮界面。
 * 缓存 2 秒：足够覆盖一次轮询，又不至于拿到过期的现场。
 */
let cachedRows: ProcessRow[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 2_000;

/** 让缓存失效（测试用；也用于「刚发生进程变化，想立刻看到」的场合）。 */
export function invalidateProcessTable(): void {
  cachedRows = null;
  cachedAt = 0;
}

/**
 * 读一次进程表。
 *
 * Windows：`Get-CimInstance Win32_Process`（wmic 在新版本 Windows 上已废弃）。
 * POSIX：`ps -eo pid=,ppid=,comm=,args=`。
 *
 * 拿不到就返回空数组 —— 调用方据此「不敢判死」，宁可说可疑也不误杀。
 */
export async function readProcessTable(): Promise<ProcessRow[]> {
  const now = Date.now();
  if (cachedRows !== null && now - cachedAt < CACHE_TTL_MS) return cachedRows;

  let rows: ProcessRow[] = [];
  try {
    rows = platform() === 'win32' ? await readWindowsProcessTable() : await readPosixProcessTable();
  } catch {
    rows = [];
  }

  cachedRows = rows;
  cachedAt = now;
  return rows;
}

/**
 * Windows 进程表。
 *
 * 用 `-NoProfile -NonInteractive` 压住启动开销；
 * 命令行里查 `CommandLine` 字段 —— 找 agent 的 pid 靠的就是它
 * （命令行里有 `--session-id <uuid>`）。
 */
function readWindowsProcessTable(): Promise<ProcessRow[]> {
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ' +
    'ConvertTo-Json -Compress';
  return new Promise<ProcessRow[]>((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        resolve(parseJsonProcessTable(stdout));
      },
    );
  });
}

/** POSIX 进程表。 */
function readPosixProcessTable(): Promise<ProcessRow[]> {
  return new Promise<ProcessRow[]>((resolve) => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,comm=,args='],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        const rows: ProcessRow[] = [];
        for (const line of stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const m = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(t);
          if (!m) continue;
          rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            name: m[3],
            cmdline: m[4] ?? '',
          });
        }
        resolve(rows);
      },
    );
  });
}

/**
 * 解析 `ConvertTo-Json` 的输出。
 *
 * PowerShell 的 `ConvertTo-Json` 在**只有一行**时输出的是对象而不是数组 ——
 * 这个坑踩过一次，所以这里两种形态都接。
 */
function parseJsonProcessTable(stdout: string): ProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pid = toInt(o.ProcessId);
    if (pid === null) continue;
    rows.push({
      pid,
      ppid: toInt(o.ParentProcessId) ?? 0,
      name: typeof o.Name === 'string' ? o.Name : '',
      cmdline: typeof o.CommandLine === 'string' ? o.CommandLine : '',
    });
  }
  return rows;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 找某个后代进程（深度优先）。
 *
 * 判定「进程树里还有没有活着的」用得上：
 * 记录的是包装进程、真正的 agent 是它的后代时，
 * 包装进程死了但后代活着 → 仍然算活着。
 */
export function findDescendants(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const childrenOf = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.ppid);
    if (list) list.push(r);
    else childrenOf.set(r.ppid, [r]);
  }
  const out: ProcessRow[] = [];
  const stack = [...(childrenOf.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const r = stack.pop()!;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    out.push(r);
    for (const c of childrenOf.get(r.pid) ?? []) stack.push(c);
  }
  return out;
}

/**
 * 进程树里是否还有活着的进程。
 *
 * 与 `isProcessAlive(pid)` 的区别：
 *   - `isProcessAlive`：只看 pid 本身
 *   - 本函数：pid 本身**或它的任一后代**活着就算活着
 *
 * 后者才是 Windows 上判 agent 死活的口径 —— 见本文件开头的病灶说明。
 */
export async function isProcessTreeAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const rows = await readProcessTable();
  if (rows.length === 0) {
    // 拿不到进程表 → 不敢判死（fail safe：宁可说可疑）
    return true;
  }
  if (rows.some((r) => r.pid === pid)) return true;
  return findDescendants(rows, pid).length > 0;
}

/**
 * 按命令行特征找进程 pid —— 用来定位**真正的 agent 进程**。
 *
 * 判据：命令行里含 `needle`（例如 `--session-id <uuid>`）。
 * 这正是 agent 命令行的独有特征，比「猜第几层子进程」可靠得多。
 */
export async function findPidsByCmdline(needle: string): Promise<number[]> {
  if (!needle) return [];
  const rows = await readProcessTable();
  return rows.filter((r) => r.cmdline.includes(needle)).map((r) => r.pid);
}
