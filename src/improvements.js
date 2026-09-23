/**
 * Bounded, model-free export from Backpass proposals to PAB improvement intake.
 * The proposal's repository is the explicit correction target; never infer a target
 * from a quoted conversation or silently send user-scope files to a project.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ENDPOINT = "/api/integrations/backpass/incidents";
const EVIDENCE_POLARITIES = new Set(["negative", "positive"]);

function existingSurface(repoRoot, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\")) return null;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts[0] === ".git" || parts[0] === ".backpass") return null;
  const file = path.resolve(repoRoot, relative);
  if (!file.startsWith(repoRoot + path.sep)) return null;
  try {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return null;
    if (!fs.realpathSync(file).startsWith(repoRoot + path.sep)) return null;
  } catch {
    return null;
  }
  return relative;
}

function correctionText(edit) {
  if (edit.kind === "extract" && Array.isArray(edit.skills) && edit.skills.length) {
    const skills = edit.skills
      .filter((skill) => typeof skill?.path === "string" && typeof skill.description === "string")
      .map((skill) => `${skill.path}: ${skill.description}\n${typeof skill.body === "string" ? skill.body : ""}`);
    if (skills.length) return `Extract existing guidance into these skills:\n${skills.join("\n")}`.slice(0, 4000);
  }
  const lines = Array.isArray(edit.hunks)
    ? edit.hunks.flatMap((hunk) => (Array.isArray(hunk?.lines) ? hunk.lines : []))
    : [];
  const inserted = lines.filter((line) => line?.type === "ins" && typeof line.text === "string");
  if (inserted.length)
    return inserted
      .map((line) => line.text)
      .join("\n")
      .trim()
      .slice(0, 4000);
  const removed = lines.filter((line) => line?.type === "del" && typeof line.text === "string");
  if (removed.length) return `Remove outdated guidance:\n${removed.map((line) => line.text).join("\n")}`.slice(0, 4000);
  if (Array.isArray(edit.hunks) && edit.hunks.length) return "";
  if (typeof edit.replace === "string" && edit.replace.trim()) return edit.replace.trim().slice(0, 4000);
  return Array.isArray(edit.instructions)
    ? edit.instructions
        .filter((text) => typeof text === "string" && !/^AG-\d+(?:\.\d+)?$/i.test(text.trim()))
        .join("\n")
        .trim()
        .slice(0, 4000)
    : "";
}

export function proposalToIncidents(proposal) {
  if ((proposal?.scope && proposal.scope !== "project") || proposal?.violations?.length) return [];
  const root = proposal?.repo?.root;
  if (typeof root !== "string" || !path.isAbsolute(root)) return [];
  let repoRoot;
  try {
    repoRoot = fs.realpathSync(root);
    // User-scoped memory has no project identity and must not be sent as a
    // fictitious project. The shared-system adoption contract is separate.
    const gitRoot = fs.realpathSync(
      execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (gitRoot !== repoRoot) return [];
  } catch {
    return [];
  }
  if (!Array.isArray(proposal.edits)) return [];
  const incidents = [];
  for (const edit of proposal.edits) {
    if (!edit || typeof edit !== "object" || edit.applicable === false) continue;
    const targets =
      Array.isArray(edit.hunks) && edit.hunks.length
        ? edit.hunks.map((hunk) => hunk?.file || edit.file || proposal.memoryFile?.path)
        : [edit.file || proposal.memoryFile?.path];
    const surfaces = [...new Set(targets.map((file) => existingSurface(repoRoot, file)))];
    if (!surfaces.length || surfaces.length > 12 || surfaces.includes(null)) continue;
    const evidence = (Array.isArray(edit.evidence) ? edit.evidence : [])
      .filter(
        (e) =>
          EVIDENCE_POLARITIES.has(e?.polarity) &&
          typeof e.source === "string" &&
          e.source.trim() &&
          typeof e.text === "string" &&
          e.text.trim().length >= 8,
      )
      .slice(0, 30)
      .map((e) => ({
        source: e.source.trim().slice(0, 250),
        text: e.text.trim().slice(0, 1200),
        polarity: e.polarity,
      }));
    if (!evidence.length) continue; // Unverified suggestions are not incidents.
    const title = String(edit.title || "")
      .trim()
      .slice(0, 250);
    const problem = String(edit.rationale || "")
      .trim()
      .slice(0, 4000);
    const suggestedCorrection = correctionText(edit);
    if (title.length < 8 || problem.length < 8 || suggestedCorrection.length < 8) continue;
    const content = {
      schemaVersion: 1,
      source: "backpass",
      title,
      problem,
      target: { kind: "project", repoRoot, surfaces },
      evidence,
      suggestedCorrection,
    };
    const incidentId =
      "backpass:" + crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
    incidents.push({
      schemaVersion: 1,
      incidentId,
      source: content.source,
      title,
      problem,
      target: content.target,
      evidence,
      suggestedCorrection,
    });
  }
  return incidents;
}

function intakeUrl(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("PAB URL must be a loopback HTTP origin");
  }
  if (
    url.protocol !== "http:" ||
    !new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("PAB URL must be a loopback HTTP origin");
  }
  // Do not let a local hostname resolve to an address outside loopback.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return new URL(ENDPOINT, url);
}

export async function publishImprovements(incidents, baseUrl, { fetcher = fetch } = {}) {
  const url = intakeUrl(baseUrl);
  let sent = 0;
  const receipts = [];
  for (const incident of incidents) {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(incident),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`PAB improvement intake rejected ${incident.incidentId} (HTTP ${response.status})`);
    const receipt = await response.json();
    if (!receipt || typeof receipt !== "object" || typeof receipt.status !== "string") {
      throw new Error(`PAB improvement intake returned an invalid receipt for ${incident.incidentId}`);
    }
    receipts.push({
      incidentId: incident.incidentId,
      status: receipt.status,
      dispatch_id: receipt.dispatch_id || null,
    });
    sent += 1;
  }
  return { sent, receipts };
}
