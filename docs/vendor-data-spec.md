# Window Covering Product Data — Vendor Request

What we need to list and recommend your products accurately. Two spreadsheets and an image
folder. Everything below is data you almost certainly already hold in your PIM, ERP, or spec
sheets — we are not asking you to create new content.

**Deliverables**

| File | Contents |
|---|---|
| `products.csv` | One row per product / style line |
| `variants.csv` | One row per colorway |
| `images/` | Images named to join against `variant_id` |

CSV or XLSX both fine. UTF-8, comma-separated, first row = headers, exact column names below.
An existing PIM export in a different shape is also fine — send it with a column glossary and
we will map it.

---

## If you can only send three things

Vendors often can't fill every field. In priority order, these three carry most of the value:

1. **`variant_id` + a flat swatch image per colorway** — the single most important item
2. **`opacity_class`** — sheer / light-filtering / room-darkening / blackout
3. **`min/max_width_mm` and `min/max_height_mm`** — whether the product fits the window at all

Everything else improves quality. These three determine whether a recommendation is possible.

---

## 1. `products.csv`

One row per product line. Required columns marked ✅.

| Column | Type | Req | Notes |
|---|---|---|---|
| `product_id` | string | ✅ | Your stable SKU / style code. Must not change between updates. |
| `product_name` | string | ✅ | Customer-facing name |
| `category` | enum | ✅ | See category list below |
| `collection` | string | | Product family or range name |
| `description` | text | | 1–3 sentences, customer-facing |
| `mount_types` | enum list | ✅ | `inside`, `outside`, `ceiling` — pipe-separated for multiple |
| `operation` | enum list | ✅ | `cordless`, `corded`, `continuous_loop`, `wand`, `motorized` |
| `child_safe` | boolean | ✅ | `true` / `false` — cordless or compliant with child-safety standards |
| `min_width_mm` | integer | ✅ | Smallest orderable width |
| `max_width_mm` | integer | ✅ | Largest orderable width |
| `min_height_mm` | integer | ✅ | |
| `max_height_mm` | integer | ✅ | |
| `msrp` | decimal | | Base price, or use `price_tier` |
| `price_tier` | enum | | `budget`, `mid`, `premium` — if you'd rather not share pricing |
| `currency` | string | | ISO code, e.g. `USD` |
| `warranty_years` | integer | | |
| `care_instructions` | text | | |
| `status` | enum | | `active`, `discontinued`, `made_to_order` |

**`category` values** — `roller_shade`, `solar_shade`, `roman_shade`, `cellular_shade`,
`zebra_shade`, `vertical_blind`, `aluminum_blind`, `wood_blind`, `faux_wood_blind`,
`vinyl_blind`, `drapery_panel`, `sheer_curtain`, `outdoor_shade`, `shutter`.
If your product doesn't fit, send your own label and we'll map it.

---

## 2. `variants.csv`

One row per colorway. This is the more important of the two files.

| Column | Type | Req | Notes |
|---|---|---|---|
| `variant_id` | string | ✅ | Unique across your whole catalog. **Image filenames must match this.** |
| `product_id` | string | ✅ | Must match a row in `products.csv` |
| `color_name` | string | ✅ | Your name for it, e.g. `Dove Gray` |
| `color_family` | enum | ✅ | See list below |
| `color_hex` | string | ⭐ | `#RRGGBB`. If you have a measured value, this is the highest-value single field in the whole request — see *Color accuracy*. |
| `opacity_class` | enum | ✅ | `sheer`, `light_filtering`, `room_darkening`, `blackout` |
| `openness_factor` | decimal | | Solar shades only — e.g. `3` for 3% |
| `material` | enum | ✅ | `polyester`, `cotton`, `linen`, `blend`, `bamboo`, `jute`, `pvc`, `vinyl`, `aluminum`, `wood`, `faux_wood` |
| `texture` | string | | Free text, e.g. `woven linen-like`, `smooth`, `slubbed` |
| `pattern` | enum | | `solid`, `textured`, `striped`, `patterned` |
| `sheen` | enum | | `matte`, `satin`, `sheen` |
| `weave` | string | | e.g. `basketweave`, `twill` |
| `thermal_r_value` | decimal | | If measured |
| `swatch_image` | filename | ✅ | Flat swatch — see image spec |
| `product_image` | filename | | Product alone on white |
| `lifestyle_image` | filename | | Installed in a room |
| `status` | enum | | `active`, `discontinued` |
| `lead_time_days` | integer | | |

**`color_family` values** — `white`, `cream`, `beige`, `tan`, `brown`, `gray`, `charcoal`,
`black`, `blue`, `green`, `red`, `yellow`, `purple`, `pink`, `metallic`, `multi`.

### Example rows

```csv
variant_id,product_id,color_name,color_family,color_hex,opacity_class,material,texture,pattern,swatch_image
RLS26001-01,RLS26001,Bleach White,white,#F2F0EA,blackout,polyester,smooth,solid,RLS26001-01_swatch.jpg
RLS26001-04,RLS26001,Charcoal,charcoal,#4A4A4D,blackout,polyester,smooth,solid,RLS26001-04_swatch.jpg
CUR26002-01,CUR26002,Ivory,cream,#EFE6D6,light_filtering,linen,slubbed,textured,CUR26002-01_swatch.jpg
```

---

## 3. Images

Name every file after its `variant_id` with a suffix:

```
RLS26001-01_swatch.jpg      flat material sample     required
RLS26001-01_product.jpg     product alone on white   preferred
RLS26001-01_room.jpg        installed in a room      optional
```

### Swatch images — the important ones

A flat swatch is how we match a product's color to a customer's room. A photo of the product
hanging in a styled room cannot do this: the room's paint, lighting, and white balance shift
the apparent color, and we end up matching the wrong thing.

- **Fill the frame** with the material — no room, no window, no props
- **1000 × 1000 px minimum**, square
- **Neutral background** — white or 18% gray, if any is visible
- **Neutral, even lighting** (≈5000–6500K), no colored bounce, no strong shadow
- **sRGB**, JPEG quality 90+ or PNG
- **No color grading or retouching.** An unedited accurate photo beats a beautiful inaccurate one
- Show the real weave and texture at full resolution

### Color accuracy

Color is the thing we most need to get right and the thing most easily lost in photography.
Any one of these solves it, in order of preference:

1. A **measured `color_hex`** from a spectrophotometer or your design source files
2. A **color reference card** (X-Rite ColorChecker or similar) in frame on a few shots so we can calibrate
3. Swatch photos shot to the lighting spec above

If you send physical swatch cards, we can measure them ourselves — tell us and we'll arrange it.

### Lifestyle and product images

Send these too if you have them — they're genuinely useful for showing drape, fold, hang, and
scale, and for generating room previews. They just can't substitute for a flat swatch.

---

## What we are *not* asking you for

We do **not** need style tags, room recommendations, "best for" / "avoid for" guidance, or
pairing suggestions. Those are aesthetic judgments we make ourselves. Please don't spend time
generating them — we'd rather have accurate physical specs.

---

## Updates

- Keep `product_id` and `variant_id` **stable forever.** If a color is reformulated, issue a new
  ID rather than changing what an existing one refers to.
- Send discontinued items with `status = discontinued` rather than deleting rows, so we can
  retire them cleanly instead of finding a gap.
- A full refresh on any regular cadence is fine. Tell us what's realistic.

## Questions

If a field doesn't apply, leave it blank rather than inventing a value — a blank is
information, a guess is not. If a required field is genuinely unavailable, tell us which and
we'll work out a fallback.
