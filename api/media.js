import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// ── Ankor service-account credentials ──────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const COMPANY_URI = process.env.COMPANY_URI;
const KID = process.env.KID;

// ── Auth0 config ────────────────────────────────────────────────────────────
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;   // e.g. "yourtenant.auth0.com"
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE; // e.g. "https://yachts.sinclairyachting.com"

// JWKS is fetched once and cached internally by jose (auto-refreshed on rotation)
const JWKS = AUTH0_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`))
  : null;

async function verifyClientToken(authHeader) {
  if (!JWKS) throw new Error('AUTH0_DOMAIN not configured');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw Object.assign(new Error('No token'), { status: 401 });
  await jwtVerify(token, JWKS, {
    audience: AUTH0_AUDIENCE,
    issuer: `https://${AUTH0_DOMAIN}/`,
  });
}

// ── Ankor token management ──────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;
let inflight = null;

async function mintToken() {
  if (!PRIVATE_KEY || !COMPANY_URI || !KID) {
    throw new Error('Missing PRIVATE_KEY / COMPANY_URI / KID env vars');
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { scopes: ['website:read:*'], iss: COMPANY_URI, aud: 'ankor.io', sub: COMPANY_URI, iat: now, exp: now + 3600 },
    PRIVATE_KEY,
    { algorithm: 'RS256', keyid: KID },
  );
  const res = await fetch('https://api.ankor.io/iam/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const body = await res.json();
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + (body.expires_in || 3600) * 1000;
  return cachedToken;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;
  if (inflight) return inflight;
  inflight = mintToken().finally(() => { inflight = null; });
  return inflight;
}

async function fetchUpstream(upstreamPath, token) {
  return fetch(`https://api.ankor.io/${upstreamPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // 1. Verify the caller's Auth0 JWT
  try {
    await verifyClientToken(req.headers.authorization);
  } catch (err) {
    res.status(err.status || 401).send(err.message || 'Unauthorized');
    return;
  }

  // 2. Proxy to Ankor
  try {
    const pathParam = typeof req.query?.path === 'string' ? req.query.path : '';
    if (!pathParam) {
      res.status(400).send('Missing path parameter');
      return;
    }
    const upstreamPath = pathParam.startsWith('/') ? pathParam.slice(1) : pathParam;

    let token = await getAccessToken();
    let upstream = await fetchUpstream(upstreamPath, token);

    if (upstream.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
      token = await getAccessToken();
      upstream = await fetchUpstream(upstreamPath, token);
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    if (upstream.ok) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    }

    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.status(503).send(`Media proxy error: ${err.message}`);
  }
}
