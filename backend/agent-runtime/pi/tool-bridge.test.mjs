import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function runFixture(parameters, calls, rejectFirst = false, toolName = "production_submit") {
  const root = await mkdtemp(join(tmpdir(), "tool-bridge-fixture-"));
  const observed = { models: 0, tools: [], snapshots: [] };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/model") {
      const call = calls[observed.models++];
      response.end(JSON.stringify({ text: call ? "" : "complete", toolCalls: call ? [{ id: `call-${observed.models}`, name: toolName, arguments: call }] : [] }));
    } else if (request.url === "/tool") {
      observed.tools.push(body);
      response.end(JSON.stringify(rejectFirst && observed.tools.length === 1
        ? { content: '{"error":"missing required story fields"}', isError: true }
        : { content: '{"saved":true}' }));
    } else if (request.url === "/event") {
      if (body.sessionJSONL) observed.snapshots.push({ models: observed.models, value: body.sessionJSONL });
      response.end("{}");
    } else {
      response.writeHead(400).end('{"error":"unexpected endpoint"}');
    }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "agent-runtime.mjs")], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 20000);
  try {
    const completed = new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    child.stdin.end(JSON.stringify({
      bridgeURL: `http://127.0.0.1:${server.address().port}`, bridgeToken: "fixture-only",
      cwd: root, agentDir: root, sessionDir: root, prompt: "Fixture", systemPrompt: "Fixture",
      tools: [{ name: toolName, parameters }],
      model: { id: "fixture", contextWindow: 128000, maxTokens: 8192 },
    }));
    const code = await completed;
    return { ...observed, code, output };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await new Promise((accept) => server.close(accept));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
}

test("production documents pass the real Pi execution bridge across template changes", { timeout: 30000 }, async () => {
  const calls = [
    { key: "story", document: { premise: "story ".repeat(1000), arcs: "acts", ending: "ending" } },
    { key: "character", document: { voiceTimbre: "voice", voiceAccent: "accent", personality: "personality" } },
  ];
  const result = await runFixture({ type: "object", additionalProperties: true }, calls);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.tools.map((call) => call.arguments), calls);
  assert.equal(result.models, 3);
  assert.ok(result.snapshots.some((item) => item.models < 3 && item.value.includes("toolResult")), "checkpoint must be saved before the run finishes");
});

test("local schema rejection stops instead of silently generating another model call", { timeout: 30000 }, async () => {
  const result = await runFixture({ type: "object", additionalProperties: false, properties: {} }, [{ document: { premise: "private draft" } }]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.models, 1);
  assert.equal(result.tools.length, 0);
  assert.match(result.output, /Agent tool validation failed/);
  assert.doesNotMatch(result.output, /private draft|Received arguments/);
});

test("business validation reaches the bridge and allows a corrected document", { timeout: 30000 }, async () => {
  const result = await runFixture({ type: "object", additionalProperties: true }, [{ document: {} }, { document: { premise: "corrected" } }], true);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.models, 3);
  assert.equal(result.tools.length, 2);
});

test("ordinary Agent tools retain local schema validation and correction", { timeout: 30000 }, async () => {
  const result = await runFixture({ type: "object", additionalProperties: false, properties: {} }, [{ invalid: true }, {}], false, "canvas_fixture");
  assert.equal(result.code, 0, result.output);
  assert.equal(result.models, 3);
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.tools[0].arguments, {});
});
