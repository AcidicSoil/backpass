import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warn } from "../../logger.js";

export const name = "chatgpt";

const sourceCache = new Map();
const NEXUS_HEAD_BYTES = 8 * 1024;

export function discover({ cutoffMs = null, repo, config }) {
  const byId = new Map();
  const inputs = config.discovery.chatgptExports || [];

  for (const candidate of exportFiles(inputs, repo.root)) {
    const loaded = loadSource(candidate.path, { warnUnrecognized: candidate.explicit });
    if (!loaded) continue;

    for (const conversation of loaded.conversations) {
      const id = conversationId(conversation);
      if (!id) continue;
      const updatedAt =
        timestampMs(conversation.update_time) || timestampMs(conversation.create_time) || loaded.mtimeMs;
      const rawPath =
        loaded.format === "nexus-markdown" ? candidate.path : selectedRawPath(config.state?.root, id, candidate.path);
      const row = {
        id,
        path: rawPath,
        title: conversation.title || null,
        startedAt: timestampMs(conversation.create_time) || updatedAt,
        mtimeMs: updatedAt,
        bytes:
          loaded.format === "nexus-markdown" ? loaded.bytes : Buffer.byteLength(JSON.stringify(conversation), "utf8"),
        model: conversationModel(conversation),
        association: {
          tier: 0,
          confidence: "explicit",
          reason: `ChatGPT export explicitly attached to ${repo.name || "this repo"}`,
        },
        extra: {
          sourcePath: candidate.path,
          sourceFormat: loaded.format,
          conversationId: id,
          rawPath,
        },
      };
      const current = byId.get(id);
      if (!current || preferConversation(row, current)) byId.set(id, row);
    }
  }

  return [...byId.values()].filter((row) => !cutoffMs || row.mtimeMs >= cutoffMs);
}

export function read(ref) {
  if (ref.extra?.sourceFormat === "nexus-markdown") return readNexusConversation(ref);
  return readJsonConversation(ref);
}

export function rawPath(ref) {
  return ref.extra?.rawPath || ref.path;
}

