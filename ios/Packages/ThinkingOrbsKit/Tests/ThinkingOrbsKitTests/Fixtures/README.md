# Golden geometry fixture

`orbs-golden.json` is the upstream reference fixture, with JSON formatting only
changed for this package. Its 72 cases cover all nine animation states, both tuned
sizes, and four timestamps.

- Source: `packages/thinking-orbs/spec/orbs-golden.json` in
  https://github.com/Jakubantalik/Libraries.dev
- Pinned upstream commit: `2015f0ba79a9faec351719c4a6d590a1e6bfa243`
- Git blob: `838dbf60daa1fb230482a867142131114076c88b`
- Original downloaded bytes SHA-256:
  `70bfaa2bbf1390b63f6ec02f16d7a4329fee67b3b290e671fe1d205328165e20`
- License: MIT; see the package's `LICENSE`.

The test reads the fixture through `Bundle.module`, independent of the working
directory and without fetching data at test runtime.
