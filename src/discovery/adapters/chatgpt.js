import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warn } from "../../logger.js";

export const name = "chatgpt";

const sourceCache = new Map();

export function discover({ cutoffMs = null, repo, config }) {
  const out = [];
  const inputs = config.discovery.chatgptExports || [];

  for (const sourcePath of exportFiles(inputs, repo.root)) {
    const loaded = loadSource(sourcePath);
    if (!loaded) continue;

    for (const conversation of loaded.conversations) {
      const id = conversationId(conversation);
      if (!id) continue;
      const updatedAt =
        timestampMs(conversation.update_time) || timestampMs(conversation.create_time) || loaded.mtimeMs;
      if (cutoffMs && updatedAt < cutoffMs) continue;

      const rawPath = selectedRawPath(config.state?.root, id, sourcePath);
      out.push({
        id,
        path: rawPath,
        title: conversation.title || null,
        startedAt: timestampMs(conversation.create_time) || updatedAt,
        mtimeMs: updatedAt,
        bytes: Buffer.byteLength(JSON.stringify(conversation), "utf8"),
        model: conversationModel(conversation),
        association: {
          tier: 0,
          confidence: "explicit",
          reason: `ChatGPT export explicitly attached to ${repo.name || "this repo"}`,
        },
        extra: { sourcePath, conversationId: id, rawPath },
      });
    }
  }

  return out;
}

export function read(ref) {
  const sourcePath = ref.extra?.sourcePath;
  const id = ref.extra?.conversationId || ref.nativeId || ref.id;
  const loaded = sourcePath && loadSource(sourcePath);
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

export function rawPath(ref) {
  return ref.extra?.rawPath || ref.path;
}

function exportFiles(inputs, repoRoot) {
  const out = [];
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
      out.push(resolved);
      continue;
    }
    if (!stat.isDirectory()) {
      warn(`chatgpt: export path is not a file or directory (${resolved}) - skipped`);
      continue;
    }
    let files;
    try {
      files = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("conversations") && entry.name.endsWith(".json"))
        .map((entry) => path.join(resolved, entry.name))
        .sort();
    } catch (err) {
      warn(`chatgpt: export directory unreadable (${resolved}: ${err.message}) - skipped`);
      continue;
    }
    if (!files.length) {
      warn(`chatgpt: no conversations*.json files found in ${resolved} - skipped`);
      continue;
    }
    out.push(...files);
  }
  return [...new Set(out)];
}

function resolveInput(input, repoRoot) {
  const expanded = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
  return path.resolve(repoRoot, expanded);
}

function loadSource(sourcePath) {
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  const cached = sourceCache.get(sourcePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.bytes === stat.size) return cached;

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

  const loaded = { conversations, mtimeMs: stat.mtimeMs, bytes: stat.size };
  sourceCache.set(sourcePath, loaded);
  return loaded;
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
