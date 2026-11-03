import assert from "node:assert/strict";
import test from "node:test";
import { collapseSystemMessages } from "./session-compaction.mjs";

const line = (entry) => JSON.stringify(entry);
const system = (id, parentId, message) => line({ type: "message", id, parentId, message: { role: "system", ...message } });
const user = (id, parentId, text) => line({ type: "message", id, parentId, message: { role: "user", content: text } });
const parse = (jsonl) => jsonl.split("\n").filter(Boolean).map((raw) => JSON.parse(raw));

test("多条 system 消息按回放语义合并为一条", () => {
  const jsonl = [
    line({ type: "session", id: "s0" }),
    system("a", null, { sections: { preamble: "v1", rules: "r1" }, toolsAdded: ["read", "write"] }),
    user("b", "a", "你好"),
    system("c", "b", { sections: { preamble: "v2", rules: null }, toolsAdded: ["bash"], toolsRemoved: ["write"] }),
    system("d", "c", { sections: { extra: "e" }, toolsAdded: ["write"] }),
  ].join("\n");
  const entries = parse(collapseSystemMessages(jsonl));
  const systems = entries.filter((e) => e.message?.role === "system");
  assert.equal(systems.length, 1);
  assert.equal(systems[0].id, "a");
  assert.deepEqual(systems[0].message.sections, { preamble: "v2", extra: "e" });
  assert.deepEqual(systems[0].message.toolsAdded.map(String).sort(), ["bash", "read", "write"]);
  assert.equal(systems[0].message.toolsRemoved, undefined);
});

test("被删条目的 parentId 重连到存活条目", () => {
  const jsonl = [
    system("a", null, { sections: { p: "1" } }),
    system("b", "a", { sections: { p: "2" } }),
    user("c", "b", "正文"),
    system("d", "c", { sections: { p: "3" } }),
    user("e", "d", "继续"),
  ].join("\n");
  const entries = parse(collapseSystemMessages(jsonl));
  assert.deepEqual(entries.map((e) => e.id), ["a", "c", "e"]);
  assert.equal(entries[1].parentId, "a");
  assert.equal(entries[2].parentId, "c");
  assert.equal(entries[0].message.sections.p, "3");
});

test("compaction 的 firstKeptEntryId 指向被删条目时改指向其后第一个存活条目", () => {
  const jsonl = [
    system("a", null, { sections: { p: "1" } }),
    system("b", "a", { sections: { p: "2" } }),
    user("c", "b", "正文"),
    line({ type: "compaction", id: "k", parentId: "c", firstKeptEntryId: "b", systemMessage: "摘要" }),
  ].join("\n");
  const entries = parse(collapseSystemMessages(jsonl));
  const compaction = entries.find((e) => e.type === "compaction");
  assert.equal(compaction.firstKeptEntryId, "c");
});

test("不同 compaction 分段之间不合并", () => {
  const jsonl = [
    system("a", null, { sections: { p: "1" } }),
    system("b", "a", { sections: { p: "2" } }),
    line({ type: "compaction", id: "k", parentId: "b", firstKeptEntryId: "b", systemMessage: "摘要" }),
    system("c", "k", { sections: { p: "3" } }),
    system("d", "c", { sections: { p: "4" } }),
  ].join("\n");
  const entries = parse(collapseSystemMessages(jsonl));
  const systems = entries.filter((e) => e.message?.role === "system");
  assert.deepEqual(systems.map((e) => e.id), ["a", "c"]);
  assert.equal(systems[0].message.sections.p, "2");
  assert.equal(systems[1].message.sections.p, "4");
  assert.equal(entries.find((e) => e.type === "compaction").firstKeptEntryId, "k");
});

test("坏行与 user、assistant 正文保持不变", () => {
  const bad = "{不是 JSON";
  const assistant = line({ type: "message", id: "x", parentId: "b", message: { role: "assistant", content: "故事总纲与世界规则已保存。" } });
  const jsonl = [system("a", null, { sections: { p: "1" } }), bad, system("b", "a", { sections: { p: "2" } }), assistant].join("\n");
  const lines = collapseSystemMessages(jsonl).split("\n");
  assert.ok(lines.includes(bad));
  assert.ok(lines.includes(assistant.replace('"parentId":"b"', '"parentId":"a"')) || lines.some((raw) => raw.includes("故事总纲与世界规则已保存。")));
  assert.equal(lines.filter((raw) => raw.includes('"role":"system"')).length, 1);
});

test("没有可合并内容时返回同一个字符串", () => {
  const jsonl = [system("a", null, { sections: { p: "1" } }), user("b", "a", "你好")].join("\n");
  assert.equal(collapseSystemMessages(jsonl), jsonl);
  assert.equal(collapseSystemMessages(""), "");
});

test("上千条仅差一个字符的 preamble 补丁合并后体积收敛", () => {
  const big = "序".repeat(40000);
  const rows = [];
  let parent = null;
  for (let i = 0; i < 200; i++) {
    rows.push(system(`s${i}`, parent, { sections: { preamble: `${big}${i % 2 ? "\uFFFD" : "\uFFFD\uFFFD"}` } }));
    parent = `s${i}`;
  }
  const jsonl = rows.join("\n");
  const collapsed = collapseSystemMessages(jsonl);
  assert.ok(Buffer.byteLength(collapsed) < Buffer.byteLength(jsonl) / 100);
  assert.equal(parse(collapsed).length, 1);
});
