# Changelog

Notable changes are listed by release. Dates use ISO 8601.

## [0.1.0] - 2026-10-11

First tagged public release.

- Added a self-hosted browser console and Cloudflare Worker entry point for the Workbench API.
- Added durable SQLite-backed conversations, queued runs, scheduler limits, SSE updates, and Pi/OpenCode runtime adapters.
- Added per-conversation Git worktrees, workspace controls, attachments, notifications, usage reporting, and backup tooling.
- Enabled bubblewrap isolation by default with environment allowlisting, credential masking, path guards, and process cleanup.
- Hardened new-chat workspace selection and transcript scroll behavior, and added staged UI asset validation with atomic promotion.
- Added CI, repository setup guidance, and regression coverage for runtime, security, scheduler, persistence, UI policies, and build assets.

Verification on the release commit: `npm run check`, `npm test`, and the isolated staging build. Live UI/edge E2E checks require a dedicated test service and are not part of CI.
