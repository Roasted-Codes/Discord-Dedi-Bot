import { HALO2_PRO_GAMERTAGS } from './halo2Pros.js';

export function slugifyGamertag(gamertag) {
  return String(gamertag || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatSequence(sequence) {
  const number = Number.parseInt(sequence, 10);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`Invalid server sequence: ${sequence}`);
  }
  return String(number).padStart(3, '0');
}

export function getNextServerSequence(instances = []) {
  const usedSequences = instances
    .flatMap(instance => [
      instance?.realonesSequence,
      instance?.serverId,
      instance?.server_id,
      instance?.label,
      instance?.name
    ])
    .filter(Boolean)
    .map(value => String(value).match(/(?:^|-)0*(\d{1,3})$/)?.[1])
    .filter(Boolean)
    .map(value => Number.parseInt(value, 10))
    .filter(number => Number.isFinite(number) && number > 0);

  if (usedSequences.length === 0) {
    return 1;
  }

  return Math.max(...usedSequences) + 1;
}

export function pickGamertag({ pool = HALO2_PRO_GAMERTAGS, random = Math.random } = {}) {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error('Gamertag pool is empty.');
  }
  return pool[Math.floor(random() * pool.length)];
}

export function createServerIdentity({
  serverId,
  displayName,
  gamertag,
  sequence = 1,
  region = 'dfw',
  creator = 'unknown',
  domain = ''
} = {}) {
  const exactServerId = String(serverId || '').trim();
  const identityDisplayName = String(displayName || exactServerId || gamertag || pickGamertag()).trim();
  const slug = slugifyGamertag(exactServerId || identityDisplayName);
  if (!slug) {
    throw new Error(`Invalid server identity name: ${serverId || displayName || gamertag}`);
  }
  const paddedSequence = formatSequence(sequence);
  const resolvedServerId = exactServerId || `r1v2-${slug}-${paddedSequence}`;
  const resolvedDomain = String(domain || '').trim().replace(/^\.+|\.+$/g, '');
  const resolvedHostname = resolvedDomain ? `${slug}.${resolvedDomain}` : '';

  return {
    display_name: identityDisplayName,
    server_id: resolvedServerId,
    hostname: resolvedHostname,
    friendly_hostname: resolvedHostname,
    region,
    creator,
    would_create_vultr: false,
    env: {
      REALONES_SERVER_ID: resolvedServerId,
      REALONES_DISPLAY_NAME: identityDisplayName,
      REALONES_SERVER_SLUG: slug,
      REALONES_SERVER_SEQUENCE: paddedSequence,
      REALONES_REGION: region,
      REALONES_HOSTNAME: resolvedHostname,
      REALONES_FRIENDLY_HOSTNAME: resolvedHostname,
      REALONES_CREATOR: creator
    }
  };
}
