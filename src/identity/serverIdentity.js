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
  gamertag,
  sequence = 1,
  region = 'dfw',
  creator = 'unknown',
  domain = 'realones.gg'
} = {}) {
  const displayName = String(gamertag || pickGamertag()).trim();
  const slug = slugifyGamertag(displayName);
  if (!slug) {
    throw new Error(`Invalid gamertag for server identity: ${gamertag}`);
  }
  const paddedSequence = formatSequence(sequence);
  const serverId = `r1v2-${slug}-${paddedSequence}`;

  return {
    display_name: displayName,
    server_id: serverId,
    hostname: `${serverId}.${domain}`,
    friendly_hostname: `${slug}.${domain}`,
    region,
    creator,
    would_create_vultr: false,
    env: {
      REALONES_SERVER_ID: serverId,
      REALONES_DISPLAY_NAME: displayName,
      REALONES_SERVER_SLUG: slug,
      REALONES_SERVER_SEQUENCE: paddedSequence,
      REALONES_REGION: region,
      REALONES_HOSTNAME: `${serverId}.${domain}`,
      REALONES_FRIENDLY_HOSTNAME: `${slug}.${domain}`,
      REALONES_CREATOR: creator
    }
  };
}
