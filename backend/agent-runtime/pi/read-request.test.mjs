import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readRequest } from "./read-request.mjs";

// 每块 7 字节，必然落在 3 字节中文字符的中间。
function chunked(buffer, size) {
  const parts = [];
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size));
  return Readable.from(parts, { objectMode: false });
}

test("块边界切开中文时仍能原样解析", async () => {
  const payload = { prompt: "故事总纲与世界规则已保存。".repeat(8000), nested: { name: "山塘街·不加葱的那一碗" } };
  const buffer = Buffer.from(JSON.stringify(payload), "utf8");
  assert.ok(buffer.length > 64 * 1024);
  const parsed = await readRequest(chunked(buffer, 7));
  assert.deepEqual(parsed, payload);
  assert.ok(!JSON.stringify(parsed).includes("\uFFFD"));
});

test("空输入抛出明确错误", async () => {
  await assert.rejects(() => readRequest(Readable.from([])), /input is empty/);
});