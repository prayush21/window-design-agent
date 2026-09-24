# Hand-written briefs (perception labels)

One file per room photo in `evals/rooms/`, named `<roomId>.json`. They are the reference for
the **perception** metric: how well PERCEIVE + BRIEF describe the room, field by field.
They are labels, not a single right answer: each field lists what is **acceptable**.

```json
{
  "roomId": "uploaded_room",
  "author": "your name",
  "notes": "free text",
  "fields": {
    "roomType":          { "acceptable": ["living-room"] },
    "lightLevel":        { "acceptable": ["medium", "bright"] },
    "needs.privacy":     { "acceptable": ["medium", "high"] },
    "styleTags":         { "anyOf": ["cozy", "casual"] },
    "palette":           { "hexes": ["#8e9aa3", "#2f4a73"], "maxDeltaE": 15 },
    "windowRegion":      { "region": { "x": 0.09, "y": 0.36, "w": 0.83, "h": 0.40 }, "minIoU": 0.5 }
  }
}
```

Field paths are Brief paths (`roomType`, `windowType`, `lightLevel`, `existingCovering`,
`needs.privacy|blackout|glare|moisture|safety`, `styleTags`, `materials`, `palette`,
`windowRegion`). Label kinds:

| kind | scored as |
|---|---|
| `acceptable: [...]` | 1 if the Brief value is one of them |
| `anyOf: [...]` | 1 if any listed word appears in the Brief's list (case-insensitive) |
| `hexes: [...]`, `maxDeltaE` | share of listed colours matched by a Brief palette colour within ΔE2000 |
| `region`, `minIoU` | 1 if the window box overlaps the labelled box by at least `minIoU` |

Leave out any field you do not want scored. `npm run v2:eval` scores every trace whose room
has a brief here, and also scores the no-model PERCEIVE baseline, which the VLM must beat.

`uploaded_room.json` is an example written by Claude to show the format. **Replace it with
your own labels**; it is not ground truth.
