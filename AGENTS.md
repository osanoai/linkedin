# AGENT INSTRUCTIONS

Guidance for Claude Code, Codex, Gemini, and other coding agents working in this repository.

## Project Overview

`@osanoai/linkedin` — a zero-dependency Node.js CLI (bin name: `linkedin`) that does exactly two things: authenticate a LinkedIn member (OAuth 2.0 or direct access token) and create posts as that member (text, article/URL shares, up to 9 images, video, member/company @-mentions). Published to npm as `@osanoai/linkedin`; the GitHub repo is `osanoai/linkedin`.

It is built directly on LinkedIn's documented consumer APIs — UGC Posts (`/v2/ugcPosts`), Assets (`/v2/assets?action=registerUpload` + binary PUT), OpenID userinfo (`/v2/userinfo`), and the 3-legged OAuth flow. If you change API behavior, check the docs first:
- Share: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
- Auth: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow

`SKILL.md` is the end-user/agent guide for the *installed* CLI (install, auth, post). This file is about working on the *source*.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `bin/linkedin.js` | Executable entry; maps thrown errors to exit codes |
| `src/cli.js` | Argument parsing, command dispatch, all `--help` text |
| `src/auth.js` | OAuth login (loopback callback server, CSRF state check), token storage, status/logout |
| `src/api.js` | LinkedIn REST client: userinfo/me, registerUpload, binary upload, ugcPosts |
| `src/post.js` | Post pipeline: validation → mentions → media upload → payload → create |
| `src/mentions.js` | `@[Name](urn:li:person:...)` inline syntax → `shareCommentary.attributes` |
| `src/config.js` | Credential file handling + env-var overrides (incl. API base URLs) |
| `src/errors.js` | Error classes; exit codes: 1 API, 2 usage, 3 auth |
| `test/e2e.test.js` | Full e2e suite (spawns the real CLI binary) |
| `test/mock-linkedin.js` | Local mock implementing LinkedIn's documented contracts |
| `test/helpers.js` | CLI spawner, fixtures (tiny PNG/MP4), isolated config dirs |
| `SKILL.md` | Usage skill for agents operating the installed CLI |

No build step, no runtime dependencies, plain ESM JavaScript. Keep it that way — adding a dependency is an explicit design decision, not a convenience.

## Commands

```bash
pnpm install --frozen-lockfile   # install (there are no deps; this validates the lockfile)
pnpm test                        # full e2e suite via node --test (28 tests, ~2s)
node bin/linkedin.js ...   # run the CLI from source
npm pack --dry-run               # verify publish contents (bin, src, README, SKILL, LICENSE)
```

**pnpm is the pinned package manager** (`packageManager` field in package.json, hash-pinned). `.npmrc` sets `minimum-release-age=10080` so pnpm refuses dependency versions younger than 7 days (supply-chain protection). Do not switch to npm/yarn or remove these settings.

## Testing

The e2e suite spawns the actual CLI binary as a subprocess against `test/mock-linkedin.js`, which faithfully implements the OAuth authorize/token endpoints, userinfo, asset registration, binary upload, and ugcPosts (with schema validation and an auth-failure mode). The CLI is pointed at the mock via `LINKEDIN_API_BASE` / `LINKEDIN_OAUTH_BASE`, with an isolated config dir per test via `LINKEDIN_CLI_CONFIG_DIR`.

Rules:
- Every behavior change needs a test that exercises the real binary (use `runCli`/`spawnCli` from `test/helpers.js`), not just the module.
- If you change a request/response shape, update the mock's validation to match LinkedIn's documented contract — the mock's strictness is what makes the suite meaningful.
- Tests must not depend on ambient credentials; `cliEnv()` blanks `LINKEDIN_*` env vars deliberately.

## Live testing against real LinkedIn

`.env` (gitignored — never commit it) contains a real LinkedIn Developer app's `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` for this purpose:

```bash
source .env
node bin/linkedin.js auth login          # opens a browser; a human must click Allow
node bin/linkedin.js post "..." --dry-run   # preview payload without posting
```

The OAuth callback is `http://localhost:8914/callback` (default `--port 8914`); that exact URL must be listed under **Authorized redirect URLs** on the app's Auth tab in the LinkedIn Developer Portal, and the app needs the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products. A real post is public and visible on the member's profile — get explicit human approval for the exact text before posting, and prefer `--dry-run` when verifying behavior.

## CI/CD (GitHub Actions, mirrors osanoai/multicli)

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `tests.yml` | PRs to main; called by release | Syntax check + e2e suite on Node 20/22/24 with pinned pnpm |
| `scan.yml` | PRs to main; called by release | Shai-Hulud supply-chain detector, then CodeQL (config in `.github/codeql/`) |
| `release.yml` | Push to main (src/bin/package/docs paths) | See below |
| `scorecard.yml` | Push to main + weekly | OpenSSF Scorecard |

**Release flow** (`release.yml`): on every qualifying push to main it checks whether `package.json`'s version already exists on npm.
- Not on npm → runs scan → tests → `npm publish --provenance --access public` (OIDC trusted publishing, no token), then tags `vX.Y.Z` and creates a GitHub Release.
- Already on npm → opens (and auto-merges) a `chore/version-bump` PR that bumps the patch version; merging that PR triggers the publish path.

So: merging any code change to main eventually publishes automatically. Never bump the version manually in a feature PR unless you intend to publish exactly that version.

**Repo prerequisites** (one-time, for whoever configures `osanoai/linkedin` on GitHub/npm):
- npm: configure Trusted Publishing for `@osanoai/linkedin` pointing at `osanoai/linkedin` / `release.yml` (publish uses OIDC + provenance; the npm CLI, not pnpm, performs the publish — pnpm is for installs/dev).
- GitHub secrets `APP_ID` and `APP_PRIVATE_KEY` (GitHub App used to open auto-merge bump PRs), same app as multicli.
- Branch protection on main with the Tests and Scan checks required.

## Security posture — do not regress

- Zero runtime dependencies; the only lockfile entries are dev-time (currently none).
- pnpm hash-pinned via `packageManager`; `.npmrc` enforces `minimum-release-age=10080` (7 days) and `engine-strict`.
- All GitHub Actions pinned to full commit SHAs.
- Credentials are stored chmod 0600; the client secret is never sent in URLs; OAuth uses a random `state` and rejects mismatches.
- Never log or echo tokens/secrets; never commit `.env`.

## Conventions

- Plain ESM JavaScript, Node >= 18.17 (built-in `fetch`, `node:test`). No TypeScript, no transpilation.
- User-facing errors are actionable (say what to run next) and map to exit codes: 0 success, 1 API error, 2 usage, 3 auth.
- `--help` output is a contract tested by the e2e suite — if you add/change a flag, update the help text in `src/cli.js`, `README.md`, `SKILL.md`, and the help-output tests together.
- Machine-readable output goes through `--json`; human status messages go to stderr, results to stdout.
