// 先收集 Buffer 再整体解码：逐块转字符串会在块边界切开多字节字符，产生 U+FFFD。
export async function readRequest(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new Error("Agent runtime input is empty");
  return JSON.parse(raw);
}
