import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PiTaskModelContextFacts {
  capacity: { contextWindow: number; maxTokens: number } | null;
  factsAvailable: boolean;
  systemPrompt: string;
  toolDefinitions: string;
}

export function readTaskModelContext(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: any,
  onError?: (error: unknown) => void,
): PiTaskModelContextFacts;
