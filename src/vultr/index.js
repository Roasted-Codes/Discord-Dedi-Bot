/**
 * Vultr API Functions
 *
 * All Vultr API operations for managing VPS instances, snapshots, and regions.
 * Includes self-protection, firewall management, and cost calculations.
 */

import { vultr, fetch } from './client.js';
import { config } from '../config/index.js';
import { DEDI_SNAPSHOT_CHOICES } from '../config/snapshots.js';
import {
  formatSnapshotSourceSpec,
  getSnapshotSpec,
  recordSnapshotSpec
} from './snapshotSpecs.js';
import { instanceState } from '../state/instanceState.js';
import { logger } from '../utils/logger.js';

// Cache the current server ID to avoid repeated metadata calls
let currentServerInstanceId = null;
const configuredSnapshotIds = new Set(DEDI_SNAPSHOT_CHOICES.map(snapshot => snapshot.id));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const configuredSnapshotsById = new Map(DEDI_SNAPSHOT_CHOICES.map(snapshot => [snapshot.id, snapshot]));

function isNotFoundError(error) {
  const status = error?.response?.status || error?.status || error?.statusCode;
  const message = String(error?.message || '').toLowerCase();
  return status === 404 || message.includes('404') || message.includes('not found');
}

async function verifyFirewallAttached(instanceId, firewallGroupId, { attempts = 24, intervalMs = 5000 } = {}) {
  let lastFirewallGroupId = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      try {
        await vultr.instances.updateInstance({
          "instance-id": instanceId,
          "firewall_group_id": firewallGroupId
        });
      } catch (error) {
        logger.debug(`Firewall attach retry ${attempt} update failed:`, error.message);
      }
    }

    try {
      const verify = await vultr.instances.getInstance({ "instance-id": instanceId });
      lastFirewallGroupId = verify?.instance?.firewall_group_id || null;

      if (lastFirewallGroupId === firewallGroupId) {
        logger.debug(`Firewall verified on ${instanceId.slice(0, 8)}...`);
        return verify.instance;
      }

      logger.debug(
        `Firewall verify attempt ${attempt}/${attempts} for ${instanceId.slice(0, 8)}... ` +
        `saw ${lastFirewallGroupId || 'none'}`
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.debug(`Firewall verify stopped because ${instanceId.slice(0, 8)}... no longer exists`);
        return null;
      }

      logger.debug(`Firewall verify attempt ${attempt}/${attempts} failed:`, error.message);
    }

    if (attempt < attempts) {
      await wait(intervalMs);
    }
  }

  logger.warn(
    `Firewall did not verify for ${instanceId.slice(0, 8)}... after ${attempts} attempts ` +
    `(last value: ${lastFirewallGroupId || 'none'})`
  );
  return null;
}

async function deleteInstanceAndWait(instanceId, { attempts = 24, intervalMs = 5000 } = {}) {
  try {
    await vultr.instances.deleteInstance({ "instance-id": instanceId });
  } catch (error) {
    if (isNotFoundError(error)) {
      return true;
    }

    logger.warn(`Delete request failed for unprotected instance ${instanceId.slice(0, 8)}...: ${error.message}`);
    return false;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await vultr.instances.getInstance({ "instance-id": instanceId });
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.info(`Confirmed deletion of unprotected instance ${instanceId.slice(0, 8)}...`);
        return true;
      }

      logger.debug(`Delete verify attempt ${attempt}/${attempts} failed:`, error.message);
    }

    if (attempt < attempts) {
      await wait(intervalMs);
    }
  }

  logger.error(`Could not confirm deletion of unprotected instance ${instanceId.slice(0, 8)}...`);
  return false;
}

/**
 * Auto-detect the current server instance to prevent self-destruction
 */
