import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  oauthBase,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  resolveToken,
  tokenIsExpired,
  credentialsPath,
} from './config.js';
import { resolvePersonUrn } from './api.js';
import { AuthError, UsageError, ApiError } from './errors.js';

export const DEFAULT_SCOPES = 'openid profile w_member_social';
export const DEFAULT_PORT = 8914;

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Non-fatal: the URL is printed for manual use.
  }
}

async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(`${oauthBase()}/oauth/v2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok || !body || !body.access_token) {
    const detail =
      (body && typeof body === 'object' && (body.error_description || body.error)) ||
      (typeof body === 'string' ? body.slice(0, 300) : '');
    throw new AuthError(`Token exchange failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

/**
 * Runs the full 3-legged OAuth flow:
 *  1. Starts a loopback HTTP server on 127.0.0.1:{port}{callbackPath}.
 *  2. Directs the browser to LinkedIn's authorization page.
 *  3. Receives code+state on the callback, exchanges the code for a token.
 *  4. Resolves the member's person URN and saves credentials.
 */
export async function login(opts, out = console) {
  const clientId = opts.clientId || process.env.LINKEDIN_CLIENT_ID || loadCredentials()?.client_id;
  const clientSecret =
    opts.clientSecret || process.env.LINKEDIN_CLIENT_SECRET || loadCredentials()?.client_secret;
  if (!clientId || !clientSecret) {
    throw new UsageError(
      'Missing LinkedIn app credentials. Provide --client-id and --client-secret, or set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.\n' +
        'Create an app at https://www.linkedin.com/developers/apps and add the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products.'
    );
  }

  const port = opts.port || DEFAULT_PORT;
  const callbackPath = '/callback';
  const redirectUri = `http://localhost:${port}${callbackPath}`;
  const state = crypto.randomBytes(16).toString('hex');
  const scopes = opts.scopes || DEFAULT_SCOPES;
  const timeoutMs = (opts.timeout || 300) * 1000;

  const authUrl =
    `${oauthBase()}/oauth/v2/authorization?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes,
    }).toString();

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed</h1><p>You can close this window.</p>');
        cleanup();
        reject(new AuthError(`LinkedIn returned an error: ${error} — ${url.searchParams.get('error_description') || ''}`));
        return;
      }
      if (gotState !== state) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch</h1><p>Possible CSRF; aborting.</p>');
        cleanup();
        reject(new AuthError('OAuth state mismatch — aborting (possible CSRF).'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authenticated with LinkedIn ✔</h1><p>You can close this window and return to the terminal.</p>');
      cleanup();
      resolve(code);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new AuthError(`Timed out after ${timeoutMs / 1000}s waiting for the OAuth callback.`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      server.close();
    }
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new AuthError(`Could not start callback server on port ${port}: ${err.message}`));
    });
    server.listen(port, '127.0.0.1');
  });

  out.error(`Open this URL in your browser to authorize:\n\n  ${authUrl}\n`);
  out.error(`Waiting for LinkedIn to redirect to ${redirectUri} ...`);
  if (!opts.noBrowser) openBrowser(authUrl);

  const code = await codePromise;
  const tokenResponse = await exchangeCodeForToken({ code, clientId, clientSecret, redirectUri });

  const { urn, name } = await resolvePersonUrn(tokenResponse.access_token);

  const creds = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || null,
    scope: tokenResponse.scope || scopes,
    expires_at: tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null,
    person_urn: urn,
    name,
    client_id: clientId,
    client_secret: clientSecret,
    obtained_at: new Date().toISOString(),
  };
  saveCredentials(creds);
  return creds;
}

/**
 * Store a manually supplied access token (e.g. from the LinkedIn Developer
 * Portal token generator). Verifies it and resolves the person URN.
 */
export async function setToken(token, opts = {}) {
  if (!token) {
    throw new UsageError('Provide the access token: linkedin auth token <ACCESS_TOKEN>');
  }
  let urn = opts.personUrn || null;
  let name = null;
  if (!urn) {
    try {
      const resolved = await resolvePersonUrn(token);
      urn = resolved.urn;
      name = resolved.name;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new ApiError(
        `Could not verify the token against /v2/userinfo or /v2/me (${err.message}). ` +
          'If your token lacks profile scopes, pass --person-urn urn:li:person:YOUR_ID explicitly.'
      );
    }
  }
  const creds = {
    access_token: token,
    refresh_token: null,
    scope: null,
    expires_at: opts.expiresIn ? new Date(Date.now() + opts.expiresIn * 1000).toISOString() : null,
    person_urn: urn,
    name,
    obtained_at: new Date().toISOString(),
  };
  saveCredentials(creds);
  return creds;
}

export function logout() {
  deleteCredentials();
}

/** Returns a status object; `authenticated` is false when no usable token exists. */
export function status() {
  const resolved = resolveToken();
  if (!resolved) {
    return { authenticated: false, reason: 'No access token found.', credentials_file: credentialsPath() };
  }
  const { creds, source } = resolved;
  if (source === 'file' && tokenIsExpired(creds)) {
    return {
      authenticated: false,
      reason: `Stored token expired at ${creds.expires_at}. Run \`linkedin auth login\` again.`,
      credentials_file: credentialsPath(),
    };
  }
  return {
    authenticated: true,
    source,
    person_urn: source === 'env' ? process.env.LINKEDIN_PERSON_URN || null : creds.person_urn || null,
    name: creds?.name || null,
    scope: creds?.scope || null,
    expires_at: creds?.expires_at || null,
    credentials_file: source === 'file' ? credentialsPath() : null,
  };
}
