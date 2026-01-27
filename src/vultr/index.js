/**
 * Vultr API Functions
 *
 * All Vultr API operations for managing VPS instances, snapshots, and regions.
 * Includes self-protection, firewall management, and cost calculations.
 */

import { vultr, fetch } from './client.js';
import { config } from '../config/index.js';
import { instanceState } from '../state/instanceState.js';
import { logger } from '../utils/logger.js';

// Cache the current server ID to avoid repeated metadata calls
let currentServerInstanceId = null;

/**
 * Auto-detect the current server instance to prevent self-destruction
 */
export async function getCurrentServerInstanceId() {
  try {
    const response = await fetch('http://169.254.169.254/v1/instanceid', {
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      const instanceId = await response.text();
      logger.info(`Self-protection enabled for instance ${instanceId.trim().slice(0, 8)}...`);
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

  if (config.exclude.instanceId === instanceId) {
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
export async function startInstanceApi(instanceId) {
  await vultr.instances.startInstance({ "instance-id": instanceId });
  return await waitForInstanceStatus(instanceId, 'running');
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
export async function createSnapshotFromInstance(instanceId, description) {
  const response = await vultr.snapshots.createSnapshot({
    "instance_id": instanceId,
    "description": description
  });
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
export async function createInstanceFromSnapshot(snapshotId, label, region) {
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

  // Verify snapshot exists
  const snapshots = await getSnapshots();
  if (!snapshots.some(snap => snap.id === snapshotId)) {
    throw new Error(`Snapshot ${snapshotId} not found.`);
  }

  // Create instance
  const response = await vultr.instances.createInstance({
    "snapshot_id": snapshotId,
    "label": label,
    "region": region || config.vultr.region,
    "plan": config.vultr.plan
  });

  if (!response?.instance?.id) {
    throw new Error('Failed to create instance - invalid API response');
  }

  const instanceId = response.instance.id;
  logger.info(`Instance created: ${instanceId.slice(0, 8)}...`);

  // Attach firewall with retries
  let firewallAttached = false;
  for (let i = 0; i < 10; i++) {
    try {
      await vultr.instances.updateInstance({
        "instance-id": instanceId,
        "firewall_group_id": firewallGroupId
      });

      await new Promise(resolve => setTimeout(resolve, 3000));
      const verify = await vultr.instances.getInstance({ "instance-id": instanceId });

      if (verify?.instance?.firewall_group_id === firewallGroupId) {
        firewallAttached = true;
        logger.debug(`Firewall attached to ${instanceId.slice(0, 8)}...`);
        break;
      }
    } catch (e) {
      logger.debug(`Firewall attach attempt ${i + 1} failed:`, e.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (!firewallAttached) {
    // Destroy unprotected instance
    try {
      await vultr.instances.deleteInstance({ "instance-id": instanceId });
    } catch (e) { /* ignore */ }
    throw new Error('SECURITY FAILURE: Firewall could not be attached. Instance destroyed.');
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

  return response.instance;
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
