- The all-except scope (issue #232 §3.2; focus folded into tune-out):
  `tune_out` with `scope: 'all-except'`, or its alias `focus`, holds every
  channel except one — DMs and channels registered later included — for a
  mandatory `durationSeconds`. A turn with no delivery of its own speaks into
  the excepted channel. `mode: 'check'` reports held counts per channel and
  peeks one channel without releasing; release is per channel, each capped.
  A per-channel epoch takes precedence; the reader may end the scope;
  exhausting the reader's wake budget pauses reader wakes rather than ending
  the hold (`tune-out:wake-budget-paused`); closing the excepted channel ends
  it. Listed by `listPolicyEpochs()` as `{ kind: 'all-except', except }`.
  Entry and release are announced in the excepted channel as one bracketed
  line each under the resident's name (`tuneOut.announce`, default true;
  traced `tune-out:announced` / `tune-out:announce-failed`).
