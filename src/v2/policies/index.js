import { decideAfterCritique, decideAfterRender } from "./critique-verdict.js";

// The workflow's decision points, by name. Each is a pure function of facts to
// { decision, reason }, recorded in the trace as a policy decision. These are the
// first places an agent may take over, one at a time.

export const POLICIES = {
  "render-check": decideAfterRender,
  "critique-verdict": decideAfterCritique
};

export function getPolicy(name) {
  const policy = POLICIES[name];
  if (!policy) throw new Error(`Unknown policy "${name}".`);
  return policy;
}
