/**
 * CueSet：docs/design.md「模块协作契约」的四个数据值之一，由 Cue Provider 产生，
 * Pi Adapter 保存与投影，下一次生成读取。Pi session tree 以 custom entry 持有它。
 */
export interface CueSet {
  /** 简短线索：每条只含事件时间或区间、识别事件的短句，以及找到完整事实所需的信息。 */
  cues: string[];
  /** 本次生成已经用到的最后一条 Pi entry；下一次生成从它之后继续。 */
  lastUsedEntryId: string;
}

/** Pi Adapter 保存 CueSet 的 custom entry 类型标识；该 entry 不属于来源事实。 */
export const CUES_CUSTOM_TYPE = "pi-openviking.cues";

/**
 * CueSet 面向 provider context 的呈现方式（design.md「接口稳定性」：呈现变化只改这里）。
 * 线索之外必须说明两件事：覆盖到哪个时间为止；这是重要事件的采样而非完整清单。
 * 缺了这两句，一份受预算约束的清单会被读成"历史上只发生过这些"。
 */
export function formatCueContext(cueSet: CueSet, coveredAt: string | undefined): string {
  const coverage = coveredAt ?? "unknown";
  return [
    `Memory cues — a sampled list of notable past events (not complete), covering up to ${coverage}.`,
    "Use the search/read tools to retrieve the full facts behind any cue.",
    ...cueSet.cues.map((cue) => `- ${cue}`),
  ].join("\n");
}
