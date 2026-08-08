#!/usr/bin/env node
import { createServerIdentity } from '../src/identity/serverIdentity.js';
import { buildRealOnesCloudInit, buildVultrUserData, redactServerEnvText } from '../src/identity/cloudInit.js';
import { buildXlinkEnv } from '../src/xlink/credentials.js';

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
const xlinkPassword = getArg('xlink-password', 'dry-run-password');
const cityLabel = getArg('city-label', defaultCityLabel(identity.region));
const xlinkEnv = buildXlinkEnv({
  credentials: {
    username: xlinkXtag,
    password: xlinkPassword
  },
  cityLabel
});

console.log('RealOnesV2 server identity dry-run');
console.log('');
console.log(`display_name:       ${identity.display_name}`);
console.log(`server_id:          ${identity.server_id}`);
console.log(`hostname:           ${identity.hostname}`);
console.log(`friendly_hostname:  ${identity.friendly_hostname}`);
console.log(`region:             ${identity.region}`);
console.log(`creator:            ${identity.creator}`);
console.log(`would_create_vultr: ${identity.would_create_vultr}`);
console.log(`vultr_label:        ${identity.server_id}`);
console.log(`user_data_base64:   ${buildVultrUserData(identity, { extraEnv: xlinkEnv }).length} chars`);
console.log('');
console.log('.env values injected through cloud-init:');
for (const [key, value] of Object.entries({ ...identity.env, ...xlinkEnv })) {
  console.log(`${key}=${key === 'XLINK_KAI_PASSWORD' ? '[REDACTED]' : value}`);
}

if (process.argv.includes('--show-cloud-init')) {
  console.log('');
  console.log('cloud-init:');
  console.log(redactServerEnvText(buildRealOnesCloudInit(identity, { extraEnv: xlinkEnv })));
}
