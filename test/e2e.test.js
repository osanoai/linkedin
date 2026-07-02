import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLinkedIn } from './mock-linkedin.js';
import {
  runCli,
  spawnCli,
  waitFor,
  getFreePort,
  makeTempConfigDir,
  writeFixtures,
  cliEnv,
  TINY_PNG,
  TINY_MP4,
} from './helpers.js';

let mock;
test.before(async () => {
  mock = await startMockLinkedIn();
});
test.after(async () => {
  await mock.close();
});

function freshEnv(extra = {}) {
  return cliEnv(mock, makeTempConfigDir(), extra);
}

/** Env with a pre-seeded valid token + person URN (headless agent style). */
function authedEnv(extra = {}) {
  return freshEnv({
    LINKEDIN_ACCESS_TOKEN: 'mock-access-token',
    LINKEDIN_PERSON_URN: `urn:li:person:${mock.state.sub}`,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

test('--help prints usage covering all commands, env vars, and exit codes', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  for (const expected of [
    'auth login',
    'auth token',
    'auth status',
    'auth logout',
    'post',
    'whoami',
    'LINKEDIN_ACCESS_TOKEN',
    'LINKEDIN_CLIENT_ID',
    'EXIT CODES',
    'EXAMPLES',
    'urn:li:person:',
    'urn:li:organization:',
  ]) {
    assert.ok(stdout.includes(expected), `root help should mention "${expected}"`);
  }
});

test('post --help documents text, media, mentions, visibility, dry-run, json', async () => {
  const { code, stdout } = await runCli(['post', '--help']);
  assert.equal(code, 0);
  for (const expected of [
    '--text',
    '--text-file',
    '--image',
    '--alt',
    '--video',
    '--article',
    '--article-title',
    '--visibility',
    '--dry-run',
    '--json',
    '@[Display Name](urn:li:person:MEMBER_ID)',
    'urn:li:organization:',
    '3000',
  ]) {
    assert.ok(stdout.includes(expected), `post help should mention "${expected}"`);
  }
});

test('auth --help documents login, token, status, logout', async () => {
  const { code, stdout } = await runCli(['auth', '--help']);
  assert.equal(code, 0);
  for (const expected of ['--client-id', '--client-secret', '--port', '--scopes', '--no-browser', '--person-urn']) {
    assert.ok(stdout.includes(expected), `auth help should mention "${expected}"`);
  }
});

test('--version prints the package version', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { code, stdout } = await runCli(['--version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test('bare invocation prints help and exits 2; unknown command exits 2', async () => {
  const bare = await runCli([]);
  assert.equal(bare.code, 2);
  assert.ok(bare.stdout.includes('USAGE'));
  const unknown = await runCli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command/);
});

// ---------------------------------------------------------------------------
// Auth: full browser OAuth flow (simulated end-to-end)
// ---------------------------------------------------------------------------

test('auth login completes the full 3-legged OAuth flow and stores credentials', async () => {
  const configDir = makeTempConfigDir();
  const port = await getFreePort();
  const env = cliEnv(mock, configDir);

  const { output, done } = spawnCli(
    [
      'auth',
      'login',
      '--client-id',
      'test-client-id',
      '--client-secret',
      'test-client-secret',
      '--port',
      String(port),
      '--timeout',
      '20',
      '--no-browser',
    ],
    { env }
  );

  // The CLI prints the authorization URL; play the part of the member's browser.
  const authUrl = await waitFor(
    () => output.stderr.match(/https?:\/\/[^\s]+\/oauth\/v2\/authorization\?[^\s]+/)?.[0],
    { label: 'authorization URL in CLI output' }
  );
  const parsedAuthUrl = new URL(authUrl);
  assert.equal(parsedAuthUrl.searchParams.get('response_type'), 'code');
  assert.equal(parsedAuthUrl.searchParams.get('client_id'), 'test-client-id');
  assert.equal(parsedAuthUrl.searchParams.get('redirect_uri'), `http://localhost:${port}/callback`);
  assert.equal(parsedAuthUrl.searchParams.get('scope'), 'openid profile w_member_social');
  assert.ok(parsedAuthUrl.searchParams.get('state'));

  // "Browser" hits LinkedIn's authorize page, gets redirected to the CLI's
  // loopback server, which exchanges the code for a token.
  const authorize = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const callback = await fetch(authorize.headers.get('location'));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Authenticated with LinkedIn/);

  const result = await done;
  assert.equal(result.code, 0, `login should exit 0. stderr: ${result.stderr}`);
  assert.match(result.stdout, /Authenticated as Mocky McMockface \(urn:li:person:MOCKSUB123\)/);

  // Credentials were persisted with restrictive permissions.
  const credsPath = path.join(configDir, 'credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  assert.equal(creds.access_token, 'mock-access-token');
  assert.equal(creds.person_urn, 'urn:li:person:MOCKSUB123');
  assert.ok(creds.expires_at);
  assert.equal(fs.statSync(credsPath).mode & 0o777, 0o600);

  // Token exchange used the documented form-encoded parameters.
  const tokenReq = mock.state.tokenRequests.at(-1);
  assert.match(tokenReq.contentType, /application\/x-www-form-urlencoded/);
  assert.equal(tokenReq.params.grant_type, 'authorization_code');
  assert.equal(tokenReq.params.client_id, 'test-client-id');
  assert.equal(tokenReq.params.client_secret, 'test-client-secret');
  assert.equal(tokenReq.params.redirect_uri, `http://localhost:${port}/callback`);

  // auth status now reports authenticated (exit 0), and the stored token posts.
  const status = await runCli(['auth', 'status', '--json'], { env });
  assert.equal(status.code, 0);
  const st = JSON.parse(status.stdout);
  assert.equal(st.authenticated, true);
  assert.equal(st.person_urn, 'urn:li:person:MOCKSUB123');

  const post = await runCli(['post', 'Posting with credentials from the OAuth flow'], { env });
  assert.equal(post.code, 0, post.stderr);
  assert.match(post.stdout, /urn:li:share:\d+/);

  // logout deletes credentials and status flips to exit 3.
  const logout = await runCli(['auth', 'logout'], { env });
  assert.equal(logout.code, 0);
  assert.ok(!fs.existsSync(credsPath));
  const statusAfter = await runCli(['auth', 'status'], { env });
  assert.equal(statusAfter.code, 3);
  assert.match(statusAfter.stdout, /Not authenticated/);
});

test('auth login rejects a callback with a tampered state (CSRF guard)', async () => {
  const configDir = makeTempConfigDir();
  const port = await getFreePort();
  const env = cliEnv(mock, configDir);
  const { output, done } = spawnCli(
    ['auth', 'login', '--client-id', 'c', '--client-secret', 's', '--port', String(port), '--timeout', '20', '--no-browser'],
    { env }
  );
  await waitFor(() => output.stderr.includes('/oauth/v2/authorization?'), { label: 'auth URL' });
  const evil = await fetch(`http://127.0.0.1:${port}/callback?code=STOLEN&state=wrong-state`);
  assert.equal(evil.status, 401);
  const result = await done;
  assert.equal(result.code, 3);
  assert.match(result.stderr, /state mismatch/i);
  assert.ok(!fs.existsSync(path.join(configDir, 'credentials.json')));
});

test('auth login without app credentials is a usage error with guidance', async () => {
  const { code, stderr } = await runCli(['auth', 'login'], { env: freshEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /--client-id/);
  assert.match(stderr, /developers/);
});

// ---------------------------------------------------------------------------
// Auth: manual token path (the agent-friendly path)
// ---------------------------------------------------------------------------

test('auth token verifies the token, resolves the person URN, and enables posting', async () => {
  const configDir = makeTempConfigDir();
  const env = cliEnv(mock, configDir);
  const res = await runCli(['auth', 'token', 'mock-access-token'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /urn:li:person:MOCKSUB123/);

  const whoami = await runCli(['whoami', '--json'], { env });
  assert.equal(whoami.code, 0);
  const who = JSON.parse(whoami.stdout);
  assert.equal(who.person_urn, 'urn:li:person:MOCKSUB123');
  assert.equal(who.name, 'Mocky McMockface');

  const post = await runCli(['post', 'Posting via stored manual token'], { env });
  assert.equal(post.code, 0, post.stderr);
});

test('auth token rejects an invalid token with exit code 3', async () => {
  const { code, stderr } = await runCli(['auth', 'token', 'not-a-real-token'], { env: freshEnv() });
  assert.equal(code, 3);
  assert.match(stderr, /401/);
});

test('LINKEDIN_ACCESS_TOKEN env var authenticates without any stored credentials', async () => {
  const env = authedEnv();
  const status = await runCli(['auth', 'status', '--json'], { env });
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).source, 'env');
  const post = await runCli(['post', 'Fully headless post'], { env });
  assert.equal(post.code, 0, post.stderr);
});

// ---------------------------------------------------------------------------
// Posting: text, article, images, video, mentions, visibility
// ---------------------------------------------------------------------------

test('text post sends the documented ugcPosts payload and prints URN + URL', async () => {
  const before = mock.state.posts.length;
  const { code, stdout } = await runCli(['post', 'Hello World! This is my first Share on LinkedIn!', '--json'], {
    env: authedEnv(),
  });
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.match(result.urn, /^urn:li:share:\d+$/);
  assert.equal(result.url, `https://www.linkedin.com/feed/update/${result.urn}/`);

  const posted = mock.state.posts.at(-1);
  assert.equal(mock.state.posts.length, before + 1);
  assert.deepEqual(posted, {
    author: 'urn:li:person:MOCKSUB123',
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: 'Hello World! This is my first Share on LinkedIn!' },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });
});

test('article post includes originalUrl, title, and description', async () => {
  const { code } = await runCli(
    [
      'post',
      'Learning more about LinkedIn by reading the LinkedIn Blog!',
      '--article',
      'https://blog.linkedin.com/',
      '--article-title',
      'Official LinkedIn Blog',
      '--article-description',
      'Your source for insights about LinkedIn.',
    ],
    { env: authedEnv() }
  );
  assert.equal(code, 0);
  const content = mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'];
  assert.equal(content.shareMediaCategory, 'ARTICLE');
  assert.deepEqual(content.media, [
    {
      status: 'READY',
      originalUrl: 'https://blog.linkedin.com/',
      title: { text: 'Official LinkedIn Blog' },
      description: { text: 'Your source for insights about LinkedIn.' },
    },
  ]);
});

test('image post registers, uploads the exact bytes, and references the asset URNs', async () => {
  const configDir = makeTempConfigDir();
  const { img1, img2 } = writeFixtures(configDir);
  const env = authedEnv({ LINKEDIN_CLI_CONFIG_DIR: configDir });

  const { code, stdout } = await runCli(
    [
      'post',
      'Two pictures from the offsite',
      '--image', img1, '--alt', 'Keynote stage', '--image-title', 'Day one',
      '--image', img2, '--alt', 'Panel discussion',
      '--json',
    ],
    { env }
  );
  assert.equal(code, 0, stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.uploads.length, 2);

  // registerUpload used the feedshare-image recipe and the right owner.
  const reg = mock.state.registerUploadRequests.at(-1).registerUploadRequest;
  assert.deepEqual(reg.recipes, ['urn:li:digitalmediaRecipe:feedshare-image']);
  assert.equal(reg.owner, 'urn:li:person:MOCKSUB123');
  assert.deepEqual(reg.serviceRelationships, [
    { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
  ]);

  // The uploaded binaries are byte-identical to the source files.
  for (const upload of result.uploads) {
    const assetId = upload.asset.split(':').pop();
    const stored = mock.state.uploads.get(assetId);
    assert.ok(stored, `mock should have received upload for ${assetId}`);
    assert.deepEqual(stored.bytes, TINY_PNG);
    assert.equal(stored.contentType, 'image/png');
  }

  // The share references both assets with alt text and title mapped through.
  const content = mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'];
  assert.equal(content.shareMediaCategory, 'IMAGE');
  assert.equal(content.media.length, 2);
  assert.equal(content.media[0].media, result.uploads[0].asset);
  assert.deepEqual(content.media[0].description, { text: 'Keynote stage' });
  assert.deepEqual(content.media[0].title, { text: 'Day one' });
  assert.deepEqual(content.media[1].description, { text: 'Panel discussion' });
  assert.equal(content.media[1].title, undefined);
});

test('video post uses the feedshare-video recipe and VIDEO category', async () => {
  const configDir = makeTempConfigDir();
  const { vid } = writeFixtures(configDir);
  const env = authedEnv({ LINKEDIN_CLI_CONFIG_DIR: configDir });

  const { code } = await runCli(
    ['post', 'Demo of the new feature', '--video', vid, '--video-title', 'Feature demo'],
    { env }
  );
  assert.equal(code, 0);
  const reg = mock.state.registerUploadRequests.at(-1).registerUploadRequest;
  assert.deepEqual(reg.recipes, ['urn:li:digitalmediaRecipe:feedshare-video']);

  const content = mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'];
  assert.equal(content.shareMediaCategory, 'VIDEO');
  assert.equal(content.media.length, 1);
  assert.deepEqual(content.media[0].title, { text: 'Feature demo' });
  const assetId = content.media[0].media.split(':').pop();
  assert.deepEqual(mock.state.uploads.get(assetId).bytes, TINY_MP4);
  assert.equal(mock.state.uploads.get(assetId).contentType, 'video/mp4');
});

test('mentions produce correct attribute ranges for members and organizations', async () => {
  const { code } = await runCli(
    ['post', 'Huge thanks to @[Jane Doe](urn:li:person:JANE99) and the team at @[Osano](urn:li:organization:17959845)!'],
    { env: authedEnv() }
  );
  assert.equal(code, 0);
  const commentary = mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'].shareCommentary;
  assert.equal(commentary.text, 'Huge thanks to Jane Doe and the team at Osano!');
  assert.deepEqual(commentary.attributes, [
    {
      start: 15,
      length: 8,
      value: { 'com.linkedin.common.MemberAttributedEntity': { member: 'urn:li:person:JANE99' } },
    },
    {
      start: 40,
      length: 5,
      value: { 'com.linkedin.common.CompanyAttributedEntity': { company: 'urn:li:organization:17959845' } },
    },
  ]);
  // Sanity: the ranges point at the right substrings.
  assert.equal(commentary.text.slice(15, 15 + 8), 'Jane Doe');
  assert.equal(commentary.text.slice(40, 40 + 5), 'Osano');
});

test('legacy urn:li:company: mentions are normalized to organization URNs', async () => {
  const { code } = await runCli(['post', 'Hi @[Acme](urn:li:company:123)'], { env: authedEnv() });
  assert.equal(code, 0);
  const commentary = mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'].shareCommentary;
  assert.deepEqual(commentary.attributes[0].value, {
    'com.linkedin.common.CompanyAttributedEntity': { company: 'urn:li:organization:123' },
  });
});

test('--visibility connections maps to CONNECTIONS', async () => {
  const { code } = await runCli(['post', 'Inner circle only', '--visibility', 'connections'], {
    env: authedEnv(),
  });
  assert.equal(code, 0);
  assert.equal(
    mock.state.posts.at(-1).visibility['com.linkedin.ugc.MemberNetworkVisibility'],
    'CONNECTIONS'
  );
});

test('post text can be piped via stdin with --text-file -', async () => {
  const { code } = await runCli(['post', '--text-file', '-'], {
    env: authedEnv(),
    input: 'Text delivered over stdin\n',
  });
  assert.equal(code, 0);
  assert.equal(
    mock.state.posts.at(-1).specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text,
    'Text delivered over stdin'
  );
});

test('--dry-run prints the payload and makes zero network calls', async () => {
  const configDir = makeTempConfigDir();
  const { img1 } = writeFixtures(configDir);
  const postsBefore = mock.state.posts.length;
  const uploadsBefore = mock.state.uploads.size;
  const { code, stdout } = await runCli(
    ['post', 'Testing @[Jane](urn:li:person:J1)', '--image', img1, '--dry-run', '--json'],
    { env: authedEnv({ LINKEDIN_CLI_CONFIG_DIR: configDir }) }
  );
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.dry_run, true);
  assert.deepEqual(out.would_upload, [img1]);
  assert.equal(out.payload.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory, 'IMAGE');
  assert.equal(out.payload.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text, 'Testing Jane');
  assert.equal(mock.state.posts.length, postsBefore);
  assert.equal(mock.state.uploads.size, uploadsBefore);
});

// ---------------------------------------------------------------------------
// Error handling & exit codes
// ---------------------------------------------------------------------------

test('posting without any credentials fails with exit 3 and actionable guidance', async () => {
  const { code, stderr } = await runCli(['post', 'hello'], { env: freshEnv() });
  assert.equal(code, 3);
  assert.match(stderr, /auth login/);
  assert.match(stderr, /LINKEDIN_ACCESS_TOKEN/);
});

test('a rejected token at post time fails with exit 3', async () => {
  const { code, stderr } = await runCli(['post', 'hello'], {
    env: authedEnv({ LINKEDIN_ACCESS_TOKEN: 'expired-token' }),
  });
  assert.equal(code, 3);
  assert.match(stderr, /401/);
});

test('an expired stored token fails with exit 3 before any network call', async () => {
  const configDir = makeTempConfigDir();
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({
      access_token: 'mock-access-token',
      person_urn: 'urn:li:person:MOCKSUB123',
      expires_at: '2020-01-01T00:00:00.000Z',
    })
  );
  const { code, stderr } = await runCli(['post', 'hello'], { env: cliEnv(mock, configDir) });
  assert.equal(code, 3);
  assert.match(stderr, /expired/);
});

