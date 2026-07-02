# @osanoai/linkedin

A zero-dependency command-line tool for posting to LinkedIn as the authenticated member. It does two things and does them well:

1. **Auth** — LinkedIn OAuth 2.0 (3-legged, browser-based) or direct access-token auth for headless use.
2. **Post** — text posts, article/URL shares, image posts (up to 9 images), video posts, member/company @-mentions, and public/connections visibility.

Built on LinkedIn's documented [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) (UGC Posts + Assets) and [OAuth 2.0](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication?context=linkedin/consumer/context) APIs.

## Install

```bash
npm install -g @osanoai/linkedin
linkedin --help
```

Requires Node.js >= 18.17.

## Prerequisites (one-time LinkedIn app setup)

1. Create an app at <https://www.linkedin.com/developers/apps>.
2. On the **Products** tab, add **Share on LinkedIn** (grants `w_member_social`) and **Sign In with LinkedIn using OpenID Connect** (grants `openid profile`, used to resolve your member URN).
3. For browser login: on the **Auth** tab, add `http://localhost:8914/callback` as an authorized redirect URL (or another port — pass `--port` to match).

## Authenticate

**Option A — browser OAuth flow:**

```bash
linkedin auth login --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
```

Your browser opens LinkedIn's consent page; after you click **Allow**, the CLI captures the callback, exchanges the code for a ~60-day access token, resolves your `urn:li:person:...`, and stores everything in `~/.config/linkedin-cli/credentials.json` (mode 0600). `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` env vars work too.

**Option B — paste a token (headless/CI/agents):**

```bash
# from https://www.linkedin.com/developers/tools/oauth/token-generator
linkedin auth token ACCESS_TOKEN
# or keep it entirely in the environment:
export LINKEDIN_ACCESS_TOKEN=...        # overrides stored credentials
export LINKEDIN_PERSON_URN=urn:li:person:...   # optional; skips profile lookup
```

Check state anytime:

```bash
linkedin auth status   # exit 0 = authenticated, 3 = not
linkedin whoami        # verifies the token against the live API
linkedin auth logout
```

## Post

```bash
# Text
linkedin post "Hello LinkedIn!"

# Article / URL share
linkedin post "Worth a read:" \
  --article https://example.com/report \
  --article-title "2026 Privacy Report" \
  --article-description "Key findings on consent trends."

# Images (repeat --image, up to 9; --alt/--image-title apply to the preceding image)
linkedin post "Highlights from the summit" \
  --image day1.jpg --alt "Keynote stage" \
  --image day2.jpg --alt "Panel discussion"

# Video
linkedin post "Feature demo" --video demo.mp4 --video-title "Demo"

# Mentions — inline anywhere in the text
linkedin post 'Kudos to @[Jane Doe](urn:li:person:AbC_123) and @[Osano](urn:li:organization:17959845)!'

# Connections-only, machine-readable output
linkedin post "Inner circle" --visibility connections --json

# Preview the exact API payload without posting
linkedin post "test" --image pic.png --dry-run
```

On success the CLI prints the post URN and URL:

```
Posted to LinkedIn ✔
URN: urn:li:share:7123456789012345678
URL: https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/
```

### Mention syntax

`@[Display Name](urn)` renders as a real, linked mention. Supported URNs:

- Members: `urn:li:person:{id}` (find your own via `linkedin whoami`)
- Companies/schools: `urn:li:organization:{id}` (`urn:li:company:{id}` is auto-normalized)

LinkedIn offers no public API to look up an arbitrary member's URN by name, so you must already know the URN of anyone you mention.

## Reference

| Env var | Purpose |
| --- | --- |
| `LINKEDIN_ACCESS_TOKEN` | Access token; takes precedence over stored credentials |
| `LINKEDIN_PERSON_URN` | Author URN; skips the profile lookup |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | OAuth app credentials for `auth login` |
| `LINKEDIN_CLI_CONFIG_DIR` | Credentials directory (default `~/.config/linkedin-cli`) |
| `LINKEDIN_API_BASE` / `LINKEDIN_OAUTH_BASE` | Endpoint overrides (used by the e2e tests to target a mock server) |

Exit codes: `0` success · `1` API/runtime error · `2` invalid usage · `3` not authenticated.

Rate limits (LinkedIn-enforced): 150 posts per member per day, 100,000 per app per day.

## Development

```bash
pnpm install --frozen-lockfile
pnpm test   # full e2e suite: real CLI processes against a mock LinkedIn API
```

pnpm is the pinned package manager (`packageManager` in package.json); `.npmrc` enforces a 7-day minimum release age for dependencies. See [AGENTS.md](AGENTS.md) for repo conventions and the CI/CD release flow (merges to main auto-publish to npm with provenance).

The suite in [test/e2e.test.js](test/e2e.test.js) spawns the actual binary and exercises the complete OAuth flow (including CSRF rejection), token auth, every post type, mention annotation ranges, byte-exact media uploads, and all error paths against [test/mock-linkedin.js](test/mock-linkedin.js), which faithfully implements the documented LinkedIn contracts.

## License

MIT
