#!/usr/bin/env node
import { createServerIdentity } from '../src/identity/serverIdentity.js';
import { buildVultrUserData } from '../src/identity/cloudInit.js';
import { buildXlinkEnv } from '../src/xlink/credentials.js';
import { config } from '../src/config/index.js';
import { formatDediSnapshotDescription, getDediSnapshotChoice } from '../src/config/snapshots.js';
import { getSnapshotSpec } from '../src/vultr/snapshotSpecs.js';
import { buildSelkiesAccess, buildSelkiesEnv } from '../src/selkies/access.js';
import { getSelkiesHostname, isCentralSelkiesEnabled } from '../src/selkies/routes.js';

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function defaultCityLabel(region) {
  const cityLabels = {
    dfw: 'Dallas'
  };
  return cityLabels[String(region || '').toLowerCase()] || String(region || '').toUpperCase();
}

const xlinkXtag = getArg('xlink-xtag', 'walshy_server');
const identity = createServerIdentity({
  serverId: xlinkXtag,
  displayName: xlinkXtag,
  sequence: getArg('sequence', '1'),
  region: getArg('region', process.env.VULTR_REGION || 'dfw'),
  creator: getArg('creator', process.env.USER || 'dry-run'),
  domain: getArg('domain', process.env.REALONES_DOMAIN || '')
});
const cityLabel = getArg('city-label', defaultCityLabel(identity.region));
const snapshotChoice = getDediSnapshotChoice(getArg('snapshot', undefined));
const snapshotSpec = getSnapshotSpec(snapshotChoice.id);
const plan = snapshotSpec?.source?.plan || snapshotChoice.plan || config.vultr.plan;
const xlinkEnv = buildXlinkEnv({
  credentials: {
    username: xlinkXtag,
    password: getArg('xlink-password', 'dry-run-password')
  },
  cityLabel
});
const selkiesAccess = buildSelkiesAccess({ password: getArg('selkies-password', 'dry-run-selkies-password') });
const selkiesEnv = buildSelkiesEnv(selkiesAccess);

const payload = {
  snapshot_id: snapshotChoice.id,
  label: identity.server_id,
  region: identity.region,
  plan,
  user_data: buildVultrUserData(identity, { extraEnv: { ...xlinkEnv, ...selkiesEnv } })
};

console.log('RealOnesV2 /create request dry-run');
console.log('');
console.log(`display_name:       ${identity.display_name}`);
console.log(`server_id:          ${identity.server_id}`);
console.log(`vultr_label:        ${payload.label}`);
console.log(`region:             ${payload.region}`);
console.log(`snapshot:           ${snapshotChoice.label}`);
console.log(`snapshot_id:        ${payload.snapshot_id}`);
console.log(`snapshot_notes:     ${formatDediSnapshotDescription(snapshotChoice)}`);
console.log(`plan:               ${payload.plan}`);
console.log(`xlink_xtag:         ${xlinkXtag}`);
console.log(`xlink_description:  ${xlinkEnv.XLINK_PRIVATE_ARENA_DESCRIPTION}`);
console.log(`selkies_username:   ${selkiesAccess.username}`);
console.log(`selkies_password:   [REDACTED]`);
if (isCentralSelkiesEnabled()) {
  console.log(`selkies_hostname:   ${getSelkiesHostname(identity.server_id)}`);
}
console.log(`user_data_base64:   ${payload.user_data.length} chars`);
console.log('would_create_vultr: false');