function readJsonConversation(ref) {
  const sourcePath = ref.extra?.sourcePath;
  const id = ref.extra?.conversationId || ref.nativeId || ref.id;
  const loaded = sourcePath && loadSource(sourcePath, { warnUnrecognized: true });
  const conversation = loaded?.conversations.find((item) => conversationId(item) === id);
  if (!conversation) {
    throw new Error(`ChatGPT conversation ${id} no longer exists in ${sourcePath || "the configured export"}`);
  }

  const nodes = activeNodes(conversation);
  const events = [];
  for (const node of nodes) {
    const message = node?.message;
    const role = message?.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (text) events.push({ kind: "message", role, text });
  }

  const outputPath = rawPath(ref);
  if (outputPath && outputPath !== sourcePath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(selectedConversation(conversation, nodes), null, 2)}\n`);
  }

  return { events, model: conversationModel(conversation, nodes) };
}

function readNexusConversation(ref) {
  const sourcePath = ref.extra?.sourcePath || ref.path;
  const id = ref.extra?.conversationId || ref.nativeId || ref.id;
  const loaded = loadNexusSource(sourcePath, { warnUnrecognized: true });
  const conversation = loaded?.conversations[0];
  if (!conversation || conversationId(conversation) !== id) {
    throw new Error(`ChatGPT conversation ${id} no longer exists in ${sourcePath || "the configured export"}`);
  }

  const text = fs.readFileSync(sourcePath, "utf8");
  const parsed = nexusEvents(text);
  return { events: parsed.events, model: parsed.model || conversationModel(conversation) };
}

function exportFiles(inputs, repoRoot) {
  const found = new Map();
  for (const input of inputs) {
    const resolved = resolveInput(input, repoRoot);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      warn(`chatgpt: export path not found (${resolved}) - skipped`);
      continue;
    }
    if (stat.isFile()) {
      found.set(resolved, { path: resolved, explicit: true });
      continue;
    }
    if (!stat.isDirectory()) {
      warn(`chatgpt: export path is not a file or directory (${resolved}) - skipped`);
      continue;
    }

    const files = walkExportDirectory(resolved);
    if (!files.length) {
      warn(`chatgpt: no conversations*.json or Markdown files found in ${resolved} - skipped`);
      continue;
    }
    for (const file of files) {
      if (!found.has(file)) found.set(file, { path: file, explicit: false });
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function walkExportDirectory(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warn(`chatgpt: export directory unreadable (${dir}: ${err.message}) - skipped`);
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".md") || (lower.startsWith("conversations") && lower.endsWith(".json"))) {
        files.push(file);
      }
    }
  }
  return files.sort();
}

function resolveInput(input, repoRoot) {
  const expanded = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
  return path.resolve(repoRoot, expanded);
}

function loadSource(sourcePath, options = {}) {
  if (sourcePath.toLowerCase().endsWith(".md")) return loadNexusSource(sourcePath, options);
  return loadJsonSource(sourcePath);
}

function loadJsonSource(sourcePath) {
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  const cached = sourceCache.get(sourcePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.bytes === stat.size && cached.format === "openai-json") {
    return cached;
  }

  let value;
  try {
    value = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (err) {
    warn(`chatgpt: export is not valid JSON (${sourcePath}: ${err.message}) - skipped`);
    return null;
  }
  const conversations = Array.isArray(value)
    ? value
    : Array.isArray(value?.conversations)
      ? value.conversations
      : value?.mapping
        ? [value]
        : null;
  if (!conversations) {
    warn(`chatgpt: unrecognized conversation export shape (${sourcePath}) - skipped`);
    return null;
  }

  const loaded = { format: "openai-json", conversations, mtimeMs: stat.mtimeMs, bytes: stat.size };
  sourceCache.set(sourcePath, loaded);
  return loaded;
}

function loadNexusSource(sourcePath, { warnUnrecognized = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  let head;
  try {
    head = readHead(sourcePath, NEXUS_HEAD_BYTES);
  } catch (err) {
    if (warnUnrecognized) warn(`chatgpt: export unreadable (${sourcePath}: ${err.message}) - skipped`);
    return null;
  }
  const conversation = nexusConversationHeader(head);
  if (!conversation) {
    if (warnUnrecognized) warn(`chatgpt: unrecognized Nexus ChatGPT Markdown export (${sourcePath}) - skipped`);
    return null;
  }

  const loaded = {
    format: "nexus-markdown",
    conversations: [conversation],
    mtimeMs: stat.mtimeMs,
    bytes: stat.size,
  };
  return loaded;
}

function readHead(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function nexusConversationHeader(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const frontmatter = match[1];
  if (frontmatterValue(frontmatter, "nexus") !== "nexus-ai-chat-importer") return null;
  if (frontmatterValue(frontmatter, "provider") !== "chatgpt") return null;
  const id = frontmatterValue(frontmatter, "conversation_id");
  if (!id) return null;

  const titleMatch = text.slice(match[0].length).match(/^# Title:\s*(.+?)\s*$/m);
  const models = frontmatterList(frontmatter, "models");
  return {
    id,
    conversation_id: id,
    title: frontmatterValue(frontmatter, "aliases") || titleMatch?.[1]?.trim() || null,
    create_time: frontmatterValue(frontmatter, "create_time"),
    update_time: frontmatterValue(frontmatter, "update_time"),
    default_model_slug: models.at(-1) || null,
  };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "m"));
  if (!match) return null;
  return parseYamlScalar(match[1]);
}

function frontmatterList(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}:\\s*$`).test(line));
  if (start < 0) return [];
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s+-\s+(.+?)\s*$/);
    if (!match) break;
    const value = parseYamlScalar(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function parseYamlScalar(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function nexusEvents(text) {
  const lines = text.split(/\r?\n/);
  const events = [];
  let model = null;
  let i = 0;
  while (i < lines.length) {
    const marker = lines[i].match(
      /^>\s?\[!nexus_(user|agent)\]\s+\*\*(?:User|Assistant)(?:\s+·\s+([^*]+?))?\*\*(?:\s+-.*)?$/,
    );
    if (!marker) {
      i += 1;
      continue;
    }

    const role = marker[1] === "user" ? "user" : "assistant";
    if (role === "assistant" && marker[2]?.trim()) model = marker[2].trim();
    const body = [];
    i += 1;
    while (i < lines.length && lines[i].startsWith(">")) {
      if (/^>\s?\[!nexus_(?:user|agent)\]/.test(lines[i])) break;
      body.push(lines[i].replace(/^>\s?/, ""));
      i += 1;
    }
    const message = trimBlankLines(body).join("\n");
    if (message) events.push({ kind: "message", role, text: message });
  }
  return { events, model };
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function preferConversation(next, current) {
  if (next.mtimeMs !== current.mtimeMs) return next.mtimeMs > current.mtimeMs;
  if (next.bytes !== current.bytes) return next.bytes > current.bytes;
  const nextPath = next.extra?.sourcePath || "";
  const currentPath = current.extra?.sourcePath || "";
  if (nextPath.length !== currentPath.length) return nextPath.length < currentPath.length;
  return nextPath.localeCompare(currentPath) < 0;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conversationId(conversation) {
  const id = conversation?.id ?? conversation?.conversation_id;
  return typeof id === "string" && id ? id : null;
}

function activeNodes(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return [];

  const chain = [];
  const seen = new Set();
  let id = conversation.current_node;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    chain.push(node);
    id = node.parent;
  }
  if (chain.length) return chain.reverse();

  return Object.values(mapping)
    .filter((node) => node?.message)
    .sort((a, b) => timestampMs(a.message?.create_time) - timestampMs(b.message?.create_time));
}

function messageText(message) {
  const content = message?.content;
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (typeof content.text === "string") return content.text.trim();
  if (!Array.isArray(content.parts)) return "";

  return content.parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function conversationModel(conversation, nodes = activeNodes(conversation)) {
  for (const node of [...nodes].reverse()) {
    const message = node?.message;
    if (message?.author?.role !== "assistant") continue;
    const model = message.metadata?.model_slug || message.metadata?.model;
    if (typeof model === "string" && model) return model;
  }
  return typeof conversation?.default_model_slug === "string" ? conversation.default_model_slug : null;
}

function selectedConversation(conversation, nodes) {
  const mapping = {};
  for (const node of nodes) {
    if (node?.id) mapping[node.id] = node;
  }
  return {
    id: conversationId(conversation),
    title: conversation.title || null,
    create_time: conversation.create_time ?? null,
    update_time: conversation.update_time ?? null,
    current_node: conversation.current_node ?? null,
    mapping,
  };
}

function selectedRawPath(stateRoot, id, sourcePath) {
  if (!stateRoot) return sourcePath;
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(stateRoot, "imported-transcripts", "chatgpt", `${safeId}.json`);
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
