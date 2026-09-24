import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORY_ROLES, GUIDELINES, ROOM_TYPES, roomLayers } from "../src/v2/guidelines.js";
import { testCatalog, testConfig } from "./helpers.mjs";

const config = testConfig();
const catalog = await testCatalog(config);

test("every catalog category is mapped exactly, and nothing else is", () => {
  assert.deepEqual(Object.keys(GUIDELINES.catalogCategories).sort(), catalog.categories);
  assert.deepEqual(Object.keys(CATEGORY_ROLES.categories).sort(), catalog.categories);
});

test("every guideline name used by a room resolves through nameMap", () => {
  for (const [roomId, room] of Object.entries(GUIDELINES.rooms)) {
    for (const layer of ["visual", "functional"]) {
      const resolved = new Set();
      for (const name of room[layer].guidelineNames) {
        const entry = GUIDELINES.nameMap[name];
        assert.ok(entry, `${roomId}: guideline name "${name}" has no nameMap entry`);
        for (const category of entry.catalog) resolved.add(category);
      }
      assert.deepEqual([...resolved].sort(), [...room[layer].categories].sort(), `${roomId} ${layer} categories match their names`);
      for (const category of room[layer].categories) {
        assert.ok(catalog.categories.includes(category), `${roomId}: "${category}" is not an exact catalog category`);
      }
    }
  }
});

test("every unmapped guideline name is listed with the rooms that cite it", () => {
  const listed = new Map(GUIDELINES.unmapped.map((entry) => [entry.name, entry]));
  for (const required of ["Stirpe Bamboo Curtain", "Blackout Roman Shades", "Faux Wood Blinds"]) {
    assert.ok(listed.has(required), `${required} must be listed as unmapped`);
  }
  for (const [name, entry] of Object.entries(GUIDELINES.nameMap)) {
    if (entry.catalog.length > 0) continue;
    assert.ok(listed.has(name), `${name} maps to nothing but is not in unmapped`);
    const citing = Object.entries(GUIDELINES.rooms)
      .filter(([, room]) => [...room.visual.guidelineNames, ...room.functional.guidelineNames].includes(name))
      .map(([id]) => id)
      .sort();
    assert.deepEqual([...listed.get(name).rooms].sort(), citing, `${name}: rooms list is complete`);
  }
});

test("the aliases requested in the brief are applied", () => {
  assert.deepEqual(GUIDELINES.nameMap["Blackout Curtains"].catalog, ["Blackout Drapery"]);
  assert.deepEqual(GUIDELINES.nameMap["Curtains"].catalog, ["Drapery Panels"]);
  assert.deepEqual(GUIDELINES.nameMap["Zebra / Dual Shades"].catalog, ["Zebra Shades"]);
});

test("every room type has a usable visual layer and category roles agree with it", () => {
  for (const roomType of ROOM_TYPES) {
    const layers = roomLayers(roomType);
    assert.ok(layers.visual.length > 0, `${roomType} has visual categories`);
    for (const category of layers.visual) {
      assert.ok(CATEGORY_ROLES.categories[category].role !== "none", `${category} has a role`);
    }
  }
});
