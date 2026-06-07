#!/usr/bin/env node
import { createServerIdentity } from '../src/identity/serverIdentity.js';
import { buildVultrUserData } from '../src/identity/cloudInit.js';
import { buildXlinkEnv } from '../src/xlink/credentials.js';
import { getDediSnapshotChoice } from '../src/config/snapshots.js';

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const identity = createServerIdentity({
  gamertag: getArg('gamertag', undefined),
  sequence: getArg('sequence', '1'),
  region: getArg('region', process.env.VULTR_REGION || 'dfw'),
  creator: getArg('creator', process.env.USER || 'dry-run'),
  domain: getArg('domain', process.env.REALONES_DOMAIN || 'realones.gg')
});
const xlinkXtag = getArg('xlink-xtag', '');
const cityLabel = getArg('city-label', identity.region.toUpperCase());
const snapshotChoice = getDediSnapshotChoice(getArg('snapshot', undefined));
const xlinkEnv = buildXlinkEnv({
  credentials: xlinkXtag
    ? {
        username: xlinkXtag,
        password: getArg('xlink-password', 'dry-run-password')
      }
    : null,
  cityLabel
});

const payload = {
  snapshot_id: snapshotChoice.id,
  label: identity.server_id,
  region: identity.region,
  plan: process.env.VULTR_PLAN || 'vc2-1c-1gb',
  user_data: buildVultrUserData(identity, { extraEnv: xlinkEnv })
};

console.log('RealOnesV2 /create request dry-run');
console.log('');
console.log(`display_name:       ${identity.display_name}`);
console.log(`server_id:          ${identity.server_id}`);
console.log(`vultr_label:        ${payload.label}`);
console.log(`region:             ${payload.region}`);
console.log(`snapshot:           ${snapshotChoice.label}`);
console.log(`snapshot_id:        ${payload.snapshot_id}`);
if (xlinkXtag) {
  console.log(`xlink_xtag:         ${xlinkXtag}`);
  console.log(`xlink_description:  ${xlinkEnv.XLINK_PRIVATE_ARENA_DESCRIPTION}`);
}
console.log(`user_data_base64:   ${payload.user_data.length} chars`);
console.log('would_create_vultr: false');
