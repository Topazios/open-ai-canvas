// 会话文件里的 system 消息由 Pi SDK 追加：提示词变化时追加一条补丁（按名称覆盖 sections，
// 并列出 toolsAdded/toolsRemoved）。提示词文本一旦被损坏（例如多字节字符被切断成 U+FFFD），
// 每次恢复都会判定“提示词变了”并再追加一整份，会话会无限膨胀。
// 这里把两次压缩检查点之间的连续补丁按回放语义合并成一条，其余消息原样保留。

function toolName(tool) {
  if (typeof tool === "string") return tool;
  if (tool && typeof tool.name === "string") return tool.name;
  return JSON.stringify(tool);
}

function isSystemMessage(entry) {
  return entry?.type === "message" && entry.message?.role === "system";
}

function parseLine(line) {
  if (!line.trim()) return {};
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" ? { entry } : {};
  } catch {
    return {};
  }
}

function mergeSegment(messages) {
  const sections = {};
  const added = new Map();
  const removed = new Map();
  for (const message of messages) {
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[name];
      else sections[name] = value;
    }
    for (const tool of message.toolsAdded ?? []) {
      const key = toolName(tool);
      added.set(key, tool);
      removed.delete(key);
    }
    for (const tool of message.toolsRemoved ?? []) {
      const key = toolName(tool);
      added.delete(key);
      removed.set(key, tool);
    }
  }
  const last = messages[messages.length - 1];
  const merged = { ...last, sections, toolsAdded: [...added.values()] };
  if (removed.size > 0) merged.toolsRemoved = [...removed.values()];
  else delete merged.toolsRemoved;
  if (Object.keys(sections).length === 0) delete merged.sections;
  return merged;
}

/**
 * 合并会话 JSONL 中重复的 system 消息，返回新文本。
 * 没有可合并内容时原样返回同一个字符串。无法解析的行、user/assistant 正文均不改动。
 */
export function collapseSystemMessages(jsonl) {
  if (typeof jsonl !== "string" || jsonl === "") return jsonl;
  const items = jsonl.split("\n").map((raw) => ({ raw, ...parseLine(raw) }));

  const segments = [];
  let current = null;
  items.forEach((item, index) => {
    if (item.entry?.type === "compaction") {
      current = null;
    } else if (isSystemMessage(item.entry)) {
      if (!current) {
        current = { first: index, indexes: [] };
        segments.push(current);
      }
      current.indexes.push(index);
    }
  });
  if (!segments.some((segment) => segment.indexes.length > 1)) return jsonl;

  const removedIndexes = new Set();
  const parentOfRemoved = new Map();
  for (const segment of segments) {
    if (segment.indexes.length < 2) continue;
    const messages = segment.indexes.map((index) => items[index].entry.message);
    items[segment.first].entry.message = mergeSegment(messages);
    items[segment.first].dirty = true;
    for (const index of segment.indexes.slice(1)) {
      removedIndexes.add(index);
      const entry = items[index].entry;
      if (entry.id !== undefined) parentOfRemoved.set(entry.id, entry.parentId ?? null);
    }
  }

  const resolveParent = (id) => {
    let guard = 0;
    while (id !== null && id !== undefined && parentOfRemoved.has(id) && guard++ < items.length) id = parentOfRemoved.get(id);
    return id ?? null;
  };
  const nextSurvivorID = (id) => {
    const start = items.findIndex((item) => item.entry?.id === id);
    for (let i = start + 1; i < items.length; i++) {
      if (!removedIndexes.has(i) && items[i].entry?.id !== undefined) return items[i].entry.id;
    }
    return id;
  };

  items.forEach((item, index) => {
    const entry = item.entry;
    if (!entry || removedIndexes.has(index)) return;
    if (entry.parentId !== undefined && parentOfRemoved.has(entry.parentId)) {
      entry.parentId = resolveParent(entry.parentId);
      item.dirty = true;
    }
    if (entry.type === "compaction" && parentOfRemoved.has(entry.firstKeptEntryId)) {
      entry.firstKeptEntryId = nextSurvivorID(entry.firstKeptEntryId);
      item.dirty = true;
    }
  });

  return items
    .filter((_, index) => !removedIndexes.has(index))
    .map((item) => (item.dirty ? JSON.stringify(item.entry) : item.raw))
    .join("\n");
}
