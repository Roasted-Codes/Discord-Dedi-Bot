#!/usr/bin/env node
import { config } from '../src/config/index.js';
import {
  getCurrentServerInstanceId,
  isCurrentServer,
  listAllInstances,
  getSnapshots
} from '../src/vultr/index.js';

function envStatus(key) {
  return process.env[key] ? 'set' : 'missing';
}

function printLine(label, value) {
  console.log(`${label.padEnd(28)} ${value}`);
}

try {
  console.log('Vultr bot identity');
  console.log('');
  for (const key of [
    'VULTR_API_KEY',
    'VULTR_FIREWALL_GROUP_ID',
    'VULTR_REGION',
    'VULTR_PLAN',
    'EXCLUDE_INSTANCE_ID',
    'EXCLUDE_SNAPSHOT_ID'
  ]) {
    printLine(`${key}:`, envStatus(key));
  }

  const currentServerId = await getCurrentServerInstanceId();
  const instances = await listAllInstances();
  const snapshots = await getSnapshots();
  const currentInstance = currentServerId
    ? instances.find(instance => instance.id === currentServerId)
    : null;
  const selfProtected = currentServerId
    ? await isCurrentServer(currentServerId)
    : false;

  console.log('');
  printLine('metadata_instance_id:', currentServerId || 'unresolved');
  printLine('configured_exclude_id:', config.exclude.instanceId || 'unset');
  printLine('exclude_matches_metadata:', currentServerId && config.exclude.instanceId === currentServerId ? 'true' : 'false');
  printLine('self_protection_resolves:', selfProtected ? 'true' : 'false');
  printLine('vultr_instance_count:', String(instances.length));
  printLine('vultr_snapshot_count:', String(snapshots.length));

  if (currentInstance) {
    printLine('current_label:', currentInstance.label || 'unknown');
    printLine('current_region:', currentInstance.region || 'unknown');
    printLine('current_status:', currentInstance.status || 'unknown');
    printLine('current_power:', currentInstance.power_status || 'unknown');
  } else {
    printLine('current_instance:', 'not found in account list');
  }

  console.log('');
  console.log('would_mutate_vultr: false');
} catch (error) {
  console.error(`vultr:whoami failed: ${error.message}`);
  process.exitCode = 1;
}
