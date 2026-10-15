import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Pi forwards default/selected effort and overrides restored session settings", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-fixture-"));
  const observed = [];
  let snapshot = "";
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/model") {
      observed.push(body.thinkingLevel);
      response.end(JSON.stringify({ text: "fixture complete", toolCalls: [], usage: { input: 4, output: 2 } }));
    } else if (request.url === "/event") {
      if (body.sessionJSONL) snapshot = body.sessionJSONL;
      response.end("{}");
    } else {
      response.writeHead(400);
      response.end('{"error":"unexpected fixture request"}');
    }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  try {
    for (const [reasoning, effort, expected] of [[true, undefined, "medium"], [true, "high", "high"], [true, "low", "low"], [false, undefined, "off"]]) {
      const input = {
        bridgeURL: `http://127.0.0.1:${server.address().port}`, bridgeToken: "fixture-only",
        cwd: root, agentDir: root, sessionDir: root, sessionFile: join(root, "restore.jsonl"), sessionJSONL: snapshot || undefined,
        prompt: "Reply once", systemPrompt: "Fixture test", tools: [],
        model: { id: "fixture", reasoning, reasoningEffort: effort, contextWindow: 128000, maxTokens: 8192 },
      };
      const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "agent-runtime.mjs")], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timeout = setTimeout(() => child.kill(), 12000);
      try {
        const completed = new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
        child.stdin.end(JSON.stringify(input));
        assert.equal(await completed, 0, output);
        assert.equal(observed.at(-1), expected, output);
        assert.ok(snapshot, "missing persisted session");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
      }
    }
    assert.deepEqual(observed, ["medium", "high", "low", "off"]);
  } finally {
    await new Promise((accept) => server.close(accept));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
