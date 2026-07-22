#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const BOT_DIR = process.env.DEDI_BOT_DIR || '/home/bot/Dedi-Bot';
const STATSBORG_DIR = process.env.STATSBORG_DIR || '/home/statsborg/statsborg-master';
const ROUTES_FILE = process.env.SELKIES_ROUTES_FILE || path.join(BOT_DIR, 'data/selkies-routes.json');
const CADDYFILE = path.join(STATSBORG_DIR, 'Caddyfile');
const BASE_CADDYFILE = path.join(STATSBORG_DIR, 'Caddyfile.dedi-base');
const TMP_CADDYFILE = path.join(STATSBORG_DIR, 'Caddyfile.dedi-selkies.tmp');
const MANAGED_START = '# BEGIN DEDI SELKIES ROUTES - managed by dedi-selkies-route-sync';
const MANAGED_END = '# END DEDI SELKIES ROUTES';
const AUTH_HOST = process.env.SELKIES_AUTH_HOST || 'login.dedi.halo2stats.org';
const LEGACY_AUTH_HOST = process.env.SELKIES_LEGACY_AUTH_HOST || 'auth.dedi.halo2stats.org';

function readRoutes() {
  if (!fs.existsSync(ROUTES_FILE)) {
    return [];
  }

  const data = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
  return Array.isArray(data.routes) ? data.routes : [];
}

function caddyEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function validateRoute(route) {
  if (!route.hostname || !route.backend_url) {
    throw new Error(`Invalid route missing hostname/backend_url: ${JSON.stringify(route)}`);
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(route.hostname)) {
    throw new Error(`Invalid route hostname: ${route.hostname}`);
  }
  const backend = new URL(route.backend_url);
  if (!['http:', 'https:'].includes(backend.protocol)) {
    throw new Error(`Invalid backend URL protocol for ${route.hostname}`);
  }
}

function readBaseCaddyfile() {
  const source = fs.existsSync(BASE_CADDYFILE) ? BASE_CADDYFILE : CADDYFILE;
  if (!fs.existsSync(source)) {
    return '';
  }

  let base = fs.readFileSync(source, 'utf8');
  const managedIndex = base.indexOf(MANAGED_START);
  if (managedIndex !== -1) {
    base = base.slice(0, managedIndex);
  }
  return base.trimEnd();
}

function buildManagedCaddyfile(routes) {
  const selkiesRoutes = routes
    .filter(route => route.hostname && route.backend_url)
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  for (const route of selkiesRoutes) validateRoute(route);

  const authHosts = Array.from(new Set([AUTH_HOST, LEGACY_AUTH_HOST].filter(Boolean)));
  const sections = [
`${authHosts.join(', ')} {
  encode zstd gzip
  reverse_proxy dedi-auth:4181
}`
  ];

  for (const route of selkiesRoutes) {
    const authHeader = route.backend_auth_header
      ? `\n    header_up Authorization "${caddyEscape(route.backend_auth_header)}"`
      : '';
    sections.push(`${route.hostname} {
  encode zstd gzip

  handle /oauth/* {
    redir https://${AUTH_HOST}{uri} permanent
  }

  handle {
    forward_auth dedi-auth:4181 {
      uri /auth
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-Uri {uri}
      header_up X-Forwarded-Host {host}
      header_up X-Forwarded-Proto {scheme}
      copy_headers X-Auth-Request-User X-Auth-Request-Preferred-Username
    }

    reverse_proxy ${route.backend_url} {${authHeader}
    }
  }
}`);
  }

  return `${sections.join('\n\n')}\n`;
}

function compose(args) {
  execFileSync('docker', ['compose', ...args], {
    cwd: STATSBORG_DIR,
    stdio: 'inherit'
  });
}

function writeCaddyfileInPlace() {
  if (!fs.existsSync(CADDYFILE)) {
    fs.renameSync(TMP_CADDYFILE, CADDYFILE);
    return;
  }

  fs.copyFileSync(TMP_CADDYFILE, CADDYFILE);
  fs.chmodSync(CADDYFILE, 0o600);
  fs.unlinkSync(TMP_CADDYFILE);
}

function main() {
  if (process.getuid && process.getuid() !== 0) {
    throw new Error('dedi-selkies-route-sync must run as root');
  }

  const routes = readRoutes();
  const base = readBaseCaddyfile();
  const managed = buildManagedCaddyfile(routes);
  const rendered = `${base}${base ? '\n\n' : ''}${MANAGED_START}\n${managed}${MANAGED_END}\n`;
  fs.writeFileSync(TMP_CADDYFILE, rendered, { mode: 0o600 });

  execFileSync('docker', [
    'run',
    '--rm',
    '-v',
    `${TMP_CADDYFILE}:/etc/caddy/Caddyfile:ro`,
    'caddy:2-alpine',
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile'
  ], { stdio: 'inherit' });

  writeCaddyfileInPlace();
  compose(['up', '-d', 'dedi-auth', 'caddy']);
  execFileSync('docker', [
    'compose',
    'exec',
    '-T',
    'caddy',
    'caddy',
    'reload',
    '--config',
    '/etc/caddy/Caddyfile'
  ], {
    cwd: STATSBORG_DIR,
    stdio: 'inherit'
  });
  console.log(`synced ${routes.length} Selkies route(s)`);
}

main();
