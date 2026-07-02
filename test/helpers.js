import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.join(__dirname, '..', 'bin', 'linkedin.js');

/** Spawn the CLI exactly as an end user would run it. */
export function runCli(args, { env = {}, input = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Spawn the CLI and return handles for interacting with it while it runs
 * (used for the OAuth login flow, which blocks on the browser callback).
 */
export function spawnCli(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (output.stdout += d));
  child.stderr.on('data', (d) => (output.stderr += d));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, ...output })));
  return { child, output, done };
}

export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function makeTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-cli-test-'));
}

/** Minimal but valid 1x1 red PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

/** Fake MP4: just enough bytes with an ftyp box; the mock only stores bytes. */
export const TINY_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

export function writeFixtures(dir) {
  const img1 = path.join(dir, 'photo-one.png');
  const img2 = path.join(dir, 'photo-two.png');
  const vid = path.join(dir, 'clip.mp4');
  fs.writeFileSync(img1, TINY_PNG);
  fs.writeFileSync(img2, TINY_PNG);
  fs.writeFileSync(vid, TINY_MP4);
  return { img1, img2, vid };
}

/** Standard env pointing the CLI at a mock server + isolated config dir. */
export function cliEnv(mock, configDir, extra = {}) {
  const env = {
    LINKEDIN_API_BASE: mock.base,
    LINKEDIN_OAUTH_BASE: mock.base,
    LINKEDIN_CLI_CONFIG_DIR: configDir,
    ...extra,
  };
  // Ensure ambient credentials on the host machine can't leak into tests.
  env.LINKEDIN_ACCESS_TOKEN = extra.LINKEDIN_ACCESS_TOKEN ?? '';
  env.LINKEDIN_PERSON_URN = extra.LINKEDIN_PERSON_URN ?? '';
  env.LINKEDIN_CLIENT_ID = extra.LINKEDIN_CLIENT_ID ?? '';
  env.LINKEDIN_CLIENT_SECRET = extra.LINKEDIN_CLIENT_SECRET ?? '';
  return env;
}
