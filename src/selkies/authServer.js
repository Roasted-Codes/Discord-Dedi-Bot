import crypto from 'crypto';
import http from 'http';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'dedi_selkies_session';
const STATE_COOKIE = 'dedi_selkies_state';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeSignedJson(payload, secret) {
  const value = base64url(JSON.stringify(payload));
  return `${value}.${sign(value, secret)}`;
}

function decodeSignedJson(cookieValue, secret) {
  if (!cookieValue || !cookieValue.includes('.')) return null;
  const [value, signature] = cookieValue.split('.', 2);
  if (sign(value, secret) !== signature) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(value.join('=') || '');
  }
  return cookies;
}

function cookie(name, value, { maxAge = 3600, domain, path = '/', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, 'Secure', 'SameSite=Lax'];
  if (domain) parts.push(`Domain=${domain}`);
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function clearCookie(name, { domain, path = '/' } = {}) {
  const parts = [`${name}=`, `Path=${path}`, 'Max-Age=0', 'Secure', 'SameSite=Lax', 'HttpOnly'];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function redirect(response, location, cookies = []) {
  response.writeHead(302, {
    Location: location,
    ...(cookies.length ? { 'Set-Cookie': cookies } : {})
  });
  response.end();
}

function text(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  response.end(body);
}

function getConfig() {
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || '';
  const guildId = process.env.SELKIES_DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || '';
  const cookieSecret = process.env.SELKIES_AUTH_COOKIE_SECRET || '';
  const publicBaseUrl = (process.env.SELKIES_AUTH_PUBLIC_URL || 'https://auth.dedi.halo2stats.org').replace(/\/+$/g, '');
  const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI || `${publicBaseUrl}/oauth/discord/callback`;
  const cookieDomain = process.env.SELKIES_AUTH_COOKIE_DOMAIN || '.dedi.halo2stats.org';
  const sessionSeconds = Number.parseInt(process.env.SELKIES_AUTH_SESSION_SECONDS || '604800', 10);
  const port = Number.parseInt(process.env.SELKIES_AUTH_PORT || '4181', 10);
  const host = process.env.SELKIES_AUTH_BIND || '127.0.0.1';

  return {
    clientId,
    clientSecret,
    guildId,
    cookieSecret,
    publicBaseUrl,
    redirectUri,
    cookieDomain,
    sessionSeconds: Number.isFinite(sessionSeconds) ? sessionSeconds : 604800,
    port: Number.isFinite(port) ? port : 4181,
    host
  };
}

function requiredConfigMissing(config) {
  return [
    ['DISCORD_OAUTH_CLIENT_ID', config.clientId],
    ['DISCORD_OAUTH_CLIENT_SECRET', config.clientSecret],
    ['DISCORD_GUILD_ID', config.guildId],
    ['SELKIES_AUTH_COOKIE_SECRET', config.cookieSecret]
  ].filter(([, value]) => !value).map(([key]) => key);
}

async function discordFetch(path, token) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Discord ${path} returned ${response.status}`);
  }
  return response.json();
}

async function redeemCode(code, config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    throw new Error(`Discord token exchange returned ${response.status}`);
  }
  return response.json();
}

function getRequestUrl(request, config) {
  const proto = request.headers['x-forwarded-proto'] || 'https';
  const host = request.headers['x-forwarded-host'] || request.headers.host || new URL(config.publicBaseUrl).host;
  return new URL(request.url, `${proto}://${host}`);
}

function sessionFromRequest(request, config) {
  const cookies = parseCookies(request.headers.cookie || '');
  const session = decodeSignedJson(cookies[SESSION_COOKIE], config.cookieSecret);
  if (!session || !session.exp || Date.now() > session.exp) {
    return null;
  }
  return session;
}

async function handleLogin(request, response, config) {
  const url = getRequestUrl(request, config);
  const rd = url.searchParams.get('rd') || `https://${request.headers['x-forwarded-host'] || request.headers.host || ''}/`;
  const statePayload = {
    nonce: crypto.randomBytes(18).toString('base64url'),
    rd,
    exp: Date.now() + (10 * 60 * 1000)
  };
  const state = encodeSignedJson(statePayload, config.cookieSecret);
  const authorize = new URL(`${DISCORD_API}/oauth2/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', config.redirectUri);
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);
  redirect(response, authorize.toString(), [
    cookie(STATE_COOKIE, state, { maxAge: 600, domain: config.cookieDomain })
  ]);
}

async function handleCallback(request, response, config) {
  const url = getRequestUrl(request, config);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request.headers.cookie || '');
  const statePayload = decodeSignedJson(state, config.cookieSecret);
  if (!code || !statePayload || cookies[STATE_COOKIE] !== state || Date.now() > statePayload.exp) {
    return text(response, 400, 'Invalid or expired OAuth state.');
  }

  const token = await redeemCode(code, config);
  const [user, guilds] = await Promise.all([
    discordFetch('/users/@me', token.access_token),
    discordFetch('/users/@me/guilds', token.access_token)
  ]);
  if (!guilds.some(guild => guild.id === config.guildId)) {
    return text(response, 403, 'This Discord account is not allowed to access Dedi Selkies.');
  }

  const session = encodeSignedJson({
    sub: user.id,
    username: user.username || user.global_name || user.id,
    exp: Date.now() + (config.sessionSeconds * 1000)
  }, config.cookieSecret);

  redirect(response, statePayload.rd || '/', [
    cookie(SESSION_COOKIE, session, {
      maxAge: config.sessionSeconds,
      domain: config.cookieDomain
    }),
    clearCookie(STATE_COOKIE, { domain: config.cookieDomain })
  ]);
}

function handleAuth(request, response, config) {
  const session = sessionFromRequest(request, config);
  if (!session) {
    const proto = request.headers['x-forwarded-proto'] || 'https';
    const host = request.headers['x-forwarded-host'] || request.headers.host || '';
    const uri = request.headers['x-forwarded-uri'] || '/';
    const login = new URL(`${config.publicBaseUrl}/login`);
    login.searchParams.set('rd', `${proto}://${host}${uri}`);
    return redirect(response, login.toString());
  }
  return text(response, 202, 'Accepted', {
    'X-Auth-Request-User': session.sub,
    'X-Auth-Request-Preferred-Username': session.username || session.sub
  });
}

function handleLogout(response, config) {
  redirect(response, config.publicBaseUrl, [
    clearCookie(SESSION_COOKIE, { domain: config.cookieDomain }),
    clearCookie(STATE_COOKIE, { domain: config.cookieDomain })
  ]);
}

export function startSelkiesAuthServer() {
  if (process.env.SELKIES_OAUTH_ENABLED !== '1') {
    logger.debug('Selkies OAuth server disabled');
    return null;
  }

  const config = getConfig();
  const missing = requiredConfigMissing(config);
  if (missing.length) {
    logger.warn(`Selkies OAuth server not started; missing ${missing.join(', ')}`);
    return null;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = getRequestUrl(request, config);
      if (url.pathname === '/healthz') return text(response, 200, 'ok');
      if (url.pathname === '/auth') return handleAuth(request, response, config);
      if (url.pathname === '/login') return handleLogin(request, response, config);
      if (url.pathname === '/logout') return handleLogout(response, config);
      if (url.pathname === '/oauth/discord/callback') return handleCallback(request, response, config);
      return text(response, 404, 'Not found');
    } catch (error) {
      logger.error(`Selkies OAuth request failed: ${error.message}`);
      return text(response, 500, 'Authentication service error.');
    }
  });

  server.listen(config.port, config.host, () => {
    logger.info(`Selkies OAuth server listening on ${config.host}:${config.port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startSelkiesAuthServer();
}
