import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue, videoDurationAllowed, videoDurationOptions } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";

test("generic duration does not invent a maximum or clamp a storyboard", () => {
    const profile = defaultModelCapabilityConfig().video!;
    expect(profile.duration.max).toBeUndefined();
    expect(videoDurationOptions(profile)).toEqual([]);
    for (const seconds of [24, 120, 4000]) {
        expect(videoDurationAllowed(profile, seconds)).toBe(true);
        expect(normalizeVideoValue(profile, { seconds: String(seconds) }).seconds).toBe(String(seconds));
        expect(() => assertVideoCapability(profile, [], [], [], String(seconds))).not.toThrow();
    }
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) expect(videoDurationAllowed(profile, invalid)).toBe(false);
});

test("channel duration bounds remain metadata, not generation admission rules", () => {
    const capabilityConfig = defaultModelCapabilityConfig();
    capabilityConfig.video!.duration = { selection: "range", min: 1, max: 40, step: 1, default: 24 };
    const config = { channels: [{ id: "custom", models: ["model"], modelCosts: [{ model: "model", capabilityConfig }] }] };
    const profile = modelCapabilityConfigFor(config, "custom::model").video!;
    expect(videoDurationAllowed(profile, 24)).toBe(true);
    expect(videoDurationAllowed(profile, 41)).toBe(false);
    expect(() => assertVideoCapability(profile, [], [], [], "41")).not.toThrow();
    profile.duration = { selection: "range", min: 1, max: 0, step: 2, default: 5 };
    expect(videoDurationAllowed(profile, 25)).toBe(true);
    expect(videoDurationAllowed(profile, 24)).toBe(false);
    expect(normalizeVideoValue(profile, { seconds: "25" }).seconds).toBe("25");
    profile.duration = { selection: "enum", values: [8, 24], default: 8 };
    expect(videoDurationAllowed(profile, 24)).toBe(true);
    expect(videoDurationAllowed(profile, 15)).toBe(false);
});
