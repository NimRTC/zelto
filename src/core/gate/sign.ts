// Sign manager — sign request lifecycle
// See docs/zelto-技术架构.md §7.1

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStream, EventType } from '../events/stream.js';
import type { SliceStore } from '../slice/store.js';

export interface SignRequest {
  id: string;
  sliceId: string;
  requestedAt: string;
  requestedBy: string;
  /**
   * 签字请求的状态。
   *
   * ADR-094 §5.1 加了两个新状态：
   *
   * - `revised` —— **退回重跑**。人审出毛病但方向对，让片回 `frozen`
   *   带着意见重跑。区别于 `rejected`（那是终态作废）。
   * - `returned` —— **退回上游**。方向不对，片回 `draft` 改规格。
   *
   * 老状态文件里没有这两个值 —— 读时不需要归一化，
   * 因为它们是「新的」而不是「旧写法」。
   */
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'revised' | 'returned';
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string | null;
}

export class SignManager {
  private readonly locksDir: string;
  private readonly events: EventStream;
  private readonly store: SliceStore;

  constructor(baseDir: string, events: EventStream, store: SliceStore) {
    this.locksDir = join(baseDir, 'locks');
    this.events = events;
    this.store = store;
  }

  private path(id: string): string {
    return join(this.locksDir, `${id}.json`);
  }

  async request(sliceId: string, requestedBy: string = 'zelto'): Promise<SignRequest> {
    await mkdir(this.locksDir, { recursive: true });

    const id = `sign-${sliceId}-${Date.now()}`;
    const req: SignRequest = {
      id,
      sliceId,
      requestedAt: new Date().toISOString(),
      requestedBy,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      comment: null,
    };

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(sliceId, 'sign.requested', requestedBy, {
      signId: id,
      sliceId,
    });

    return req;
  }

