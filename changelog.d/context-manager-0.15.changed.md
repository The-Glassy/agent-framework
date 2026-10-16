- Depends on `@animalabs/context-manager` `^0.15.0` (was `^0.14.0`). Under
  `foldingStrategy: 'kv-unified'` a strategy built from a recipe now takes the
  hysteresis certificate's certified exit unless its `kvUnified` block sets
  `hysteresisCertificate: false`: a compile whose carried layout provably
  remains the policy's selection skips the full solve, and one it cannot prove
  runs the full solver as before. Patch release from the v0.21.1 tag with this
  dependency bump only; the work on `main` since 0.21.0 is not included.
