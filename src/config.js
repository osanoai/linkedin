import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All endpoints are overridable via env vars so the CLI can be pointed at a
 * mock server for e2e testing (LINKEDIN_API_BASE / LINKEDIN_OAUTH_BASE).
 */
export function apiBase() {
  return (process.env.LINKEDIN_API_BASE || 'https://api.linkedin.com').replace(/\/+$/, '');
}

export function oauthBase() {
  return (process.env.LINKEDIN_OAUTH_BASE || 'https://www.linkedin.com').replace(/\/+$/, '');
}

export function configDir() {
  return (
    process.env.LINKEDIN_CLI_CONFIG_DIR ||
    path.join(homedir(), '.config', 'linkedin-cli')
  );
}

export function credentialsPath() {
  return path.join(configDir(), 'credentials.json');
}

export function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function saveCredentials(creds) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function deleteCredentials() {
  fs.rmSync(credentialsPath(), { force: true });
}

/**
 * Resolve the access token to use, in precedence order:
 *   1. LINKEDIN_ACCESS_TOKEN env var (headless/CI/agent friendly)
 *   2. Stored credentials from `auth login` / `auth token`
 * Returns { token, source, creds } or null.
 */
export function resolveToken() {
  const envToken = process.env.LINKEDIN_ACCESS_TOKEN;
  if (envToken) return { token: envToken, source: 'env', creds: null };
  const creds = loadCredentials();
  if (creds && creds.access_token) {
    return { token: creds.access_token, source: 'file', creds };
  }
  return null;
}

export function tokenIsExpired(creds) {
  if (!creds || !creds.expires_at) return false;
  return Date.now() >= new Date(creds.expires_at).getTime();
}