test('mixing media kinds is a usage error (exit 2)', async () => {
  const configDir = makeTempConfigDir();
  const { img1, vid } = writeFixtures(configDir);
  const cases = [
    ['post', 'x', '--image', img1, '--video', vid],
    ['post', 'x', '--image', img1, '--article', 'https://example.com'],
    ['post', 'x', '--video', vid, '--article', 'https://example.com'],
  ];
  for (const args of cases) {
    const { code, stderr } = await runCli(args, { env: authedEnv({ LINKEDIN_CLI_CONFIG_DIR: configDir }) });
    assert.equal(code, 2, `expected usage error for: ${args.join(' ')}`);
    assert.match(stderr, /one media kind/);
  }
});

test('missing text, bad visibility, unknown flags, and missing files are usage errors', async () => {
  const env = authedEnv();
  const noText = await runCli(['post'], { env });
  assert.equal(noText.code, 2);
  assert.match(noText.stderr, /text is required/i);

  const badVis = await runCli(['post', 'x', '--visibility', 'everyone'], { env });
  assert.equal(badVis.code, 2);
  assert.match(badVis.stderr, /public.*connections|connections.*public/);

  const badFlag = await runCli(['post', 'x', '--imagee', 'a.png'], { env });
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /Unknown option/);

  const missingFile = await runCli(['post', 'x', '--image', '/nope/definitely-missing.png'], { env });
  assert.equal(missingFile.code, 2);
  assert.match(missingFile.stderr, /not found/);

  const badUrl = await runCli(['post', 'x', '--article', 'not-a-url'], { env });
  assert.equal(badUrl.code, 2);
  assert.match(badUrl.stderr, /http/);
});

test('text longer than 3000 characters is rejected client-side', async () => {
  const { code, stderr } = await runCli(['post', 'a'.repeat(3001)], { env: authedEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /3000/);
});

test('unsupported mention URN types are rejected with guidance', async () => {
  const { code, stderr } = await runCli(['post', 'Hey @[Thing](urn:li:job:55)'], { env: authedEnv() });
  assert.equal(code, 2);
  assert.match(stderr, /urn:li:person/);
});

test('API failures surface LinkedIn error details with exit 1', async () => {
  mock.state.failNextPost = { status: 422, body: { message: 'Duplicate post detected' } };
  const { code, stderr } = await runCli(['post', 'dup'], { env: authedEnv() });
  assert.equal(code, 1);
  assert.match(stderr, /422/);
  assert.match(stderr, /Duplicate post detected/);
});
