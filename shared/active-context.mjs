// 活动上下文：任务模型当前使用的 checkpoint 与 raw-tail 起点。
//
// 目标机制见 docs/spec.md 的“活动上下文与 prompt cache 稳定性”。本模块只回答两个问题：
// 当前分支上应当固定哪一段上下文，以及这段上下文在 Pi 报告的任务模型容量内是否装得下。
// 它不触发接管，也不改变 provider 可见上下文——真实切换由上下文切换阶段承担。

import { readFile, rm } from "node:fs/promises";

import {
  checkpointEventIdFor,
  checkpointId as deriveCheckpointId,
  parseCheckpointEventById,
  renderCheckpointBlock,
} from "./checkpoint.mjs";
import { contextTokenWeight, eventTokenWeight } from "./context-weight.mjs";
import { observation as processObservation } from "./observe.mjs";
import { stateFileKey, writeStateFile } from "./state-file.mjs";

const ACTIVE_CONTEXT_IDENTITY_VERSION = 1;
const ACTIVE_CONTEXT_DOMAIN = "pi-openviking/active-context";
const CHECKPOINT_ID_PATTERN = /^chk_[0-9a-f]{64}$/;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{64}$/;

export function activeContextFileKey(target, sessionId) {
  return stateFileKey(ACTIVE_CONTEXT_DOMAIN, ACTIVE_CONTEXT_IDENTITY_VERSION, target, sessionId);
}

/**
 * 只接受 `docs/spec.md` 定义的两个字段。
 *
 * 该文件不是事实源：任何无法自证的内容都等价于“没有活动上下文”，随后从 Archive 与
 * checkpoint 事实重新选择，因此这里不抛错、只返回 null。
 */
export function normalizeActiveContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "checkpointId,rawTailStartEventId") return null;
  if (!CHECKPOINT_ID_PATTERN.test(value.checkpointId) || !EVENT_ID_PATTERN.test(value.rawTailStartEventId)) return null;
  return { checkpointId: value.checkpointId, rawTailStartEventId: value.rawTailStartEventId };
}

