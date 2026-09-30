import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadFixtureStore } from "../src/mock-provider.js";
import { parseJsonFromText } from "../src/providers.js";
import { SHARED_SCHEMAS, compileSchema, validate } from "../src/v2/schemas/index.js";
import { STAGES } from "../src/v2/stages/index.js";
import { ROOT_DIR } from "./helpers.mjs";

const fixturesDir = path.join(ROOT_DIR, "test", "fixtures", "v2");

test("every shared schema and every stage's input and output schema compiles", () => {
  for (const schema of Object.values(SHARED_SCHEMAS)) assert.ok(compileSchema(schema.$id));
  for (const stage of Object.values(STAGES)) {
    assert.ok(compileSchema(stage.inputSchema), `${stage.name} input`);
    assert.ok(compileSchema(stage.outputSchema), `${stage.name} output`);
    for (const key of ["name", "description", "kind", "run"]) assert.ok(stage[key], `${stage.name}.${key}`);
    assert.ok(["llm", "code", "image"].includes(stage.kind));
  }
});

test("fixtures: valid responses match their stage's output schema; broken ones fail the way they claim", () => {
  const store = loadFixtureStore(fixturesDir);
  assert.ok(store.size > 0);
  const counts = { valid: 0, json: 0, schema: 0, check: 0, override: 0 };

  for (const fixture of store.entries()) {
    const stage = STAGES[fixture.stage];
    assert.ok(stage, `fixture for unknown stage ${fixture.stage} in ${fixture.file}`);

    for (const [index, response] of fixture.responses.entries()) {
      const where = `${fixture.file} ${fixture.stage} response ${index + 1}`;
      if (stage.kind === "image") {
        assert.match(response.json.colourHex, /^#[0-9a-f]{6}$/i, where);
        counts.override += 1;
        continue;
      }
      if (response.broken === "json") {
        assert.throws(() => parseJsonFromText(response.rawText), undefined, `${where} should not parse`);
        counts.json += 1;
        continue;
      }
      const payload = response.json ?? parseJsonFromText(response.rawText);
      const errors = validate(stage.fixtureSchema || stage.outputSchema, stage.fromFixture ? stage.fromFixture(payload) : payload);
      if (response.broken === "schema") {
        assert.notDeepEqual(errors, [], `${where} should fail the schema`);
        counts.schema += 1;
      } else {
        assert.deepEqual(errors, [], where);
        counts[response.broken === "check" ? "check" : "valid"] += 1;
      }
    }
  }
  assert.ok(counts.valid >= 20, `valid responses: ${counts.valid}`);
  assert.ok(counts.json >= 1 && counts.schema >= 1 && counts.check >= 1, JSON.stringify(counts));
});

test("fixtures cover at least 3 eval rooms", () => {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  const rooms = files.map((f) => JSON.parse(fs.readFileSync(path.join(fixturesDir, f), "utf8")).room).filter(Boolean);
  assert.ok(new Set(rooms).size >= 3, rooms.join(", "));
});
