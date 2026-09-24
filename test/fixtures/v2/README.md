# v2 mock fixtures

Hand-written model responses for the mock provider (`src/mock-provider.js`). No fixture
here came from a real API call.

Each file holds `{ "room", "fixtures": [ { "stage", "key", "responses", "note" } ] }`.

- `key` is the stage's fixture-key projection of its input (see `fixtureKey` in each
  stage module). The mock looks fixtures up by `stage` + hash of `key`. A miss throws
  and prints the exact key to add; it never reaches a real provider.
- `responses[n]` answers attempt `n + 1`; the last one repeats. A response is
  `{ "json": … }`, `{ "rawText": "…" }` (for deliberately broken output) or `{ "error": "…" }`.
- `render` fixtures are optional overrides: without one, the mock render paints the
  swatch colour over the window region. With one, `colourHex` replaces it (off-colour tests).

Deliberately broken cases (each must produce a visible warning, never a crash):

| Room | Stage | Break |
|---|---|---|
| IMG_4297 | perceive | attempt 1 is invalid JSON (truncated) → retry succeeds |
| indy-window | plan | attempt 1 misses `lightLevel`; attempt 2 uses a disallowed category → repaired in code |
| IMG_4298 | compose | one direction returns an unknown variant ID twice → fallback to RETRIEVE's top pick |
| IMG_4298 | compose | one direction omits `rationale` on attempt 1 → retry succeeds |
| living-room-window | render | first render of one proposal is off-colour → faithfulness fails → re-render |
| living-room-window | critique | one proposal gets REVISE → revised proposal |
| uploaded_room | critique | one direction is DROPped; one critique is invalid JSON twice → unreviewed |
