import { describe, expect, test } from "bun:test";

import { ApiError } from "@/services/api/request";
import { formatCanvasSaveWarning, formatLocalSavedRemotePending } from "@/services/user-data-sync";

describe("本地已保存、云端同步失败的文案", () => {
    test("带上原始错误并声明会自动重试", () => {
        expect(formatLocalSavedRemotePending("素材已在本地保存", new Error("网络中断"))).toBe("素材已在本地保存，云端同步失败：网络中断。将自动重试。");
    });

    test("没有 Error.message 时使用未知错误", () => {
        expect(formatLocalSavedRemotePending("已在本地还原", "x")).toBe("已在本地还原，云端同步失败：未知错误。将自动重试。");
    });
});

describe("画布保存失败提示", () => {
    test("409 提示云端有更新并自动合并", () => {
        expect(formatCanvasSaveWarning(new ApiError("版本冲突", { status: 409 }))).toBe("本地画布布局已保存，云端有更新，正在自动合并后重试");
    });

    test("428 与 409 同样处理", () => {
        expect(formatCanvasSaveWarning(new ApiError("需要版本", { status: 428 }))).toBe("本地画布布局已保存，云端有更新，正在自动合并后重试");
    });

    test("历史素材缺失的 409 仍按同步失败展示", () => {
        const error = new ApiError("历史素材缺失", { status: 409, reason: "canvas_history_resources_missing" });
        expect(formatCanvasSaveWarning(error)).toBe("本地画布布局已保存，云端同步失败：历史素材缺失");
    });

    test("普通 Error 带上原始信息", () => {
        expect(formatCanvasSaveWarning(new Error("网络中断"))).toBe("本地画布布局已保存，云端同步失败：网络中断");
    });

    test("非 Error 值显示未知错误", () => {
        expect(formatCanvasSaveWarning("x")).toBe("本地画布布局已保存，云端同步失败：未知错误");
    });
});