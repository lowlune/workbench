# Contributing

Thanks for helping improve Workbench. The project targets Node.js `>=22.12` and a Linux runtime for the default sandboxed agent execution.

## Before opening a change

1. Install dependencies with `npm ci`.
2. Run `npm run check` and `npm test`.
3. For UI changes, run `npm run build` and inspect the generated console. The build promotes assets into `public/`; do not run it against a live checkout unless that update is intended.
4. Keep credentials, `wrangler.jsonc`, runtime data, and provider state out of commits.

The CI workflow runs checks, tests, and a build on pushes to `main` and pull requests. The live `test:runtime`, `test:ui`, and `test:edge` scripts can write test conversations or start agent runs; use a dedicated test stack before running them.

## Pull requests

Keep changes focused, describe user-visible behavior and operational impact, and include the checks you ran. For changes to scheduling, persistence, sandboxing, authentication, or asset promotion, add or update a regression test. Do not include secrets, production databases, or generated runtime state.
