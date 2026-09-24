// Where to resume after the person reacts. Pure: the reaction and what it changed
// in the Brief in, { decision, reason, directionIds } out.
//
//   done     a pick with nothing to change: the session ends on that proposal
//   plan     the room itself was re-described (type, needs, style, light, palette),
//            or feedback we could not tie to one proposal: new directions
//   compose  only preferences changed (warmer, lighter, no blue, or unparsed notes
//            about one proposal): same direction(s), different variant

// Fields that describe the room or its needs. Changing any of them invalidates the
// directions, which were planned for the old Brief.
const STRUCTURAL = [/^roomType$/, /^needs\./, /^styleTags$/, /^palette$/, /^lightLevel$/, /^materials$/, /^window/, /^existingCovering$/];

export function decideReentry({ reaction, changes, targetDirectionId, directionIds, unparsed }) {
  const changed = changes.map((c) => c.field);
  const structural = changed.filter((field) => STRUCTURAL.some((re) => re.test(field)));

  if (reaction.kind === "pick" && changed.length === 0) {
    return { decision: "done", reason: `you chose ${reaction.proposalId}`, directionIds: [] };
  }
  if (structural.length > 0) {
    return { decision: "plan", reason: `the room was re-described (${structural.join(", ")}); planning new directions`, directionIds: [] };
  }
  if (targetDirectionId) {
    return {
      decision: "compose",
      reason: `${changed.length ? `preferences changed (${changed.join(", ")})` : "feedback"} about ${targetDirectionId}; trying a different variant in the same direction`,
      directionIds: [targetDirectionId]
    };
  }
  if (unparsed) {
    return { decision: "plan", reason: `feedback "${unparsed}" is not about one proposal and was not understood as a field; planning new directions that read it`, directionIds: [] };
  }
  if (changed.length > 0) {
    return { decision: "compose", reason: `preferences changed (${changed.join(", ")}); new variants for every direction`, directionIds };
  }
  return { decision: "done", reason: "the reaction changed nothing", directionIds: [] };
}