export async function readActiveContext(path) {
  try {
    return normalizeActiveContext(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function writeActiveContext(path, context) {
  const normalized = normalizeActiveContext(context);
  if (!normalized) throw new TypeError("ActiveContext requires a checkpointId and a rawTailStartEventId");
  return writeStateFile(path, normalized);
}

export async function clearActiveContext(path) {
  await rm(path, { force: true });
}

/**
 * 当前分支上的候选活动上下文。
 *
 * 来源是最后一个已消费的 Archive：checkpoint 替换的正是它绑定的已归档前缀，因此 raw tail
 * 从该 Archive 的最后一个事件之后开始，并自然覆盖“已归档但尚未消费”与“尚未归档”的全部
 * 事件。归档前缀之后还没有事件时没有可接管的上下文。
 */
export function selectActiveContext(branchEvents, archives, lastCheckpointId) {
  if (!CHECKPOINT_ID_PATTERN.test(lastCheckpointId ?? "")) return null;
  const source = (archives ?? []).find((descriptor) => {
    try {
      return deriveCheckpointId(descriptor?.manifest) === lastCheckpointId;
    } catch {
      return false;
    }
  });
  if (!source) return null;
  const position = branchEvents.findIndex((event) => event.eventId === source.manifest.lastEventId);
  const next = position < 0 ? undefined : branchEvents[position + 1];
  return next ? { checkpointId: lastCheckpointId, rawTailStartEventId: next.eventId } : null;
}

/**
 * 复用条件：raw tail 起点仍在当前分支的事件链上。
 *
 * raw tail 起点是来源 Archive 边界的直接后继，因此它在祖先链上等价于来源边界在祖先链上；
 * 该判定只依赖本地分支投影，分支变化时不需要网络即可决定能否复用。
 */
export function activeContextOnBranch(context, branchEvents) {
  return Boolean(context) && branchEvents.some((event) => event.eventId === context.rawTailStartEventId);
}

/**
 * 原始用户指令 anchor：建立 raw tail 所属 turn 的 user entry 的全部事件。
 *
 * anchor 因此不需要成为持久化字段——turn 身份由不可变事件固定，同一 raw tail 起点恒得同一
 * anchor。anchor 本身已经落在 raw tail 内时返回空，避免同一指令注入两次。
 */
export function anchorEvents(branchEvents, rawTailStartEventId) {
  const start = branchEvents.findIndex((event) => event.eventId === rawTailStartEventId);
  if (start < 0) return [];
  const turnId = branchEvents[start].turnId;
  if (typeof turnId !== "string") return [];
  // turnId 来自 raw tail 起点自身，因此 find 至少会命中它：只需判断 anchor 是否就是起点。
  const first = branchEvents.find((event) => event.turnId === turnId);
  if (first.eventId === rawTailStartEventId) return [];
  return branchEvents.filter((event, index) => index < start && event.source?.entryId === first.source?.entryId);
}

function sumWeight(events) {
  return events.reduce((total, event) => total + eventTokenWeight(event), 0);
}

/**
 * dry-run：把候选上下文 materialize 成任务模型将会看到的有序分段。
 *
 * 每一段都由不可变来源重算——checkpoint 由自身身份自证，anchor 与 raw tail 直接引用源事件
 * 对象——因此可以逐项对照源事件校验，而不需要另存一份副本。
 */
export function materializeActiveContext({ context, checkpoint, branchEvents, systemPrompt = "", toolDefinitions = "" }) {
  const start = branchEvents.findIndex((event) => event.eventId === context?.rawTailStartEventId);
  if (start < 0) throw new Error("raw tail start is not on the current branch");
  const rawTail = branchEvents.slice(start);
  const anchor = anchorEvents(branchEvents, context.rawTailStartEventId);
  const checkpointBlock = renderCheckpointBlock(checkpoint);
  const tokens = {
    system: contextTokenWeight(systemPrompt),
    tools: contextTokenWeight(toolDefinitions),
    checkpoint: contextTokenWeight(checkpointBlock),
    anchor: sumWeight(anchor),
    rawTail: sumWeight(rawTail),
  };
  tokens.payload = tokens.system + tokens.tools + tokens.checkpoint + tokens.anchor + tokens.rawTail;
  return {
    segments: [
      { kind: "system", text: systemPrompt },
      { kind: "checkpoint", text: checkpointBlock },
      { kind: "anchor", events: anchor },
      { kind: "raw-tail", events: rawTail },
    ],
    tokens,
  };
}

export function payloadSegment(payload, kind) {
  return payload?.segments.find((segment) => segment.kind === kind) ?? null;
}

/**
 * takeover eligibility。
 *
 * 容量与安全余量都取自 Pi 报告的任务模型元数据：`contextWindow` 是可用窗口，`maxTokens` 是
 * 必须为模型输出保留的容量，任何请求都不能占用它。`contextTokenThreshold` 只能把可用窗口
 * 压得更低，不能超过模型实际容量。余量为正表示候选上下文能在安全余量内完整装载。
 */
export function evaluateEligibility({ capacity, takeover, payloadTokens }) {
  const inactive = (eligibility) => ({
    eligibility,
    capacityTokens: Number.isFinite(capacity?.contextWindow) ? capacity.contextWindow : null,
    reserveTokens: Number.isFinite(capacity?.maxTokens) ? capacity.maxTokens : null,
    usableTokens: null,
    payloadTokens: Number.isFinite(payloadTokens) ? payloadTokens : null,
    headroomTokens: null,
  });
  if (takeover?.enabled === false) return inactive("takeover_disabled");
  if (!Number.isFinite(capacity?.contextWindow) || !Number.isFinite(capacity?.maxTokens)) return inactive("capacity_unknown");
  if (!Number.isFinite(payloadTokens)) return inactive("no_context");

  const threshold = Number(takeover?.contextTokenThreshold) || 0;
  const automatic = Math.max(0, capacity.contextWindow - capacity.maxTokens);
  const usableTokens = threshold > 0 ? Math.min(automatic, threshold) : automatic;
  const headroomTokens = usableTokens - payloadTokens;
  return {
    eligibility: headroomTokens > 0 ? "eligible" : "capacity_mismatch",
    capacityTokens: capacity.contextWindow,
    reserveTokens: capacity.maxTokens,
    usableTokens,
    payloadTokens,
    headroomTokens,
  };
}

const initialState = () => ({
  checkpointId: null,
  rawTailStartEventId: null,
  rawTailEvents: 0,
  eligibility: "no_context",
  capacityTokens: null,
  reserveTokens: null,
  usableTokens: null,
  payloadTokens: null,
  headroomTokens: null,
  lastFailure: null,
});

const errorMessage = (error) => `${error?.name || "Error"}: ${error?.message || String(error)}`;

/**
 * 活动上下文的选择、持久化与状态。
 *
 * 一经形成即保持固定，直到来源边界离开当前分支祖先链：推进到更新的 checkpoint 是接管时的
 * 原子替换（见 `docs/spec.md`），不属于本阶段，否则系统会出现第二条替换路径。
 */
export class ActiveContextManager {
  constructor({ path, adapter, takeover, observation = processObservation }) {
    this.path = path;
    this.adapter = adapter;
    this.takeover = takeover ?? { enabled: true, contextTokenThreshold: 0 };
    this.observe = observation;
    this.sessionId = null;
    this.context = null;
    this.loaded = false;
    this.checkpointCache = null;
    this.roundFailure = null;
    this.state = initialState();
    this.observe.emit("active_context_state", "snapshot", this.state, null);
  }

  get status() {
    return { ...this.state };
  }

  get current() {
    return this.context ? { ...this.context } : null;
  }

  observeFinalState() {
    this.observe.emit("active_context_state", "snapshot", this.state, null);
  }

  async update(sessionId, { branchEvents = [], archives = [], lastCheckpointId = null, capacity = null, systemPrompt = "", toolDefinitions = null } = {}) {
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.context = null;
      this.loaded = false;
      this.checkpointCache = null;
    }
    if (!this.loaded) {
      this.context = this.path ? await readActiveContext(this.path) : null;
      this.loaded = true;
    }
    this.roundFailure = null;

    const branch = await this.resolveContext(branchEvents, archives, lastCheckpointId);
    this.observe.emit("active_context_select", branch, archives.length, branchEvents.length);
    await this.publish({ branchEvents, capacity, systemPrompt, toolDefinitions });
    return this.status;
  }

  /** 选择或复用当前分支上的活动上下文；失效的持久化选择在此清除。 */
  async resolveContext(branchEvents, archives, lastCheckpointId) {
    if (activeContextOnBranch(this.context, branchEvents)) return "reused";
    const candidate = selectActiveContext(branchEvents, archives, lastCheckpointId);
    const invalidated = this.context !== null;
    this.context = candidate;
    this.checkpointCache = null;
    try {
      if (this.path) {
        if (candidate) await writeActiveContext(this.path, candidate);
        else if (invalidated) await clearActiveContext(this.path);
      }
    } catch (error) {
      this.recordFailure(error, "persist", "degrade");
    }
    return candidate ? "selected" : invalidated ? "invalidated" : "unavailable";
  }

  async publish({ branchEvents, capacity, systemPrompt, toolDefinitions }) {
    const previous = this.state;
    let candidate = null;
    let missing = "no_context";
    if (this.context) {
      try {
        candidate = await this.materialize(branchEvents, { systemPrompt, toolDefinitions });
      } catch (error) {
        this.recordFailure(error, "materialize", "degrade");
        missing = "facts_unavailable";
      }
    }

    const verdict = evaluateEligibility({
      capacity,
      takeover: this.takeover,
      payloadTokens: candidate ? candidate.tokens.payload : null,
    });
    // 没有候选时，"为什么没有"比"没有"本身更有诊断价值：区分尚未形成与来源事实不可读。
    if (!candidate && verdict.eligibility === "no_context") verdict.eligibility = missing;
    this.state = {
      checkpointId: this.context?.checkpointId ?? null,
      rawTailStartEventId: this.context?.rawTailStartEventId ?? null,
      rawTailEvents: candidate ? payloadSegment(candidate, "raw-tail").events.length : 0,
      ...verdict,
      lastFailure: this.roundFailure,
    };
    this.observe.emit(
      "active_context_eligibility", this.state.eligibility,
      this.state.capacityTokens, this.state.usableTokens, this.state.payloadTokens, this.state.headroomTokens,
    );
    if (JSON.stringify(previous) !== JSON.stringify(this.state)) {
      this.observe.emit("active_context_state", "change", previous, this.state);
    }
  }

  /** checkpoint 正文不可变：同一身份只读取一次。 */
  async loadCheckpoint() {
    const checkpointId = this.context.checkpointId;
    if (this.checkpointCache?.checkpointId === checkpointId) return this.checkpointCache.checkpoint;
    const stored = await this.adapter.readEvent(this.sessionId, checkpointEventIdFor(checkpointId));
    const checkpoint = parseCheckpointEventById(stored.event, checkpointId);
    this.checkpointCache = { checkpointId, checkpoint };
    return checkpoint;
  }

  /** dry-run：materialize 候选 payload，不改变任何产品状态。 */
  async materialize(branchEvents, { systemPrompt = "", toolDefinitions = null } = {}) {
    if (!this.context) return null;
    return materializeActiveContext({
      context: this.context,
      checkpoint: await this.loadCheckpoint(),
      branchEvents,
      systemPrompt,
      toolDefinitions,
    });
  }

  /** 活动上下文失败只影响诊断与 eligibility：事件、Archive 与 checkpoint 保持不变。 */
  recordFailure(error, errorCode, disposition) {
    // `publish` 是 state 的唯一写者：本轮失败在那里统一进入状态，两条降级路径因此产生同样的记录。
    this.roundFailure = errorMessage(error);
    this.observe.emit("active_context_failure", error, errorCode, disposition, "keep_full_context");
  }
}
