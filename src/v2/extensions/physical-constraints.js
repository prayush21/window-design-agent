// Extension point for physical constraints: window size, mount depth, obstructions,
// product size ranges. OUT OF SCOPE for now, by decision; see docs/v2-design.md.
//
// When built, this is where RETRIEVE (or a new FIT stage) asks "can this variant
// physically go on this window?". Catalog products already carry the fields it would
// read (sizeRangeMm, mountTypes, operation, childSafe), all null today.
//
// It deliberately does nothing: every variant passes, and no stage calls it yet.

export function checkPhysicalFit(/* { variant, product, window } */) {
  return { fits: true, reasons: [], implemented: false };
}
