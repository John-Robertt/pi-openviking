function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function parsePiSessionJsonl(text, { sessionId, leafId } = {}) {
  const rows = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (rows.length === 0) throw new Error("Pi session JSONL is empty");

  const values = rows.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Pi session JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
  const header = values[0];
  if (!header || header.type !== "session") throw new Error("Pi session JSONL header is missing");
  requireString(header.id, "Pi session header id");
  if (sessionId && header.id !== sessionId) throw new Error("Pi session JSONL id does not match the active session");

  const entries = values.slice(1);
  const byId = new Map();
  for (const entry of entries) {
    const id = requireString(entry?.id, "Pi entry id");
    if (byId.has(id)) throw new Error(`duplicate Pi entry id: ${id}`);
    byId.set(id, entry);
  }

  const resolvedParents = new Set();
  for (const entry of entries) {
    const lineage = new Set();
    const path = [];
    let current = entry;
    while (current && !resolvedParents.has(current.id)) {
      if (lineage.has(current.id)) throw new Error(`Pi session parent cycle at: ${current.id}`);
      lineage.add(current.id);
      path.push(current.id);
      if (current.parentId == null) {
        current = null;
      } else {
        const parentId = requireString(current.parentId, "Pi entry parentId");
        current = byId.get(parentId);
        if (!current) throw new Error(`Pi session parent does not exist: ${parentId}`);
      }
    }
    for (const id of path) resolvedParents.add(id);
  }

  const parentById = new Map(entries.map((entry) => [entry.id, entry.parentId ?? null]));
  const selectedLeafId = leafId === undefined ? (entries.at(-1)?.id ?? null) : leafId;
  if (selectedLeafId === null) return { header, entries, branch: [], parentById };
  if (!byId.has(selectedLeafId)) throw new Error(`Pi session leaf does not exist: ${selectedLeafId}`);

  const reversed = [];
  const visited = new Set();
  let currentId = selectedLeafId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Pi session parent cycle at: ${currentId}`);
    visited.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) throw new Error(`Pi session parent does not exist: ${currentId}`);
    reversed.push(entry);
    currentId = entry.parentId == null ? null : requireString(entry.parentId, "Pi entry parentId");
  }

  return {
    header,
    entries,
    branch: reversed.reverse(),
    parentById,
  };
}