  async approve(id: string, decidedBy: string = 'human', comment: string | null = null): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending') {
      throw new Error(`Sign request ${id} is already ${req.status}`);
    }

    req.status = 'approved';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.approved', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // 状态转移：frozen → completed / completed → completed
    //
    // **转移失败不吞掉**（ADR-094 D-19）：
    //
    // 原来的 `catch {}` 让「批准了但切片状态没变」这件事静悄悄过去 ——
    // 人看到「Approved」，追溯链里却是「已批准」与「切片还在 draft」
    // 两份对不上的事实。而 `merge` 的判据是「存在 approved 的签字请求」，
    // 于是一片压根没跑过的切片也能进合并候选。
    //
    // 但**不抛错**：签字本身是**人的决定**，请求已记为 approved。
    // 切片状态转移失败只说明「这片的状态与「已批准」对不上」——
    // 那要**报出来**，由人决定怎么办，不是替人拒绝签字。
    //
    // （`--force` 就是这条路的正当出口：明知故犯地批准一片没跑好的片。）
    const slice = await this.store.read(req.sliceId).catch(() => null);
    if (slice) {
      const prevState = slice.state;
      try {
        await this.store.transit(req.sliceId, 'SIGN_APPROVE');
        await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
          sliceId: req.sliceId,
          from: prevState,
          to: 'completed',
          event: 'SIGN_APPROVE',
        });
      } catch {
        // 状态转移不了（比如切片还在 draft / running）——
        // **如实报出来**，但不推翻人的签字。
        await this.appendEvent(req.sliceId, 'sign.state_mismatch', decidedBy, {
          signId: id,
          sliceId: req.sliceId,
          sliceState: slice.state,
          expected: 'frozen or completed',
          note: '已批准，但切片状态未随之改变 —— 追溯链里这两件事对不上',
        });
      }
    }

    return req;
  }

  async reject(id: string, decidedBy: string = 'human', comment: string | null = null): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending') {
      throw new Error(`Sign request ${id} is already ${req.status}`);
    }

    req.status = 'rejected';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.rejected', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // 状态转移：completed → abandoned
    //
    // **转移失败不吞掉**（ADR-094 D-19）—— 与 `approve()` 同一条理由：
    // 静悄悄过去会留下「已拒绝」与「切片还在 completed」两份对不上的事实。
    //
    // 但**不抛错**：拒绝是**人的决定**，请求已记为 rejected。
    // 转移不了就**报出来**，由人决定怎么办。
    const slice = await this.store.read(req.sliceId).catch(() => null);
    if (slice) {
      const prevState = slice.state;
      try {
        await this.store.transit(req.sliceId, 'SIGN_REJECT');
        await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
          sliceId: req.sliceId,
          from: prevState,
          to: 'abandoned',
          event: 'SIGN_REJECT',
        });
      } catch {
        await this.appendEvent(req.sliceId, 'sign.state_mismatch', decidedBy, {
          signId: id,
          sliceId: req.sliceId,
          sliceState: slice.state,
          expected: 'completed',
          note: '已拒绝，但切片状态未随之改变 —— 追溯链里这两件事对不上',
        });
      }
    }

    return req;
  }

  /**
   * 撤销一次已经通过的签字（签错了要能回退）。
   *
   * 只有 `approved` 能撤销：`pending` 直接作废走 reject，`rejected` 没什么可撤。
   * 撤销不改变切片状态 —— 签字本来就没改状态（SIGN_APPROVE 停在 completed），
   * 撤销后切片仍是 completed：门禁过了，只是「批准」这条记录作废了，
   * 需要重新发起签名请求才能再合入主干。
   */
  async revoke(id: string, decidedBy: string = 'human', comment: string | null = null): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'approved') {
      throw new Error(`Sign request ${id} is ${req.status}, only "approved" can be revoked`);
    }

    req.status = 'revoked';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.revoked', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    return req;
  }

  /**
   * 退回重跑（ADR-094 §5.1）。
   *
   * 人审出毛病，但**方向是对的** —— 让片回到 `frozen`，带着意见重跑。
   *
   * 与 `reject()` 的区别是本方法的全部意义：
   *
   * - `reject()` → 切片进**终态** `abandoned`，规格得重写，整片作废；
   * - `reviseRequest()` → 切片回 `frozen`，规格与写集都不动，
   *   人的意见进事件流，下一轮 agent 的约束包会读到它。
   *
   * **只退状态，不起跑**（ADR-094 D4）—— 起跑是人的显式动作
   * （`zelto run`），与 ADR-018「签字不自动合并」同一条原则：
   * 人 confirm 了「改法」，不等于 confirm 了「现在就按这个改法跑」。
   *
   * **可以退 `approved` 的请求**（D11）：
   *
   * 人签了字、然后又发现问题 —— 这是最常见的场景。此时没有 `pending`
   * 请求可退，但**正是最该退的时候**。
   *
   * 所以这里接受 `pending` 与 `approved` 两种状态：
   * - `pending` → 直接转 `revised`；
   * - `approved` → 先转 `revised`（**同一条请求**，不新建），
   *   这样 `merge` 的判据（「存在 approved 的签字请求」）自然不成立 ——
   *   不需要「先 revoke 再 revise」两步，两步之间会有一个
   *   「既没批准也没退回」的中间态。
   *
   * 为什么不新建一条 `revised` 请求：同一片有两条签字请求时，
   * 「最新那条是什么」就成了新的判定负担（`pending-actions.ts` 已经在
   * 处理这个）。就地改是更少的活动部件。
   */
  async reviseRequest(
    id: string,
    decidedBy: string = 'human',
    comment: string | null = null,
  ): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending' && req.status !== 'approved') {
      throw new Error(
        `Sign request ${id} is ${req.status}, only "pending" or "approved" can be revised`,
      );
    }
    if (!comment || !comment.trim()) {
      throw new Error(
        `Sign request ${id} cannot be revised without a comment — ` +
          `the agent needs to know what to change`,
      );
    }

    // ── 状态校验必须在**动手之前** ──────────────────────────────────────
    //
    // 为什么不能「先改签字请求、状态转移失败就算了」（原来的写法）：
    //
    // 那样会留下一片**进退两难**的切片 ——
    //   签字请求已被消耗（pending → revised，不再能签）；
    //   切片状态没变（还在 draft / frozen）。
    //
    // 人看到的却是「已退回重跑，下一步 zelto run」—— 而 run 跑不了
    // （draft 片不能跑），签字请求也已经用掉了。**静默失败 + 误导提示。**
    //
    // 所以：状态不对就**先拒绝**，一个字都不改。
    //
    // 与 `approve()` / `reject()` 不同，这里**抛错**而不是「记下来再报」——
    // 因为「退回重跑」这个动作的**全部内容**就是「改变切片状态」。
    // 状态没变 = 动作没发生 = 人以为退回了而实际没有。
    //
    // （签字本身可以是「明知故犯」的，`--force` 就是出口；
    // 但「退回」没有这个语义 —— 退不回就明说退不回。）
    //
    // 判据与 `transitionSlice` 同源（`completed --SIGN_REVISE--> frozen`），
    // 但提前一步 —— 因为 `transitionSlice` 抛错时，写盘已经开始了。
    const slice = await this.store.read(req.sliceId);
    if (slice.state !== 'completed') {
      throw new Error(
        `Slice ${req.sliceId} is ${slice.state}, only a "completed" slice can be sent back for rework`,
      );
    }

    req.status = 'revised';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.revised', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // 状态转移：completed → frozen
    //
    // 上面已经校验过状态是 `completed`，所以这里**不该**再失败。
    // 万一失败（并发、文件被外部改过）—— 那就是真异常，必须冒出来，
    // 不能 `catch {}` 吞掉（吞掉就回到上面那个静默失败）。
    const prevState = slice.state;
    await this.store.transit(req.sliceId, 'SIGN_REVISE');
    await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
      sliceId: req.sliceId,
      from: prevState,
      to: 'frozen',
      event: 'SIGN_REVISE',
    });

    return req;
  }

  /**
   * 退回上游（ADR-094 §5.1）。
   *
   * 人审出**方向**不对 —— 规格要改。片回 `draft`，改完规格重新走
   * 门禁① + 冻结。
   *
   * 与 `reviseRequest()` 的区别在**回哪个状态**：
   *
   * - `reviseRequest()` → `frozen`（规格不动，重跑即可）
   * - `returnRequest()` → `draft`（规格要改，得重新冻结）
   *
   * 回 `draft` 而不是 `frozen` 是 ADR-094 D5 的要点：直接回 frozen
   * 会**跳过门禁①**，而规格改了之后门禁①必须重跑。
   *
   * 与 `reviseRequest()` 一样，可以退 `approved` 的请求（D11）。
   */
  async returnRequest(
    id: string,
    decidedBy: string = 'human',
    comment: string | null = null,
  ): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending' && req.status !== 'approved') {
      throw new Error(
        `Sign request ${id} is ${req.status}, only "pending" or "approved" can be returned`,
      );
    }
    if (!comment || !comment.trim()) {
      throw new Error(
        `Sign request ${id} cannot be returned without a comment — ` +
          `the agent needs to know what to change`,
      );
    }

    // ── 状态校验必须在**动手之前** ──────────────────────────────────────
    //
    // 与 `reviseRequest()` 同一条理由：不先校验就会留下一片进退两难的
    // 切片（签字请求被消耗、状态没变、提示却说「已退回」）。
    const slice = await this.store.read(req.sliceId);
    if (slice.state !== 'completed') {
      throw new Error(
        `Slice ${req.sliceId} is ${slice.state}, only a "completed" slice can be returned upstream`,
      );
    }

    req.status = 'returned';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.returned', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // 状态转移：completed → draft
    // 状态上面已校验 —— 失败就是真异常，必须冒出来（不 `catch {}` 吞掉）。
    const prevState = slice.state;
    await this.store.transit(req.sliceId, 'SIGN_RETURN');
    await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
      sliceId: req.sliceId,
      from: prevState,
      to: 'draft',
      event: 'SIGN_RETURN',
    });

    return req;
  }

  async get(id: string): Promise<SignRequest> {
    const content = await readFile(this.path(id), 'utf-8');
    // Windows 编辑器可能带 BOM —— 去掉再解析（仓库惯例：读时容错、写时不动）
    return JSON.parse(content.replace(/^\uFEFF/, '')) as SignRequest;
  }

  async list(status?: SignRequest['status']): Promise<SignRequest[]> {
    try {
      const files = await readdir(this.locksDir);
      const requests: SignRequest[] = [];

      for (const file of files) {
        if (!file.endsWith('.json') || !file.startsWith('sign-')) continue;
        try {
          const content = await readFile(join(this.locksDir, file), 'utf-8');
          // Windows 编辑器可能带 BOM —— 去掉再解析（仓库惯例：读时容错、写时不动）
          const req = JSON.parse(content.replace(/^\uFEFF/, '')) as SignRequest;
          if (!status || req.status === status) {
            requests.push(req);
          }
        } catch {
          // Skip malformed files
        }
      }

      return requests.sort(
        (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    const p = this.path(id);
    if (existsSync(p)) {
      await unlink(p);
    }
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal for sign operations
    }
  }
}
