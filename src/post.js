import fs from 'node:fs';
import { parseMentions } from './mentions.js';
import { registerUpload, uploadBinary, createPost, resolvePersonUrn } from './api.js';
import { resolveToken, tokenIsExpired } from './config.js';
import { AuthError, UsageError } from './errors.js';

export const MAX_TEXT_LENGTH = 3000;
export const MAX_IMAGES = 9;

const VISIBILITY_MAP = { public: 'PUBLIC', connections: 'CONNECTIONS' };

/** Validate post options and normalize them. Throws UsageError on bad input. */
export function validatePostOptions(opts) {
  const kinds = [
    opts.images.length > 0 ? 'image' : null,
    opts.video ? 'video' : null,
    opts.article ? 'article' : null,
  ].filter(Boolean);
  if (kinds.length > 1) {
    throw new UsageError(
      `A post can attach only one media kind at a time; you combined: ${kinds.join(' + ')}. ` +
        'Use --image (repeatable), OR --video, OR --article.'
    );
  }
  if (opts.images.length > MAX_IMAGES) {
    throw new UsageError(`Too many images (${opts.images.length}); LinkedIn allows at most ${MAX_IMAGES} per post.`);
  }
  if (!opts.text || !opts.text.trim()) {
    throw new UsageError('Post text is required. Pass it as a positional argument, --text, or --text-file.');
  }
  const visibility = VISIBILITY_MAP[(opts.visibility || 'public').toLowerCase()];
  if (!visibility) {
    throw new UsageError(`Invalid --visibility "${opts.visibility}". Use "public" or "connections".`);
  }
  for (const img of opts.images) {
    if (!fs.existsSync(img.path)) throw new UsageError(`Image file not found: ${img.path}`);
  }
  if (opts.video && !fs.existsSync(opts.video.path)) {
    throw new UsageError(`Video file not found: ${opts.video.path}`);
  }
  if (opts.article) {
    try {
      const u = new URL(opts.article.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    } catch {
      throw new UsageError(`--article must be a valid http(s) URL, got: ${opts.article.url}`);
    }
  }
  return { ...opts, visibility, kind: kinds[0] || 'text' };
}

function textEntity(text) {
  return text == null ? undefined : { text };
}

/** Build the ugcPosts request body. mediaAssets: [{asset, title?, description?}] */
export function buildPostPayload({ authorUrn, text, attributes, visibility, kind, article, mediaAssets }) {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new UsageError(
      `Post text is ${text.length} characters after resolving mentions; LinkedIn allows at most ${MAX_TEXT_LENGTH}.`
    );
  }
  const shareContent = {
    shareCommentary: attributes.length ? { text, attributes } : { text },
    shareMediaCategory: kind === 'image' ? 'IMAGE' : kind === 'video' ? 'VIDEO' : kind === 'article' ? 'ARTICLE' : 'NONE',
  };
  if (kind === 'article') {
    shareContent.media = [
      {
        status: 'READY',
        originalUrl: article.url,
        ...(article.title ? { title: textEntity(article.title) } : {}),
        ...(article.description ? { description: textEntity(article.description) } : {}),
      },
    ];
  } else if (kind === 'image' || kind === 'video') {
    shareContent.media = mediaAssets.map((m) => ({
      status: 'READY',
      media: m.asset,
      ...(m.title ? { title: textEntity(m.title) } : {}),
      ...(m.description ? { description: textEntity(m.description) } : {}),
    }));
  }
  return {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
  };
}

export function postUrl(urn) {
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

/**
 * End-to-end post pipeline: resolve auth, parse mentions, upload media,
 * create the share. Returns { urn, url, payload, uploads }.
 */
export async function runPost(rawOpts, out = console) {
  const opts = validatePostOptions(rawOpts);
  const { text, attributes } = parseMentions(opts.text);

  const resolved = resolveToken();
  let authorUrn = process.env.LINKEDIN_PERSON_URN || resolved?.creds?.person_urn || null;

  if (opts.dryRun) {
    const fakeAssets = [
      ...opts.images.map((img, i) => ({
        asset: `urn:li:digitalmediaAsset:DRY-RUN-IMAGE-${i + 1}`,
        title: img.title,
        description: img.alt,
        file: img.path,
      })),
      ...(opts.video
        ? [{ asset: 'urn:li:digitalmediaAsset:DRY-RUN-VIDEO-1', title: opts.video.title, file: opts.video.path }]
        : []),
    ];
    const payload = buildPostPayload({
      authorUrn: authorUrn || 'urn:li:person:DRY-RUN',
      text,
      attributes,
      visibility: opts.visibility,
      kind: opts.kind,
      article: opts.article,
      mediaAssets: fakeAssets,
    });
    return { dryRun: true, payload, uploads: fakeAssets.map((a) => a.file).filter(Boolean) };
  }

  if (!resolved) {
    throw new AuthError(
      'Not authenticated. Run `linkedin auth login`, `linkedin auth token <TOKEN>`, or set LINKEDIN_ACCESS_TOKEN.'
    );
  }
  if (resolved.source === 'file' && tokenIsExpired(resolved.creds)) {
    throw new AuthError(
      `Stored access token expired at ${resolved.creds.expires_at}. Run \`linkedin auth login\` again.`
    );
  }
  const token = resolved.token;

  if (!authorUrn) {
    const who = await resolvePersonUrn(token);
    authorUrn = who.urn;
  }

  // Upload media (images or video) via the Assets API before creating the share.
  const mediaAssets = [];
  const uploads = [];
  const mediaFiles =
    opts.kind === 'image'
      ? opts.images.map((img) => ({ ...img, kind: 'image' }))
      : opts.kind === 'video'
        ? [{ ...opts.video, kind: 'video' }]
        : [];
  for (const file of mediaFiles) {
    out.error(`Uploading ${file.path} ...`);
    const { uploadUrl, asset, headers } = await registerUpload(token, authorUrn, file.kind);
    await uploadBinary(token, uploadUrl, file.path, headers);
    mediaAssets.push({ asset, title: file.title, description: file.alt });
    uploads.push({ file: file.path, asset });
  }

  const payload = buildPostPayload({
    authorUrn,
    text,
    attributes,
    visibility: opts.visibility,
    kind: opts.kind,
    article: opts.article,
    mediaAssets,
  });

  const { urn } = await createPost(token, payload);
  return { urn, url: postUrl(urn), payload, uploads };
}
