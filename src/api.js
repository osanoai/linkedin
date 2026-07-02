import fs from 'node:fs';
import path from 'node:path';
import { apiBase } from './config.js';
import { ApiError, AuthError } from './errors.js';

const RESTLI_HEADER = { 'X-Restli-Protocol-Version': '2.0.0' };

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};

export function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeApiFailure(action, res, body) {
  const detail =
    (body && typeof body === 'object' && (body.message || body.error_description || body.error)) ||
    (typeof body === 'string' && body.slice(0, 300)) ||
    '';
  return `${action} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
}

async function apiFetch(token, pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...RESTLI_HEADER,
      ...headers,
    },
    body,
  });
  return res;
}

/**
 * Fetch the authenticated member via the OpenID Connect userinfo endpoint.
 * Requires the `openid` scope. Returns { sub, name, ... }.
 */
export async function getUserinfo(token) {
  const res = await apiFetch(token, '/v2/userinfo');
  const body = await readBody(res);
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(describeApiFailure('Fetching your LinkedIn profile (/v2/userinfo)', res, body));
  }
  if (!res.ok) {
    throw new ApiError(describeApiFailure('Fetching your LinkedIn profile (/v2/userinfo)', res, body), res.status, body);
  }
  return body;
}

/** Legacy fallback profile endpoint (r_liteprofile scope). Returns { id, ... }. */
export async function getMe(token) {
  const res = await apiFetch(token, '/v2/me');
  const body = await readBody(res);
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(describeApiFailure('Fetching your LinkedIn profile (/v2/me)', res, body));
  }
  if (!res.ok) {
    throw new ApiError(describeApiFailure('Fetching your LinkedIn profile (/v2/me)', res, body), res.status, body);
  }
  return body;
}

/**
 * Resolve the member's person URN (urn:li:person:xxxx) for the given token.
 * Tries the OpenID userinfo endpoint first, then falls back to /v2/me.
 */
export async function resolvePersonUrn(token) {
  try {
    const info = await getUserinfo(token);
    if (info && info.sub) {
      return { urn: `urn:li:person:${info.sub}`, name: info.name || null };
    }
  } catch (err) {
    // fall through to /v2/me
  }
  const me = await getMe(token);
  if (!me || !me.id) {
    throw new ApiError('Could not determine your LinkedIn person URN from /v2/userinfo or /v2/me.');
  }
  const name =
    me.localizedFirstName || me.localizedLastName
      ? `${me.localizedFirstName || ''} ${me.localizedLastName || ''}`.trim()
      : null;
  return { urn: `urn:li:person:${me.id}`, name };
}

/**
 * Step 1 of media upload: register the upload with the Assets API.
 * kind is 'image' or 'video'. Returns { uploadUrl, asset }.
 */
export async function registerUpload(token, ownerUrn, kind) {
  const recipe =
    kind === 'video'
      ? 'urn:li:digitalmediaRecipe:feedshare-video'
      : 'urn:li:digitalmediaRecipe:feedshare-image';
  const res = await apiFetch(token, '/v2/assets?action=registerUpload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner: ownerUrn,
        serviceRelationships: [
          { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
        ],
      },
    }),
  });
  const body = await readBody(res);
  if (res.status === 401) {
    throw new AuthError(describeApiFailure('Registering media upload', res, body));
  }
  if (!res.ok) {
    throw new ApiError(describeApiFailure('Registering media upload', res, body), res.status, body);
  }
  const mechanism =
    body?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'];
  if (!mechanism?.uploadUrl || !body?.value?.asset) {
    throw new ApiError('Unexpected registerUpload response: missing uploadUrl or asset URN.');
  }
  return { uploadUrl: mechanism.uploadUrl, asset: body.value.asset, headers: mechanism.headers || {} };
}

/** Step 2 of media upload: PUT the binary file to the returned uploadUrl. */
export async function uploadBinary(token, uploadUrl, filePath, extraHeaders = {}) {
  const data = fs.readFileSync(filePath);
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentTypeFor(filePath),
      ...extraHeaders,
    },
    body: data,
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new ApiError(
      describeApiFailure(`Uploading ${path.basename(filePath)}`, res, body),
      res.status,
      body
    );
  }
}

/**
 * Create the share via the UGC Posts API.
 * Returns the new post URN, taken from the X-RestLi-Id response header.
 */
export async function createPost(token, payload) {
  const res = await apiFetch(token, '/v2/ugcPosts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await readBody(res);
  if (res.status === 401) {
    throw new AuthError(
      describeApiFailure('Creating the post', res, body) +
        '\nYour access token is invalid or expired. Run `linkedin auth login` (or set LINKEDIN_ACCESS_TOKEN) and try again.'
    );
  }
  if (res.status === 403) {
    throw new ApiError(
      describeApiFailure('Creating the post', res, body) +
        '\nYour token is missing the w_member_social scope. Add the "Share on LinkedIn" product to your app in the LinkedIn Developer Portal and re-authenticate.',
      res.status,
      body
    );
  }
  if (!res.ok) {
    throw new ApiError(describeApiFailure('Creating the post', res, body), res.status, body);
  }
  const urn = res.headers.get('x-restli-id') || (body && typeof body === 'object' && body.id) || null;
  return { urn, body };
}
