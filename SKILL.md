---
name: linkedin
description: Post to LinkedIn from the command line using the @osanoai/linkedin npm package. Use when asked to publish, share, or draft a LinkedIn post — plain text, a link/article share, image or video posts, or posts that @-mention people or companies. Covers installing the CLI, authenticating (OAuth or access token), and creating posts.
---

# LinkedIn CLI

`linkedin` posts to LinkedIn as the authenticated member. It has exactly two capabilities: authenticating a user, and creating posts (text, article links, images, video, with @-mentions). It cannot read feeds, comment, or delete posts.

## 1. Install

```bash
npm install -g @osanoai/linkedin
linkedin --version   # verify installation
```

Requires Node.js >= 18.17. `linkedin --help` and `linkedin post --help` are accurate and self-contained; consult them for anything not covered here.

## 2. Authenticate

First check whether the user is already authenticated:

```bash
linkedin auth status --json   # exit 0 = authenticated, exit 3 = not
```

If not authenticated, pick the path that fits the situation:

**Path A — access token already available (best for agents).** If the user has a LinkedIn access token (e.g. from the [Developer Portal token generator](https://www.linkedin.com/developers/tools/oauth/token-generator)) with the `w_member_social` scope:

```bash
linkedin auth token THE_ACCESS_TOKEN
```

Or without persisting anything, set env vars per-command:

```bash
LINKEDIN_ACCESS_TOKEN=... linkedin post "..."
```

If the token lacks profile scopes (`openid`/`profile`), also pass `--person-urn urn:li:person:THEIR_ID` to `auth token`, or set `LINKEDIN_PERSON_URN`.

**Path B — browser OAuth flow (needs a human).** Requires the user's LinkedIn Developer app Client ID/Secret, with the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products enabled and `http://localhost:8914/callback` listed as a redirect URL:

```bash
linkedin auth login --client-id XXX --client-secret YYY
```

This opens a browser and blocks until the user approves (default timeout 300s). A human must click **Allow**; do not run this in a fully headless context — use Path A instead. Tokens last ~60 days; when one expires (exit code 3), re-run `auth login`.

Verify identity after authenticating:

```bash
linkedin whoami --json   # {"person_urn": "urn:li:person:...", "name": "..."}
```

## 3. Post

Always quote post text as a single shell argument. Prefer `--json` for parseable output.

```bash
# Plain text
linkedin post "Post text here" --json

# Text from stdin (safest for long/multiline/emoji content)
printf '%s' "$POST_TEXT" | linkedin post --text-file - --json

# Article / link share
linkedin post "Commentary about the link" \
  --article https://example.com/page \
  --article-title "Optional title" \
  --article-description "Optional description" --json

# Images: repeat --image (max 9). --alt and --image-title bind to the PRECEDING --image.
linkedin post "Caption" \
  --image /path/one.jpg --alt "Alt text for one" \
  --image /path/two.png --alt "Alt text for two" --json

# Video (single file, mp4 recommended)
linkedin post "Caption" --video /path/demo.mp4 --video-title "Title" --json

# Visibility: public (default) or connections
linkedin post "For connections only" --visibility connections --json
```

**Mentions** go inline in the text using `@[Display Name](urn)`:

```bash
linkedin post 'Congrats @[Jane Doe](urn:li:person:AbC_123) and @[Osano](urn:li:organization:17959845)!'
```

- Members: `urn:li:person:{id}` — LinkedIn has no public name→URN lookup; only mention people whose URN you (or the user) already know. The user's own URN comes from `whoami`.
- Companies: `urn:li:organization:{id}` (numeric id; `urn:li:company:` also accepted).
- The marker renders as just "Display Name", linked.

**Rules the CLI enforces** (violations exit 2 before any network call): text is required and ≤3000 chars; `--image`/`--video`/`--article` are mutually exclusive; visibility must be `public` or `connections`; files must exist.

**Before posting on a user's behalf:** posting is public and irreversible from this tool. Show the user the exact text first, or use `--dry-run` (prints the full API payload, makes zero network calls) when asked to preview.

## 4. Read results and errors

Success (`--json`): `{"urn": "urn:li:share:...", "url": "https://www.linkedin.com/feed/update/urn:li:share:.../", "uploads": [...]}`. Share the `url` with the user.

Exit codes: `0` success · `1` LinkedIn API error (message includes HTTP status and LinkedIn's detail) · `2` invalid usage · `3` not authenticated / token expired-or-rejected → re-authenticate (section 2).

Common failures:
- `403 ... w_member_social` — the token's app lacks the "Share on LinkedIn" product; the user must add it in the Developer Portal and re-auth.
- `401` on post — token expired or revoked; exit 3; re-authenticate.
- Duplicate-content errors from LinkedIn — change the text; LinkedIn rejects identical repeat posts.
- Rate limit: 150 posts/member/day.

## Environment variables

| Var | Use |
| --- | --- |
| `LINKEDIN_ACCESS_TOKEN` | Token override; beats stored credentials |
| `LINKEDIN_PERSON_URN` | Author URN; skips profile lookup |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | App creds for `auth login` |
| `LINKEDIN_CLI_CONFIG_DIR` | Credential storage dir (default `~/.config/linkedin-cli`) |
