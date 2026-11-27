// ACP 的鉴权 —— 「这个 agent 要不要先登录」（ADR-133 落地补充）
//
// 为什么需要这一层：**实测发现**（2026-11-27，`cursor-agent acp`）
// agent 的 `initialize` 回包里带 `authMethods`，而 `session/new` 在
// 没登录时会返回：
//
//   Authentication required. Please run 'agent login' first,
//   then call authenticate() with methodId 'cursor_login'.
//
// zelto 原实现**直接去建会话**，于是这句话变成了
// 「ACP 会话失败：Authentication required」——
// 说的是事实，但人不知道**该做什么**。
//
// ── 设计原则 ──────────────────────────────────────────────────────────
//
// **zelto 不替用户登录。** 登录是浏览器授权流程（`agent login`），
// 涉及人自己的账号与交互式确认 —— zelto 抢在前面做，两头不讨好：
//
//   - 浏览器弹窗在 agent 子进程里，zelto 看不见、也点不了；
//   - 就算能点，也是**替人做凭证授权**（ADR-090 的凭证外部化精神）。
//
// 所以 zelto 做的是：**认出「需要登录」，并把可执行的修法原样交回给人**。
//
// 这与 C9 的 fail closed 不冲突：登录失败时**根本不会进入判定环节**，
// 没有「静默放行」的可能。

/** agent 在 `initialize` 回包里报的鉴权方式。 */
export interface AcpAuthMethod {
  /** 方法 id —— 传给 `authenticate` 的 `methodId` */
  id: string;
  /** 展示名 */
  name: string;
  /** 说明（通常是「怎么登录」的指引） */
  description?: string | null;
}

/** `initialize` 回包里与鉴权相关的部分。 */
export interface AcpInitAuthInfo {
  authMethods?: AcpAuthMethod[] | null;
}

/**
 * 从 `initialize` 回包里抽出鉴权方式。
 *
 * agent 可能**不报** `authMethods`（老版本 agent 或不需要登录的 agent）。
 * 那时返回空数组 ——「没报」不等于「要登录」，也不等于「不要登录」。
 */
export function extractAuthMethods(init: AcpInitAuthInfo | null | undefined): AcpAuthMethod[] {
  const raw = init?.authMethods;
  if (!Array.isArray(raw)) return [];
  const out: AcpAuthMethod[] = [];
  for (const m of raw) {
    if (!m || typeof m.id !== 'string' || m.id.length === 0) continue;
    out.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      description: typeof m.description === 'string' ? m.description : null,
    });
  }
  return out;
}

/**
 * 拼出「这个 agent 要怎么登录」的人话（可直接打印给人看）。
 *
 * 有几条就说几条 —— 不同 agent 的登录方式不一样，
 * 只报第一条可能刚好是错的那条。
 */
export function describeAuthMethods(methods: AcpAuthMethod[]): string {
  if (methods.length === 0) return '';
  const lines = methods.map((m) => {
    const desc = m.description ? ` —— ${m.description}` : '';
    return `  - ${m.name}（methodId: ${m.id}）${desc}`;
  });
  return `这个 ACP agent 需要先登录。可用的登录方式：\n${lines.join('\n')}`;
}

/**
 * 判定一次「需要登录」的失败，并给出**可执行的修法**。
 *
 * 为什么要专门识别这句话：agent 的错误措辞各家不同，但
 * 「Authentication required」是 ACP 里最常见的一种。
 * 认出来 → 给出登录指引；认不出来 → 照原样报错（不猜）。
 *
 * @returns null 表示「不是鉴权问题」，按普通错误处理。
 */
export function detectAuthRequired(
  message: string,
  methods: AcpAuthMethod[],
): string | null {
  const lower = message.toLowerCase();
  const looksAuth =
    lower.includes('authentication required') ||
    lower.includes('not authenticated') ||
    lower.includes('unauthenticated');
  if (!looksAuth) return null;

  const detail = describeAuthMethods(methods);
  return (
    `ACP agent 需要先登录（当前未认证）。\n` +
    (detail ? `${detail}\n` : '') +
    `zelto 不代你登录 —— 登录涉及你自己的账号授权。` +
    `请先在该 agent 的 CLI 里完成登录，再重跑。`
  );
}
