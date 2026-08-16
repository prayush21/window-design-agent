# Catalog capture template

Copy this folder structure for every product. One folder per product, one `product.json`
per product, and two images per colorway.

## Folder shape

```
Product Catalog/
└── Blackout Roller Shades/          ← category, exactly as the site names it
    └── RLS26001/                    ← one folder per product
        ├── product.json
        ├── room/
        │   ├── RLS2600101B9.png     ← the lifestyle / in-room photo
        │   └── RLS2600104B9.png
        └── swatch/
            ├── RLS2600101B9.png     ← the flat colour chip  ← THE NEW ONE
            └── RLS2600104B9.png
```

**The filename is the join key.** The same filename in `room/` and `swatch/` means the same
colorway, and it must match a `variantId` in `product.json`. Keep the existing naming
(`RLS26001` + `01` + `B9`) — nothing needs renaming, the current files just move into `room/`.

Never reuse a `variantId` for a different colour. If a colour is renamed or reformulated,
give it a new id.

## The swatch images are the point of this

This is the one thing missing from the current data, and it's the most valuable thing to add.

On the product page there's a colour selector — the little chips or circles you click to switch
colour. **Those chips are the swatches.** Save each one into `swatch/`.

- Grab the **largest version available.** Sites often display a 60px chip but store a 500px or
  1000px file behind it — check the image URL, the `srcset`, or the zoom/enlarge view before
  settling for the thumbnail.
- If the site has a "view swatch" / "order a sample" / fabric close-up image, that's even
  better than the chip. Use it.
- Crop out any border, label, checkmark, or drop shadow. Just the material.
- **Don't** substitute a cropped piece of the room photo. The room's lighting shifts the colour
  and that's exactly the problem swatches exist to solve. If there's genuinely no chip on the
  site, leave `swatch/` empty for that variant and note it — a missing swatch is fine, a wrong
  one is not.

The room photos you already collected stay exactly as they are; they just move into `room/`.

## product.json

See the example in `Blackout Roller Shades/RLS26001/product.json`.

Everything in it comes straight off the product page. Rules:

- **Copy, don't compose.** Use the site's own wording for `description`. Don't write marketing copy.
- **`null` beats a guess.** If a field isn't on the page, set it to `null` or drop it. A blank
  is information; an invented value looks like data and quietly corrupts the results.
- **`sourceUrl` is required.** It's how anything questionable gets re-checked later.
- **`opacityClass`** is one of: `sheer`, `light_filtering`, `room_darkening`, `blackout`.
  Sites usually state this outright ("Blackout", "Light Filtering"). If it's not stated, use `null`.
- **`material`** is one of: `polyester`, `cotton`, `linen`, `blend`, `bamboo`, `jute`, `pvc`,
  `vinyl`, `aluminum`, `wood`, `faux_wood`. If the site says something else, put its exact
  wording in and we'll map it.
- **Sizes in millimetres.** If the site lists inches, convert (1 in = 25.4 mm). These usually
  come from the size configurator's min/max, not the description.
- **`colorName`** is the site's name for the colour, exactly as written — "Dove Gray", not "grey".

## Do not fill these in

We derive them, and a guess here is worse than nothing:

`colorFamily` · `hex` · `warmth` · `texture` · `styleTags` · `bestFor` · `avoidFor`

They're aesthetic or measured judgments, not facts on the page. Skip them entirely.

## Before handing it over

- [ ] Every product folder has a `product.json` with a working `sourceUrl`
- [ ] Every `variantId` in `product.json` has a matching file in `room/`
- [ ] Every `variantId` has a matching file in `swatch/`, or a note saying why not
- [ ] Filenames match between `room/` and `swatch/` (extensions may differ)
- [ ] No renamed or reused ids from the previous batch
- [ ] Category folder names match the site's own category names
