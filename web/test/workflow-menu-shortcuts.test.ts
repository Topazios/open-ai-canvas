import { expect, test } from "bun:test";
import { activeShortDramaSteps, nextShortDramaSteps, ShortDramaStep as S } from "../src/lib/short-drama-steps";

const next = (step: S) => nextShortDramaSteps(step).map((entry) => entry.id);

test("story menus follow the immediate production path instead of all references", () => {
    expect(next(S.Topic)).toEqual([S.Plan]);
    expect(next(S.Plan)).toEqual([S.Episodes]);
    expect(next(S.Episodes)).toEqual([S.Body]);
    expect(next(S.Body)).toEqual([S.Audit, S.Shots]);
    expect(next(S.Shots)).toEqual([S.Boards, S.StartFrame, S.EndFrame, S.Keyframes, S.Previsualization]);
    expect(next(S.Verify)).toEqual([S.Promotion]);
});

test("shared norms and asset aggregates do not offer unrelated downstream work", () => {
    expect(next(S.Bible)).toEqual([]);
    expect(next(S.Reconcile)).toEqual([]);
    expect(next(S.Characters)).toEqual([S.CharacterReferences]);
    expect(next(S.Environments)).toEqual([S.EnvironmentReferences]);
    expect(next(S.Props)).toEqual([S.PropReferences]);
    expect(activeShortDramaSteps.some(step => [S.Dialogue, S.Casting, S.Recording, S.Timing].includes(step.id))).toBe(false);
});

test("optional image steps and parallel edit outputs retain their direct continuation", () => {
    expect(next(S.Scenes)).toEqual([S.Shots]);
    expect(next(S.Boards)).toEqual([S.StartFrame, S.Previsualization]);
    expect(next(S.StartFrame)).toEqual([S.EndFrame, S.Keyframes, S.Previsualization]);
    expect(next(S.EndFrame)).toEqual([S.Keyframes, S.Previsualization]);
    expect(next(S.Keyframes)).toEqual([S.Previsualization]);
    expect(next(S.Rough)).toEqual([S.Picture, S.Sound]);
    expect(next(S.Picture)).toEqual([S.Subtitles]);
    expect(next(S.Sound)).toEqual([S.Subtitles]);
});

test("every current step remains reachable without turning reference inputs into shortcuts", () => {
    const reached = new Set<string>();
    const visit = (step: S) => {
        if (reached.has(step)) return;
        reached.add(step);
        for (const child of nextShortDramaSteps(step)) visit(child.id as S);
    };
    // Asset reference commands are offered on the corresponding asset nodes.
    for (const root of [S.Topic, S.Characters, S.Environments, S.Props]) visit(root);
    for (const step of activeShortDramaSteps) expect(reached.has(step.id)).toBe(true);
});
