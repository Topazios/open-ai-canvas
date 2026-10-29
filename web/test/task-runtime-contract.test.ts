import { describe, expect, test } from "bun:test";

import { deepFreeze, stableStringify, TaskIntentValidationError, assertValidTaskIntent, validateSubmitTaskRequest, validateTaskIntent } from "../src/lib/task-runtime/validation";
import { TASK_RUNTIME_MIGRATION_INVENTORY } from "../src/lib/task-runtime/migration-inventory";
import { forbiddenFieldRequests, invalidIntents, validImageEditIntent, validImageGenerationIntent } from "./fixtures/task-runtime/intents";

describe("任务运行时合同校验", () => {
    test("有效的生成和编辑意图通过校验", () => {
        expect(validateTaskIntent(validImageGenerationIntent)).toEqual({ ok: true });
        expect(validateTaskIntent(validImageEditIntent)).toEqual({ ok: true });
        expect(validateSubmitTaskRequest({ idempotencyKey: "k-ok", intent: validImageEditIntent })).toEqual({ ok: true });
    });

    for (const fixture of invalidIntents) {
        test(`无效意图返回字段路径：${fixture.name}`, () => {
            const result = validateTaskIntent(fixture.intent);
            expect(result.ok).toBe(false);
            const paths = result.ok ? [] : result.issues.map((issue) => issue.path);
            for (const path of fixture.paths) expect(paths).toContain(path);
        });
    }

    for (const fixture of forbiddenFieldRequests) {
        test(`递归拒绝服务端字段：${fixture.name}`, () => {
            const result = validateSubmitTaskRequest(fixture.request);
            expect(result.ok).toBe(false);
            const paths = result.ok ? [] : result.issues.map((issue) => issue.path);
            expect(paths).toContain(fixture.path);
            // 同一字段只报一次，避免顶层和 intent 内重复检查。
            expect(paths.filter((path) => path === fixture.path)).toHaveLength(1);
        });
    }

    test("缺少幂等键被拒绝", () => {
        const result = validateSubmitTaskRequest({ idempotencyKey: " ", intent: validImageGenerationIntent });
        expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toContain("idempotencyKey");
    });

    test("assertValidTaskIntent 抛出带问题列表的错误", () => {
        expect(() => assertValidTaskIntent({ ...validImageGenerationIntent, schemaVersion: 2 })).toThrow(TaskIntentValidationError);
    });

    test("stableStringify 与 key 顺序无关并忽略 undefined", () => {
        expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(stableStringify({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
    });

    test("deepFreeze 冻结嵌套对象", () => {
        const value = deepFreeze({ nested: { list: [{ id: 1 }] } });
        expect(Object.isFrozen(value.nested.list[0])).toBe(true);
    });

    test("迁移清单唯一且只有画布单图处于影子阶段", () => {
        const ids = TASK_RUNTIME_MIGRATION_INVENTORY.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(TASK_RUNTIME_MIGRATION_INVENTORY.filter((entry) => entry.stage !== "legacy").map((entry) => entry.id)).toEqual(["canvas-image-single"]);
    });
});