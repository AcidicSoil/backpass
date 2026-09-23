import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { proposalToIncidents, publishImprovements } from "../src/improvements.js";
import { publishIfConfigured } from "../src/commands/improvements.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-pab-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Existing guidance.\n");
  execFileSync("git", ["init", "-q", dir]);
  const proposal = {
    generatedAt: "2026-09-23T00:00:00Z",
    repo: { root: dir },
    memoryFile: { path: "AGENTS.md" },
    edits: [
      {
        id: "e1",
        file: "AGENTS.md",
        kind: "add",
        title: "Prevent shared browser profile mutation",
        rationale: "Concurrent agents reused the same browser profile while testing.",
        instructions: ["Use a dedicated PinchTab browser profile per project."],
        evidence: [
          { polarity: "negative", source: "chatgpt:one", text: "The browser profile was shared between agents." },
        ],
      },
      {
        id: "e2",
        file: "AGENTS.md",
        kind: "add",
        title: "Unsupported speculation",
        rationale: "No sourced evidence.",
        instructions: [],
        evidence: [],
      },
    ],
  };
  return { dir, proposal };
}

test("exports only evidence-backed existing correction targets with stable incident identity", () => {
  const { dir, proposal } = fixture();
  try {
    const incidents = proposalToIncidents(proposal);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].source, "backpass");
    assert.equal(incidents[0].target.repoRoot, dir);
    assert.deepEqual(incidents[0].target.surfaces, ["AGENTS.md"]);
    assert.match(incidents[0].incidentId, /^backpass:[a-f0-9]{32}$/);
    assert.deepEqual(incidents, proposalToIncidents({ ...proposal, generatedAt: "different run" }));
    assert.equal(proposalToIncidents({ ...proposal, repo: { root: "/not/real" } }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishes to a loopback PAB intake and rejects non-loopback destinations", async () => {
  const { dir, proposal } = fixture();
  const received = [];
  const server = http.createServer(async (req, res) => {
    received.push({
      path: req.url,
      body: JSON.parse(
        await new Promise((resolve) => {
          let text = "";
          req.on("data", (d) => (text += d));
          req.on("end", () => resolve(text));
        }),
      ),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "research_queued" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP server");
    const url = `http://127.0.0.1:${address.port}`;
    const result = await publishImprovements(proposalToIncidents(proposal), url);
    assert.equal(result.sent, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/api/integrations/backpass/incidents");
    assert.equal(received[0].body.incidentId, proposalToIncidents(proposal)[0].incidentId);
    await assert.rejects(publishImprovements(proposalToIncidents(proposal), "https://example.com"), /loopback/);
    assert.equal(received.length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uses measured correction text and gives revised content a new incident identity", () => {
  const { dir, proposal } = fixture();
  try {
    proposal.edits[0].instructions = ["AG-001"];
    proposal.edits[0].hunks = [
      {
        file: "AGENTS.md",
        lines: [
          { type: "ctx", text: "Existing guidance." },
          { type: "ins", text: "Use isolated PinchTab profiles." },
        ],
      },
    ];
    const original = proposalToIncidents(proposal)[0];
    assert.equal(original.suggestedCorrection, "Use isolated PinchTab profiles.");
    const revised = structuredClone(proposal);
    revised.edits[0].rationale = "A revised explanation of the same incident and its consequences.";
    assert.notEqual(proposalToIncidents(revised)[0].incidentId, original.incidentId);
    revised.edits[0].rationale = proposal.edits[0].rationale;
    revised.edits[0].hunks[0].lines[1].text = "Use separate profiles for each project.";
    assert.notEqual(proposalToIncidents(revised)[0].incidentId, original.incidentId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exports every existing safe hunk target and rejects user-scope proposals", () => {
  const { dir, proposal } = fixture();
  try {
    fs.writeFileSync(path.join(dir, "rules.md"), "Existing rules.\n");
    proposal.edits[0].hunks = [
      { file: "AGENTS.md", lines: [{ type: "ins", text: "Use isolated profiles." }] },
      { file: "rules.md", lines: [{ type: "ins", text: "Do not share browser sessions." }] },
    ];
    assert.deepEqual(proposalToIncidents(proposal)[0].target.surfaces, ["AGENTS.md", "rules.md"]);
    assert.deepEqual(proposalToIncidents({ ...proposal, scope: "user" }), []);
    proposal.edits[0].hunks.push({ file: "../escape.md", lines: [{ type: "ins", text: "Unsafe." }] });
    assert.deepEqual(proposalToIncidents(proposal), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a referenced instruction ID as a correction without measured text", () => {
  const { dir, proposal } = fixture();
  try {
    proposal.edits[0].instructions = ["AG-001"];
    assert.deepEqual(proposalToIncidents(proposal), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved-proposal CLI export leaves repository and local Git metadata unchanged", () => {
  const { dir, proposal } = fixture();
  try {
    const stateDir = path.join(dir, ".backpass");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, "proposal.json"), JSON.stringify(proposal));
    const exclude = path.join(dir, ".git", "info", "exclude");
    const beforeExclude = fs.readFileSync(exclude, "utf8");
    const beforeMemory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/backpass.js", import.meta.url)), "improvements", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, BACKPASS_PAB_URL: "" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).length, 1);
    assert.deepEqual(fs.readdirSync(stateDir), ["proposal.json"]);
    assert.equal(fs.readFileSync(exclude, "utf8"), beforeExclude);
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), beforeMemory);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed, rejected, and internal correction targets", () => {
  const { dir, proposal } = fixture();
  try {
    proposal.edits = [null, { ...proposal.edits[0], file: ".git/config" }];
    assert.deepEqual(proposalToIncidents(proposal), []);
    proposal.edits = [{ ...proposal.edits[1], file: "AGENTS.md" }];
    proposal.violations = ["proposal did not pass mechanical gates"];
    assert.deepEqual(proposalToIncidents(proposal), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizes evidence sources before applying PAB's length bound", () => {
  const { dir, proposal } = fixture();
  try {
    proposal.edits[0].evidence[0].source = `${" ".repeat(260)}chatgpt:one`;
    assert.equal(proposalToIncidents(proposal)[0].evidence[0].source, "chatgpt:one");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty JSON export with an opted-in URL remains machine-readable", () => {
  const { dir, proposal } = fixture();
  try {
    proposal.edits = [];
    fs.mkdirSync(path.join(dir, ".backpass"));
    fs.writeFileSync(path.join(dir, ".backpass", "proposal.json"), JSON.stringify(proposal));
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/backpass.js", import.meta.url)),
        "improvements",
        "--json",
        "--pab-url",
        "http://127.0.0.1:1",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, BACKPASS_PAB_URL: "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { sent: 0, receipts: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extract corrections describe the new skill and keep targets real", () => {
  const { dir, proposal } = fixture();
  try {
    Object.assign(proposal.edits[0], {
      kind: "extract",
      instructions: ["AG-001"],
      hunks: [{ file: "AGENTS.md", lines: [{ type: "del", text: "Existing guidance." }] }],
      skills: [
        {
          name: "profile-isolation",
          path: ".agents/skills/profile-isolation/SKILL.md",
          description: "Isolate concurrent browser profiles",
          body: "Use dedicated PinchTab profiles for each project.",
        },
      ],
    });
    const [incident] = proposalToIncidents(proposal);
    assert.deepEqual(incident.target.surfaces, ["AGENTS.md"]);
    assert.match(incident.suggestedCorrection, /profile-isolation/);
    assert.match(incident.suggestedCorrection, /dedicated PinchTab profiles/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("localhost publishing pins the request to an IPv4 loopback address", async () => {
  const { dir, proposal } = fixture();
  try {
    let requestedHost = "";
    let requestedPath = "";
    const result = await publishImprovements(proposalToIncidents(proposal), "http://localhost:4321", {
      fetcher: async (url) => {
        assert.ok(url instanceof URL);
        requestedHost = url.hostname;
        requestedPath = url.pathname;
        return new Response(JSON.stringify({ status: "needs_more_evidence" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(result.sent, 1);
    assert.equal(requestedHost, "127.0.0.1");
    assert.equal(requestedPath, "/api/integrations/backpass/incidents");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic PAB delivery fails soft and preserves the saved proposal", async () => {
  const { dir, proposal } = fixture();
  const saved = path.join(dir, "proposal.json");
  const original = JSON.stringify(proposal);
  fs.writeFileSync(saved, original);
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(503);
    res.end("temporarily unavailable");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.doesNotReject(
      publishIfConfigured(proposal, { flags: { "pab-url": `http://127.0.0.1:${address.port}` } }),
    );
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(saved, "utf8"), original);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