export async function getCurrentServerInstanceId() {
  try {
    const response = await fetch('http://169.254.169.254/v1.json', {
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      const metadata = await response.json();
      const instanceId = metadata['instance-v2-id'] || metadata.instanceid;
      if (!instanceId) {
        throw new Error('Metadata response did not include an instance ID');
      }
      logger.info(`Self-protection enabled for instance ${instanceId.trim().slice(0, 8)}...`);
      return instanceId.trim();
    }
  } catch (error) {
    logger.debug('Vultr v1.json metadata unavailable:', error.message);
  }

  try {
    const response = await fetch('http://169.254.169.254/v1/instanceid', {
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      const instanceId = await response.text();
      logger.info(`Self-protection enabled for legacy instance ${instanceId.trim().slice(0, 8)}...`);
      return instanceId.trim();
    }
  } catch (error) {
    logger.debug('Running outside Vultr (metadata service unavailable)');
  }

  return config.exclude.instanceId || null;
}

/**
 * Check if an instance ID is the current server running this bot
 */
export async function isCurrentServer(instanceId) {
  if (!currentServerInstanceId) {
    currentServerInstanceId = await getCurrentServerInstanceId();
  }

  if (currentServerInstanceId === instanceId) {
    return true;
  }

  if (config.exclude.instanceIds?.includes(instanceId)) {
    return true;
  }

  return false;
}

/**
 * Get information about a specific instance (returns null for excluded instances)
 */
export async function getInstance(instanceId) {
  try {
    const response = await vultr.instances.getInstance({
      "instance-id": instanceId
    });
    const instance = response.instance;

    const isCurrent = await isCurrentServer(instanceId);
    if (isCurrent) {
      logger.debug(`Skipping self (${instanceId.slice(0, 8)}...)`);
      return null;
    }

    if (config.exclude.snapshotId && instance.snapshot_id === config.exclude.snapshotId) {
      logger.debug(`Skipping excluded instance ${instanceId.slice(0, 8)}...`);
      return null;
    }

    return instance;
  } catch (error) {
    logger.error('Error getting instance:', error.message);
    throw error;
  }
}

/**
 * Get information about any instance, including bot/excluded instances.
 * Intended for admin-only maintenance actions such as snapshots.
 */
export async function getAnyInstance(instanceId) {
  try {
    const response = await vultr.instances.getInstance({
      "instance-id": instanceId
    });
    return response.instance;
  } catch (error) {
    logger.error('Error getting instance:', error.message);
    throw error;
  }
}

/**
 * List all instances (excluding the current server and EXCLUDE_SNAPSHOT_ID)
 */
export async function listInstances() {
  try {
    const response = await vultr.instances.listInstances();
    let instances = response.instances || [];

    const filteredInstances = [];
    for (const instance of instances) {
      const isCurrent = await isCurrentServer(instance.id);
      if (!isCurrent) {
        filteredInstances.push(instance);
      }
    }
    instances = filteredInstances;

    if (config.exclude.snapshotId) {
      const filtered = instances.filter(instance => instance.snapshot_id !== config.exclude.snapshotId);
      return filtered;
    }

    return instances;
  } catch (error) {
    logger.error('Error listing instances:', error.message);
    throw error;
  }
}

/**
 * List every Vultr instance without bot/exclusion filtering.
 * Intended for admin-only maintenance actions such as snapshots.
 */
export async function listAllInstances() {
  try {
    const response = await vultr.instances.listInstances();
    return response.instances || [];
  } catch (error) {
    logger.error('Error listing all instances:', error.message);
    throw error;
  }
}

/**
 * Wait for an instance to reach a specific power status
 */
export async function waitForInstanceStatus(instanceId, targetPowerStatus, timeout = 15 * 60 * 1000) {
  const startTime = Date.now();
  const checkInterval = 15000;

  while (Date.now() - startTime < timeout) {
    try {
      const instance = await getInstance(instanceId);
      if (!instance) {
        return false;
      }
      logger.debug(`Status: ${instance.power_status}, waiting for: ${targetPowerStatus}`);
      if (instance.power_status === targetPowerStatus) {
        return true;
      }
    } catch (error) {
      logger.debug(`Error checking instance status:`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  return false;
}

/**
 * Start an instance
 */
export async function startInstanceApi(instanceId, timeout) {
  await vultr.instances.startInstance({ "instance-id": instanceId });
  return await waitForInstanceStatus(instanceId, 'running', timeout);
}

/**
 * Stop an instance
 */
export async function stopInstanceApi(instanceId) {
  await vultr.instances.haltInstance({ "instance-id": instanceId });
  return await waitForInstanceStatus(instanceId, 'stopped');
}

/**
 * Reboot an instance
 */
export async function rebootInstanceApi(instanceId) {
  await vultr.instances.rebootInstance({ "instance-id": instanceId });
}

/**
 * Delete an instance
 */
export async function deleteInstance(instanceId) {
  await vultr.instances.deleteInstance({ "instance-id": instanceId });
  return true;
}

/**
 * Get all snapshots
 */
export async function getSnapshots() {
  try {
    const response = await vultr.snapshots.listSnapshots();

    if (response && Object.keys(response).length === 0) {
      logger.warn('Vultr API returned empty response for snapshots');
    }

    const snapshots = response.snapshots || [];
    snapshots.sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
    return snapshots;
  } catch (error) {
    logger.error('Error getting snapshots:', error.message);
    throw error;
  }
}

/**
 * Snapshot picker visibility for bot-managed restores.
 * Includes snapshots created by the bot's /snapshot command, configured dedi
 * snapshots, and RealOnesV2-named snapshots from prior bot workflows.
 */
export function isBotManagedSnapshot(snapshot) {
  if (!snapshot || snapshot.status !== 'complete') return false;

  const description = snapshot.description || '';
  const cleanName = getCleanSnapshotName(snapshot).toLowerCase();

  return /^\[(PUBLIC|PRIVATE)\]\s*/i.test(description) ||
    description.toLowerCase().includes('#public') ||
    configuredSnapshotIds.has(snapshot.id) ||
    cleanName.includes('realonesv2');
}

export function getSnapshotRestoreSpec(snapshotId, options = {}) {
  const recordedSpec = getSnapshotSpec(snapshotId);
  const configuredSnapshot = configuredSnapshotsById.get(snapshotId) || null;
  const plan = options.plan ||
    recordedSpec?.source?.plan ||
    configuredSnapshot?.plan ||
    config.vultr.plan;
  const planSource = options.plan
    ? 'override'
    : recordedSpec?.source?.plan
      ? 'snapshot-source'
      : configuredSnapshot?.plan
        ? 'configured-snapshot'
        : 'default';

  return {
    plan,
    planSource,
    recordedSpec,
    configuredSnapshot,
    sourceSummary: formatSnapshotSourceSpec(recordedSpec)
  };
}

/**
 * Get completed snapshots safe to show in the normal restore picker.
 */
export async function getBotManagedSnapshots() {
  const snapshots = await getSnapshots();
  return snapshots.filter(isBotManagedSnapshot);
}

/**
 * Get snapshots available to public users (detected via [PUBLIC] prefix)
 */
export async function getPublicSnapshots() {
  try {
    const allSnapshots = await getSnapshots();

    const publicSnapshots = allSnapshots.filter(snapshot => {
      const description = snapshot.description || '';
      return (description.startsWith('[PUBLIC]') || description.includes('#public'))
        && snapshot.status === 'complete';
    });

    if (publicSnapshots.length === 0 && config.vultr.snapshotId) {
      const defaultSnapshot = allSnapshots.find(snap => snap.id === config.vultr.snapshotId);
      if (defaultSnapshot && defaultSnapshot.status === 'complete') {
        return [defaultSnapshot];
      }
    }

    return publicSnapshots;
  } catch (error) {
    logger.error('Error getting public snapshots:', error.message);
    return [];
  }
}

/**
 * Create a snapshot from a running instance
 */
export async function createSnapshotFromInstance(instanceId, description, options = {}) {
  const sourceInstance = options.sourceInstance || await getAnyInstance(instanceId);
  const response = await vultr.snapshots.createSnapshot({
    "instance_id": instanceId,
    "description": description
  });

  if (response.snapshot?.id) {
    try {
      recordSnapshotSpec(response.snapshot, sourceInstance, {
        description,
        visibility: options.visibility || null,
        recordedBy: options.recordedBy || 'dedi-bot'
      });
    } catch (error) {
      logger.warn(`Snapshot spec recording failed for ${response.snapshot.id.slice(0, 8)}...: ${error.message}`);
    }
  }

  return response.snapshot;
}

/**
 * Check if user has permission to create snapshots
 */
export function hasSnapshotPermission(userId) {
  return config.admin.userIds.includes(String(userId));
}

/**
 * Clean snapshot name for display
 */
export function getCleanSnapshotName(snapshot) {
  const description = snapshot.description || 'Unnamed Snapshot';
  return description
    .replace(/^\[(PUBLIC|PRIVATE)\]\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim() || 'Unnamed Snapshot';
}

/**
 * Fetches all Vultr regions and organizes them by continent and country
 */
export async function getGroupedRegions() {
  try {
    const response = await vultr.regions.listRegions();
    const regions = response.regions || [];

    const grouped = {};
    for (const region of regions) {
      const hasRequiredOptions = region.options && region.options.includes('kubernetes');

      if (hasRequiredOptions) {
        const continent = region.continent || 'Other';
        const country = region.country || 'Other';

        if (!grouped[continent]) grouped[continent] = {};
        if (!grouped[continent][country]) grouped[continent][country] = [];

        grouped[continent][country].push({
          id: region.id,
          city: region.city,
          country: region.country,
          continent: region.continent,
          options: region.options
        });
      }
    }

    return grouped;
  } catch (error) {
    logger.error('Error fetching regions:', error.message);
    throw error;
  }
}

/**
 * Create a new instance from a snapshot with specified region
 */
export async function createInstanceFromSnapshot(snapshotId, label, region, options = {}) {
  const firewallGroupId = config.vultr.firewallGroupId;
  if (!firewallGroupId) {
    throw new Error('VULTR_FIREWALL_GROUP_ID is required but not set.');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(firewallGroupId)) {
    throw new Error(`Invalid firewall_group_id format: "${firewallGroupId}"`);
  }

  if (!snapshotId || !uuidRegex.test(snapshotId)) {
    throw new Error(`Invalid snapshot_id format: "${snapshotId}"`);
  }

  const snapshots = await getSnapshots();
  const snapshot = snapshots.find(snap => snap.id === snapshotId);
  if (!snapshot) {
    throw new Error(`Snapshot ${snapshotId} not found.`);
  }

  const restoreSpec = getSnapshotRestoreSpec(snapshotId, options);

  // Create instance
  const createPayload = {
    "snapshot_id": snapshotId,
    "label": label,
    "region": region || config.vultr.region,
    "plan": restoreSpec.plan,
    "firewall_group_id": firewallGroupId
  };

  if (options.userData) {
    createPayload.user_data = options.userData;
  }

  const response = await vultr.instances.createInstance(createPayload);

  if (!response?.instance?.id) {
    throw new Error('Failed to create instance - invalid API response');
  }

  const instanceId = response.instance.id;
  logger.info(
    `Instance created: ${instanceId.slice(0, 8)}... ` +
    `(snapshot ${snapshotId.slice(0, 8)}..., plan ${restoreSpec.plan}, ${restoreSpec.planSource})`
  );

  const verifiedInstance = await verifyFirewallAttached(instanceId, firewallGroupId);

  if (!verifiedInstance) {
    const deleteConfirmed = await deleteInstanceAndWait(instanceId);
    const error = new Error(
      deleteConfirmed
        ? 'SECURITY FAILURE: Firewall could not be attached. Instance deletion confirmed.'
        : 'SECURITY FAILURE: Firewall could not be attached. Instance deletion could not be confirmed; XLink assignment kept for manual cleanup.'
    );
    error.instanceId = instanceId;
    error.keepXlinkAssignment = !deleteConfirmed;
    throw error;
  }

  // Try to enable DDOS protection (non-fatal)
  try {
    await vultr.instances.updateInstance({
      "instance-id": instanceId,
      "ddos_protection": true
    });
  } catch (e) {
    logger.debug('DDOS protection not available:', e.message);
  }

  return verifiedInstance;
}

/**
 * Calculate approximate cost for an instance
 */
export async function calculateInstanceCost(instance) {
  try {
    if (!instance?.plan || !instance?.date_created) {
      return 'unavailable';
    }

    const createdAt = new Date(instance.date_created);
    const currentTime = new Date();
    const plansResponse = await vultr.plans.listPlans();

    if (plansResponse?.plans) {
      const plan = plansResponse.plans.find(p => p.id === instance.plan);

      if (plan && typeof plan.monthly_cost === 'number') {
        const uptimeMs = currentTime - createdAt;
        const uptimeHours = Math.ceil(uptimeMs / (1000 * 60 * 60));
        const hourlyRate = plan.monthly_cost / 730;
        const cost = uptimeHours * hourlyRate;

        return `$${cost.toFixed(2)}`;
      }
    }

    return 'unavailable';
  } catch (error) {
    logger.debug('Error calculating instance cost:', error.message);
    return 'unavailable';
  }
}

// Re-export the vultr client for direct access
export { vultr };
