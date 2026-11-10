// Run after `bun run build`: exercise the emitted browser Worker without a DOM.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { Worker } from "node:worker_threads";

const assets = new URL("../dist/assets/", import.meta.url);
const entries = (await readdir(assets)).filter((name) => /^virtual-document\.worker-.*\.js$/.test(name));
assert.equal(entries.length, 1, "Build the frontend before checking the document Worker");
const source = "# 长文稿预览\n\n" + "人物把相机放回桌上，确认照片和信封仍在原处，然后推门走进走廊。\n\n".repeat(6000) + "| 名称 | 说明 |\n| --- | --- |\n| 实体字符 | &amp; &euro; |\n\n文稿结尾。";
assert.ok(source.length > 190000);
const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    globalThis.postMessage = value => parentPort.postMessage(value);
    import(workerData.url).then(() => {
        parentPort.on("message", data => globalThis.onmessage({ data }));
        parentPort.postMessage({ ready: true });
    }).catch(error => { throw error; });
`,
    { eval: true, workerData: { url: new URL(entries[0], assets).href } },
);
try {
    const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Document Worker did not return a result")), 30000);
        worker.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        worker.on("message", (value) => {
            if (value.ready) return worker.postMessage(source);
            clearTimeout(timeout);
            resolve(value);
        });
    });
    assert.equal(result.error, undefined);
    assert.ok(result.blocks.length > 6000);
    assert.equal(result.blocks.at(-1).text, "文稿结尾。");
    assert.deepEqual(result.blocks.find((block) => block.cells?.[0] === "实体字符").cells, ["实体字符", "& €"]);
    console.log(`Document Worker passed: ${source.length} characters, ${result.blocks.length} blocks, no DOM`);
} finally {
    await worker.terminate();
}
