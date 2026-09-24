import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAfterCritique, decideAfterRender } from "../src/v2/policies/critique-verdict.js";

// Offline check 3: each policy returns the expected decision for a table of cases.

const faith = (pass, deltaE = pass ? 2 : 30) => ({ pass, deltaE, threshold: 15 });

test("render-check policy", () => {
  const cases = [
    [{ faithfulness: faith(true), renderAttempt: 1, rendersRemaining: 3 }, "critique"],
    [{ faithfulness: faith(true, null), renderAttempt: 1, rendersRemaining: 0 }, "critique"],
    [{ faithfulness: faith(false), renderAttempt: 1, rendersRemaining: 2 }, "rerender"],
    [{ faithfulness: faith(false), renderAttempt: 1, rendersRemaining: 0 }, "unrendered"],
    [{ faithfulness: faith(false), renderAttempt: 2, rendersRemaining: 4 }, "unrendered"]
  ];
  for (const [facts, expected] of cases) {
    const { decision, reason } = decideAfterRender(facts);
    assert.equal(decision, expected, JSON.stringify(facts));
    assert.ok(reason.length > 10);
  }
});

test("critique-verdict policy", () => {
  const critique = (verdict) => ({ verdict, reason: "r", revisionHint: "h", scores: {} });
  const base = { revisionsUsed: 0, maxRevisions: 2, rendersRemaining: 3, candidatesLeft: 4 };
  const cases = [
    [{ ...base, critique: critique("ACCEPT") }, "accept"],
    [{ ...base, critique: critique("DROP") }, "drop"],
    [{ ...base, critique: critique("UNREVIEWED") }, "accept-unreviewed"],
    [{ ...base, critique: critique("REVISE") }, "revise"],
    [{ ...base, critique: critique("REVISE"), revisionsUsed: 2 }, "stop-unapproved"],
    [{ ...base, critique: critique("REVISE"), rendersRemaining: 0 }, "stop-unapproved"],
    [{ ...base, critique: critique("REVISE"), candidatesLeft: 0 }, "stop-unapproved"],
    // Budget limits never turn an ACCEPT or a DROP into something else.
    [{ ...base, critique: critique("ACCEPT"), rendersRemaining: 0, revisionsUsed: 2 }, "accept"],
    [{ ...base, critique: critique("DROP"), candidatesLeft: 0 }, "drop"]
  ];
  for (const [facts, expected] of cases) {
    assert.equal(decideAfterCritique(facts).decision, expected, JSON.stringify(facts));
  }
  assert.throws(() => decideAfterCritique({ ...base, critique: critique("MAYBE") }), /Unknown critique verdict/);
});

test("reaction-reentry policy", async () => {
  const { decideReentry } = await import("../src/v2/policies/reaction-reentry.js");
  const change = (field) => ({ field, to: "x", source: "stated" });
  const base = { directionIds: ["d1", "d2", "d3"], targetDirectionId: null, unparsed: null, changes: [] };
  const cases = [
    [{ ...base, reaction: { kind: "pick", proposalId: "r1-d1-a1" } }, "done", []],
    [{ ...base, reaction: { kind: "feedback" }, changes: [change("roomType"), change("needs.safety")] }, "plan", []],
    [{ ...base, reaction: { kind: "edit-assumption" }, changes: [change("needs.privacy")] }, "plan", []],
    [{ ...base, reaction: { kind: "edit-assumption" }, changes: [change("palette")] }, "plan", []],
    [{ ...base, reaction: { kind: "feedback", proposalId: "r1-d2-a1" }, targetDirectionId: "d2", changes: [change("preferences.warmth"), change("preferences.text")] }, "compose", ["d2"]],
    [{ ...base, reaction: { kind: "feedback", proposalId: "r1-d2-a1" }, targetDirectionId: "d2", changes: [change("preferences.text")], unparsed: "not quite" }, "compose", ["d2"]],
    [{ ...base, reaction: { kind: "feedback" }, changes: [change("preferences.warmth"), change("preferences.text")] }, "compose", ["d1", "d2", "d3"]],
    [{ ...base, reaction: { kind: "feedback" }, changes: [change("preferences.text")], unparsed: "something else entirely" }, "plan", []],
    // A room change wins over a target: the directions themselves are stale.
    [{ ...base, reaction: { kind: "feedback", proposalId: "r1-d1-a1" }, targetDirectionId: "d1", changes: [change("roomType")] }, "plan", []]
  ];
  for (const [facts, decision, directionIds] of cases) {
    const result = decideReentry(facts);
    assert.equal(result.decision, decision, JSON.stringify(facts));
    assert.deepEqual(result.directionIds, directionIds);
    assert.ok(result.reason.length > 5);
  }
});
