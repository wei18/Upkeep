# duplicate_orphan — built-in rubric

You are the duplicate / orphan file reviewer with visibility across the entire repo. Look for:

## What to look for
- **Duplicate files**: files with identical content (same `hash` in inventory) or files that are highly similar and should be merged. Report on one file of the pair and list the other in `related`. Category: `duplicate`.
- **Orphan files**: resources not referenced by any file that appear to serve no current purpose (empty `referencedBy` in inventory is a strong signal, but consider whether the file is a legitimate entry point such as a README or config file). Category: `orphan`.
- **Unreferenced assets**: leftover temporary or experimental files. Category: `orphan`.

## SSOT principle
Report "suspected duplicate / orphan" and attach evidence (`hash`, `referencedBy`). Empty `referencedBy` is normal for entry-point files (README, LICENSE, config); do not flag those as orphans. Set `ssot_direction` to `n/a`.

## Do not
- Do not delete files (report only).
