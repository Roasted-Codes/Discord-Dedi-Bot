#!/usr/bin/env node
import { config } from '../src/config/index.js';
import {
  getSnapshots,
  getCleanSnapshotName,
  isBotManagedSnapshot,
  getGroupedRegions,
  listInstances
} from '../src/vultr/index.js';
import { getDediSnapshotChoice } from '../src/config/snapshots.js';
import { createServerIdentity, getNextServerSequence } from '../src/identity/serverIdentity.js';
import { getXlinkAvailability } from '../src/xlink/credentials.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = {
    snapshot: null,
    region: process.env.VULTR_REGION || 'dfw',
    timer: null,
    serverName: null,
    creator: process.env.USER || 'agent-dry-run'
  };

  for (const arg of argv) {
    if (arg.startsWith('--snapshot=')) args.snapshot = arg.slice('--snapshot='.length);
    else if (arg.startsWith('--region=')) args.region = arg.slice('--region='.length);
    else if (arg.startsWith('--timer=')) args.timer = arg.slice('--timer='.length);
    else if (arg.startsWith('--server-name=')) args.serverName = arg.slice('--server-name='.length);
    else if (arg.startsWith('--creator=')) args.creator = arg.slice('--creator='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.snapshot) throw new Error('--snapshot is required.');
  if (!args.region) throw new Error('--region is required.');

  const timer = Number.parseInt(args.timer, 10);
  if (!Number.isFinite(timer) || timer < 0) {
    throw new Error('--timer must be an integer greater than or equal to 0.');
  }
  args.timer = timer;

  return args;
}

function flattenRegions(groupedRegions) {
  return Object.values(groupedRegions)
    .flatMap(countryGroup => Object.values(countryGroup))
    .flat();
}

function resolveConfiguredSnapshot(snapshotArg) {
  if (UUID_RE.test(snapshotArg)) {
    return null;
  }

  try {
    return getDediSnapshotChoice(snapshotArg);
  } catch {
    return null;
  }
}

function printLine(label, value) {
  console.log(`${label.padEnd(24)} ${value}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const configuredSnapshot = resolveConfiguredSnapshot(args.snapshot);
  const snapshotId = configuredSnapshot?.id || args.snapshot;

  if (!UUID_RE.test(snapshotId)) {
    throw new Error(`Snapshot must be a UUID or configured snapshot key. Received: ${args.snapshot}`);
  }

  const snapshots = await getSnapshots();
  const snapshot = snapshots.find(item => item.id === snapshotId);
  if (!snapshot) {
    throw new Error(`Snapshot not found in Vultr account: ${snapshotId}`);
  }
  if (snapshot.status !== 'complete') {
    throw new Error(`Snapshot is not complete. Current status: ${snapshot.status || 'unknown'}`);
  }

  const groupedRegions = await getGroupedRegions();
  const regions = flattenRegions(groupedRegions);
  const selectedRegion = regions.find(region => region.id === args.region);
  const instances = await listInstances();
  const sequence = getNextServerSequence(instances);
  const identity = createServerIdentity({
    sequence,
    region: args.region,
    creator: args.creator,
    domain: process.env.REALONES_DOMAIN || 'realones.gg'
  });
  const xlinkAvailability = getXlinkAvailability();
  const generatedServerName = args.serverName || identity.server_id;
  const isManaged = isBotManagedSnapshot(snapshot);

  console.log('Restore snapshot dry-run');
  console.log('');
  printLine('snapshot_name:', getCleanSnapshotName(snapshot));
  printLine('snapshot_created:', snapshot.date_created || 'unknown');
  printLine('snapshot_id:', snapshot.id);
  printLine('snapshot_id_suffix:', snapshot.id.slice(-8));
  printLine('configured_alias:', configuredSnapshot?.key || 'none');
  printLine('bot_managed:', isManaged ? 'true' : 'false');
  printLine('region:', args.region);
  printLine('region_city:', selectedRegion ? `${selectedRegion.city}, ${selectedRegion.country}` : 'not found in filtered region list');
  printLine('server_name:', generatedServerName);
  printLine('identity_preview:', identity.server_id);
  printLine('hostname_preview:', identity.hostname);
  printLine('timer_minutes:', String(args.timer));
  printLine('vultr_plan:', config.vultr.plan);
  printLine('active_instances:', String(instances.length));
  printLine('xlink_total:', String(xlinkAvailability.total_accounts));
  printLine('xlink_active:', String(xlinkAvailability.active_assignment_count));
  printLine('xlink_available:', String(xlinkAvailability.available_count));

  if (!isManaged) {
    console.log('');
    console.log('warning: selected snapshot is not bot-managed; normal restore picker should not show it.');
  }

  console.log('');
  console.log('would_assign_xlink: false');
  console.log('would_create_vultr: false');
} catch (error) {
  console.error(`restore:dry-run failed: ${error.message}`);
  process.exitCode = 1;
}
