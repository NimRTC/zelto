// 持久化会话文件 —— 「这一轮 agent 跑到哪儿了」的唯一载体
//
// 为什么抽出来（ADR-086）：
//
//   活性判定（core/activity/liveness.ts）读的是**会话文件**，
//   它的字段名（status / pid / agentPid / lastActivityAt / output …）
//   被三处写入：Claude Code 适配器、Cursor 适配器、后台任务文件。
//
//   字段名一旦漂移，判定就会在一边读到 undefined —— 而 undefined
//   会被当成「没有心跳」= 假死，把活着的 agent 误判成死的
//   （这一类误判在 nimrtc 演练里踩过：D-30 / D-59 / D-74）。
//
//   所以格式只有这一份定义，两个适配器共用。
//
// C1: 状态只在文件里（.zelto/sessions/<sessionId>.json）
// C2: 只用 Node 内置模块

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 会话文件所在目录（相对项目根）。 */
export const SESSIONS_DIR = '.zelto/sessions';

/**
 * 一次运行的持久化记录。
 *
 * 字段名与 core/activity/liveness.ts 的 `LivenessRecord` 对齐 ——
 * 那里的判定直接读这个文件的字段。
 */
export interface PersistentSessionData {
  sessionId: string;
  sliceId: string;
  /** 跑这条会话的 agent 命令（原文） */
  agentCommand: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  exitCode: number | null;
  timeoutMs: number | null;
  retryCount: number;
  maxRetries: number;
  /** 原始 bundle 路径（重试时要用） */
  prompt: string;
  /** agent 的输出（分块） */
  output: string[];
  /** 最后活动时间（ISO）—— 心跳写这里 */
  lastActivityAt?: string;
  /** 最后一条 agent 输出的时间 */
  lastOutputAt?: string;
  /** 外层包装进程 pid */
  pid?: number;
  /** 真正的 agent 进程 pid（Windows 上与 pid 不同） */
  agentPid?: number;
  /** agent 侧会话 id（Claude 的 session uuid / Cursor 的 chat id） */
  agentSessionId: string | null;
  /** agent 实际工作目录 —— 续跑必须用同一个 */
  cwd: string;
  /** 本会话续的是哪个 zelto 会话（null = 全新开始） */
  resumedFrom: string | null;
}

/** 会话文件路径（相对项目根）。 */
export function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

/** 写会话文件（覆盖 —— 这是一份「当前状态」快照，不是事件流）。 */
export function saveSession(data: PersistentSessionData): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  writeFileSync(sessionPath(data.sessionId), JSON.stringify(data, null, 2), 'utf-8');
}

/** 读会话文件；读不到 / 坏掉 → null。 */
export function loadSession(sessionId: string): PersistentSessionData | null {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PersistentSessionData;
  } catch {
    return null;
  }
}

/** 列出盘上所有会话 id。 */
export function listSessionIds(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
