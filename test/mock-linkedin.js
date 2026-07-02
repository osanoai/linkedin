import http from 'node:http';
import crypto from 'node:crypto';

/**
 * A local stand-in for LinkedIn's OAuth + REST APIs, faithful to the
 * documented contracts the CLI depends on:
 *
 *   GET  /oauth/v2/authorization        -> 302 to redirect_uri with code+state
 *   POST /oauth/v2/accessToken          -> token exchange (form-encoded)
 *   GET  /v2/userinfo                   -> OpenID userinfo { sub, name }
 *   GET  /v2/me                         -> legacy profile { id }
 *   POST /v2/assets?action=registerUpload -> { value: { uploadMechanism..., asset } }
 *   PUT  /mediaUpload/:id               -> binary upload sink
 *   POST /v2/ugcPosts                   -> 201 + X-RestLi-Id header
 *
 * Recognized bearer tokens: state.validTokens (default ['mock-access-token']).
 * A token of 'expired-token' always yields 401 from API endpoints.
 */
export async function startMockLinkedIn() {
  const state = {
    validTokens: new Set(['mock-access-token']),
    authCodes: new Map(), // code -> { clientId, redirectUri, scope }
    tokenRequests: [],
    authorizationRequests: [],
    registerUploadRequests: [],
    uploads: new Map(), // uploadId -> { bytes, contentType, auth }
    posts: [],
    userinfoCalls: 0,
    sub: 'MOCKSUB123',
    memberName: 'Mocky McMockface',
    nextAssetId: 1,
    nextPostId: 1,
    failNextPost: null, // { status, body }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });

    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };

    const requireAuth = () => {
      if (!bearer || bearer === 'expired-token' || !state.validTokens.has(bearer)) {
        json(401, {
          serviceErrorCode: 65600,
          message: 'Invalid access token',
          status: 401,
        });
        return false;
      }
      return true;
    };

    // --- OAuth: authorization endpoint (simulates the member clicking Allow)
    if (url.pathname === '/oauth/v2/authorization' && req.method === 'GET') {
      const params = Object.fromEntries(url.searchParams);
      state.authorizationRequests.push(params);
      if (params.response_type !== 'code' || !params.client_id || !params.redirect_uri) {
        json(400, { error: 'invalid_request' });
        return;
      }
      const code = 'MOCKCODE-' + crypto.randomBytes(8).toString('hex');
      state.authCodes.set(code, {
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        scope: params.scope,
      });
      const target = new URL(params.redirect_uri);
      target.searchParams.set('code', code);
      if (params.state) target.searchParams.set('state', params.state);
      res.writeHead(302, { Location: target.toString() });
      res.end();
      return;
    }

    // --- OAuth: token exchange
    if (url.pathname === '/oauth/v2/accessToken' && req.method === 'POST') {
      const body = (await readBody()).toString('utf8');
      const params = Object.fromEntries(new URLSearchParams(body));
      state.tokenRequests.push({ params, contentType: req.headers['content-type'] });
      const issued = state.authCodes.get(params.code);
      if (
        params.grant_type !== 'authorization_code' ||
        !issued ||
        issued.clientId !== params.client_id ||
        issued.redirectUri !== params.redirect_uri ||
        !params.client_secret
      ) {
        json(400, { error: 'invalid_request', error_description: 'Unable to retrieve access token' });
        return;
      }
      state.authCodes.delete(params.code);
      const token = 'mock-access-token';
      state.validTokens.add(token);
      json(200, {
        access_token: token,
        expires_in: 5184000,
        scope: issued.scope,
      });
      return;
    }

    // --- OpenID userinfo
    if (url.pathname === '/v2/userinfo' && req.method === 'GET') {
      if (!requireAuth()) return;
      state.userinfoCalls++;
      json(200, {
        sub: state.sub,
        name: state.memberName,
        given_name: 'Mocky',
        family_name: 'McMockface',
        locale: { country: 'US', language: 'en' },
      });
      return;
    }

    // --- Legacy profile
    if (url.pathname === '/v2/me' && req.method === 'GET') {
      if (!requireAuth()) return;
      json(200, { id: state.sub, localizedFirstName: 'Mocky', localizedLastName: 'McMockface' });
      return;
    }

    // --- Assets: registerUpload
    if (url.pathname === '/v2/assets' && req.method === 'POST') {
      if (!requireAuth()) return;
      if (url.searchParams.get('action') !== 'registerUpload') {
        json(400, { message: 'Unsupported action' });
        return;
      }
      if (req.headers['x-restli-protocol-version'] !== '2.0.0') {
        json(400, { message: 'Missing X-Restli-Protocol-Version: 2.0.0 header' });
        return;
      }
      const body = JSON.parse((await readBody()).toString('utf8'));
      state.registerUploadRequests.push(body);
      const rur = body.registerUploadRequest;
      const validRecipes = [
        'urn:li:digitalmediaRecipe:feedshare-image',
        'urn:li:digitalmediaRecipe:feedshare-video',
      ];
      if (
        !rur ||
        !Array.isArray(rur.recipes) ||
        !rur.recipes.every((r) => validRecipes.includes(r)) ||
        !rur.owner ||
        !Array.isArray(rur.serviceRelationships)
      ) {
        json(400, { message: 'Invalid registerUploadRequest' });
        return;
      }
      const id = `MOCKASSET${state.nextAssetId++}`;
      const base = `http://127.0.0.1:${server.address().port}`;
      json(200, {
        value: {
          uploadMechanism: {
            'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
              headers: {},
              uploadUrl: `${base}/mediaUpload/${id}`,
            },
          },
          mediaArtifact: `urn:li:digitalmediaMediaArtifact:(urn:li:digitalmediaAsset:${id},urn:li:digitalmediaMediaArtifactClass:feedshare-uploadedImage)`,
          asset: `urn:li:digitalmediaAsset:${id}`,
        },
      });
      return;
    }

    // --- Binary upload sink
    if (url.pathname.startsWith('/mediaUpload/') && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAuth()) return;
      const id = url.pathname.split('/').pop();
      const bytes = await readBody();
      state.uploads.set(id, {
        bytes,
        contentType: req.headers['content-type'] || null,
      });
      res.writeHead(201);
      res.end();
      return;
    }

    // --- UGC Posts
    if (url.pathname === '/v2/ugcPosts' && req.method === 'POST') {
      if (!requireAuth()) return;
      if (req.headers['x-restli-protocol-version'] !== '2.0.0') {
        json(400, { message: 'Missing X-Restli-Protocol-Version: 2.0.0 header' });
        return;
      }
      if (state.failNextPost) {
        const { status, body } = state.failNextPost;
        state.failNextPost = null;
        json(status, body);
        return;
      }
      const body = JSON.parse((await readBody()).toString('utf8'));
      const errors = validateUgcPost(body, state);
      if (errors.length) {
        json(422, { message: `Invalid ugcPost: ${errors.join('; ')}` });
        return;
      }
      state.posts.push(body);
      const urn = `urn:li:share:${6000000000 + state.nextPostId++}`;
      json(201, {}, { 'X-RestLi-Id': urn });
      return;
    }

    json(404, { message: `Mock LinkedIn: no route for ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Structural validation mirroring the documented ugcPosts schema. */
function validateUgcPost(body, state) {
  const errors = [];
  if (!body.author || !/^urn:li:person:/.test(body.author)) errors.push('author must be a person URN');
  if (body.author !== `urn:li:person:${state.sub}`) errors.push('author does not match the token owner');
  if (body.lifecycleState !== 'PUBLISHED') errors.push('lifecycleState must be PUBLISHED');
  const vis = body.visibility?.['com.linkedin.ugc.MemberNetworkVisibility'];
  if (!['PUBLIC', 'CONNECTIONS'].includes(vis)) errors.push('invalid visibility');
  const content = body.specificContent?.['com.linkedin.ugc.ShareContent'];
  if (!content) {
    errors.push('missing com.linkedin.ugc.ShareContent');
    return errors;
  }
  if (typeof content.shareCommentary?.text !== 'string') errors.push('missing shareCommentary.text');
  if (content.shareCommentary?.text?.length > 3000) errors.push('commentary too long');
  const cat = content.shareMediaCategory;
  if (!['NONE', 'ARTICLE', 'IMAGE', 'VIDEO'].includes(cat)) errors.push(`invalid shareMediaCategory ${cat}`);
  if (cat === 'NONE' && content.media?.length) errors.push('NONE posts must not include media');
  if (cat === 'ARTICLE') {
    if (!content.media?.length || !content.media[0].originalUrl) errors.push('ARTICLE requires media[0].originalUrl');
  }
  if (cat === 'IMAGE' || cat === 'VIDEO') {
    if (!content.media?.length) errors.push(`${cat} requires media entries`);
    for (const m of content.media || []) {
      if (m.status !== 'READY') errors.push('media.status must be READY');
      if (!/^urn:li:digitalmediaAsset:/.test(m.media || '')) errors.push('media.media must be an asset URN');
      const id = (m.media || '').split(':').pop();
      if (!state.uploads.has(id)) errors.push(`asset ${id} was never uploaded`);
    }
  }
  for (const attr of content.shareCommentary?.attributes || []) {
    if (typeof attr.start !== 'number' || typeof attr.length !== 'number' || !attr.value) {
      errors.push('invalid mention attribute');
      continue;
    }
    const text = content.shareCommentary.text;
    if (attr.start < 0 || attr.start + attr.length > text.length) errors.push('mention range out of bounds');
  }
  return errors;
}
