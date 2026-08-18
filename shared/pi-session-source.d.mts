export interface PiSessionSourceResult {
  header: Record<string, unknown>;
  entries: Record<string, any>[];
  branch: Record<string, any>[];
  parentById: Map<string, string | null>;
}

export function parsePiSessionJsonl(
  text: string,
  options?: { sessionId?: string; leafId?: string | null },
): PiSessionSourceResult;
