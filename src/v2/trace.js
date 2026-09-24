import fs from "node:fs";
import path from "node:path";
import { summarizeConfig } from "./config.js";
import { validate } from "./schemas/index.js";

// A trace is the record of one session: every stage call with its input and output,
// the domain objects, the policy decisions and their reasons, cost and warnings.
// Its format does not depend on which orchestrator produced it, so a workflow run
// and a future agent run on the same room can be compared line by line.

export class TraceRecorder {
  constructor({ session, orchestrator, config, dir }) {
    this.dir = dir;
    this.file = path.join(dir, `${session.sessionId}.json`);
    const existing = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : null;
    this.trace = existing || {
      traceVersion: 1,
      sessionId: session.sessionId,
      orchestrator,
      mode: config.mode,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      roomPhoto: session.input.roomPhoto,
      config: summarizeConfig(config),
      stages: [],
      brief: null,
      directions: [],
      shortlists: {},
      proposals: [],
      renders: [],
      faithfulness: [],
      critiques: [],
      decisions: [],
      reactions: [],
      presentation: null,
      history: [],
      warnings: [],
      totals: { latencyMs: 0, costUsd: 0, estimatedCostUsd: 0, tokens: 0, renders: 0, llmCalls: 0, byStage: {} }
    };
    this.trace.orchestrator = orchestrator;
  }

  nextSeq() {
    return this.trace.stages.length + 1;
  }

  recordStage(record) {
    const entry = { seq: this.nextSeq(), ...record, input: redact(record.input), output: redact(record.output) };
    this.trace.stages.push(entry);

    const totals = this.trace.totals;
    const byStage = (totals.byStage[record.stage] ??= { calls: 0, latencyMs: 0, costUsd: 0, tokens: 0 });
    byStage.calls += 1;
    byStage.latencyMs += record.latencyMs;
    totals.latencyMs += record.latencyMs;

    for (const attempt of record.attempts || []) {
      const tokens = attempt.usage?.totalTokens || 0;
      totals.tokens += tokens;
      byStage.tokens += tokens;
      if (record.kind === "llm" && attempt.provider) totals.llmCalls += 1;
      if (record.kind === "image" && attempt.provider) totals.renders += 1;
      if (typeof attempt.estimatedCostUsd === "number") totals.estimatedCostUsd = (totals.estimatedCostUsd || 0) + attempt.estimatedCostUsd;
      if (attempt.costUsd === null || attempt.costUsd === undefined) {
        if (attempt.provider) byStage.unpriced = (byStage.unpriced || 0) + 1;
      } else {
        totals.costUsd += attempt.costUsd;
        byStage.costUsd += attempt.costUsd;
      }
    }
    return entry;
  }

  /** Copies the session's domain state into the trace (the trace is a superset). */
  sync(session) {
    Object.assign(this.trace, {
      brief: session.brief,
      directions: session.directions,
      shortlists: session.shortlists,
      proposals: session.proposals,
      renders: session.renders,
      faithfulness: session.faithfulness,
      critiques: session.critiques,
      decisions: session.decisions,
      reactions: session.reactions,
      presentation: session.presentation,
      history: session.history,
      warnings: session.warnings
    });
  }

  write() {
    this.trace.updatedAt = new Date().toISOString();
    const errors = validate("v2.trace", this.trace);
    if (errors.length > 0) {
      // A trace that fails its own schema is a bug in v2, not in the run. Say so in
      // the trace itself rather than refusing to write the evidence.
      this.trace.traceSchemaErrors = errors.slice(0, 20);
    } else {
      delete this.trace.traceSchemaErrors;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.trace, null, 2)}\n`);
    return this.file;
  }
}

// Inputs can carry data URLs; a trace keeps a marker, not megabytes of base64.
function redact(value) {
  if (typeof value === "string") {
    return value.startsWith("data:") ? `<data-url ${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}
