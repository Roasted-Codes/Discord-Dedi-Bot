import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const DEFAULT_ROUTES_FILE = './data/selkies-routes.json';
const DEFAULT_ROUTE_SYNC = '/usr/local/sbin/dedi-selkies-route-sync';

function resolvePath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

export function isCentralSelkiesEnabled() {
  return process.env.SELKIES_CENTRAL_PROXY_ENABLED === '1' ||
    process.env.SELKIES_OAUTH_ENABLED === '1';
}

export function toDnsSafeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function getSelkiesDomain() {
  return String(process.env.SELKIES_DOMAIN || 'dedi.halo2stats.org')
    .trim()
    .replace(/^\.+|\.+$/g, '');
}

export function getSelkiesHostname(serverId) {
  const label = toDnsSafeLabel(serverId);
  if (!label) {
    throw new Error(`Invalid Selkies server id for hostname: ${serverId}`);
  }
  return `${label}.${getSelkiesDomain()}`;
}

function getRoutesFile() {
  return resolvePath(process.env.SELKIES_ROUTES_FILE || DEFAULT_ROUTES_FILE);
}

function readRoutesFile() {
  const routesFile = getRoutesFile();
  if (!fs.existsSync(routesFile)) {
    return { routes: [] };
  }

  const data = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  return {
    routes: Array.isArray(data.routes) ? data.routes : []
  };
}

function writeRoutesFile(data) {
  const routesFile = getRoutesFile();
  fs.mkdirSync(path.dirname(routesFile), { recursive: true, mode: 0o700 });
  const tmp = `${routesFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, routesFile);
}

function buildBackendAuthHeader({ username, password } = {}) {
  if (!username || !password) {
    return '';
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export async function syncSelkiesRoutes() {
  if (!isCentralSelkiesEnabled()) {
    return { skipped: true, reason: 'central Selkies proxy is disabled' };
  }

  const helper = process.env.SELKIES_ROUTE_SYNC_COMMAND || DEFAULT_ROUTE_SYNC;
  try {
    const result = await execFileAsync('sudo', ['-n', helper], {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    if (result.stdout?.trim()) {
      logger.debug(`Selkies route sync: ${result.stdout.trim()}`);
    }
    return { success: true };
  } catch (error) {
    logger.warn(`Selkies route sync unavailable or failed: ${error.message}`);
    return { success: false, error };
  }
}

export async function upsertSelkiesRoute({
  instanceId,
  serverId,
  ip,
  creatorId,
  selkiesUsername,
  selkiesPassword
}) {
  if (!isCentralSelkiesEnabled()) {
    return null;
  }

  if (!instanceId || !serverId || !ip) {
    throw new Error('Selkies route requires instanceId, serverId, and ip.');
  }

  const now = new Date().toISOString();
  const data = readRoutesFile();
  const existing = data.routes.find(route => route.instance_id === instanceId);
  const route = {
    instance_id: instanceId,
    server_id: serverId,
    hostname: getSelkiesHostname(serverId),
    target_ip: ip,
    backend_url: `http://${ip}:3000`,
    backend_auth_header: buildBackendAuthHeader({
      username: selkiesUsername,
      password: selkiesPassword
    }) || existing?.backend_auth_header || '',
    creator_id: creatorId || existing?.creator_id || '',
    created_at: existing?.created_at || now,
    updated_at: now
  };

  const routes = [
    ...data.routes.filter(item => item.instance_id !== instanceId && item.hostname !== route.hostname),
    route
  ].sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));

  writeRoutesFile({ routes });
  await syncSelkiesRoutes();
  return route;
}

export async function removeSelkiesRoute({ instanceId, serverId } = {}) {
  if (!isCentralSelkiesEnabled()) {
    return false;
  }

  const data = readRoutesFile();
  const before = data.routes.length;
  const routes = data.routes.filter(route => {
    if (instanceId && route.instance_id === instanceId) return false;
    if (serverId && route.server_id === serverId) return false;
    return true;
  });

  if (routes.length === before) {
    return false;
  }

  writeRoutesFile({ routes });
  await syncSelkiesRoutes();
  return true;
}

export async function reconcileSelkiesRoutes(instances = []) {
  if (!instances.length) {
    return { skipped: true, reason: 'empty_inventory' };
  }
  if (!isCentralSelkiesEnabled()) {
    return { skipped: true };
  }

  const liveIds = new Set(instances.map(instance => instance.id).filter(Boolean));
  const data = readRoutesFile();
  const routes = data.routes.filter(route => liveIds.has(route.instance_id));
  if (routes.length !== data.routes.length) {
    writeRoutesFile({ routes });
    await syncSelkiesRoutes();
  }
  return { route_count: routes.length };
}
