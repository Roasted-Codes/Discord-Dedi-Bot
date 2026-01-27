/**
 * Instance State Management
 *
 * In-memory tracking of server instances. Maintains creator info,
 * status, IPs, and self-destruct timers for all managed instances.
 */

// Simple in-memory tracking of instances
export const instanceState = {
  instances: [],

  /**
   * Add or update an instance in tracking
   * @param {string} instanceId - Vultr instance ID
   * @param {string} userId - Discord user ID who created it
   * @param {string} username - Discord username
   * @param {string} status - Current status
   * @param {Object} metadata - Additional metadata (ip, name, region, etc.)
   */
  trackInstance(instanceId, userId, username, status, metadata = {}) {
    const timestamp = new Date();
    const existingIndex = this.instances.findIndex(i => i.id === instanceId);

    const instanceData = {
      id: instanceId,
      creator: {
        id: userId,
        username
      },
      createdAt: timestamp.toISOString(),
      status: status || 'creating',
      ip: metadata.ip || null,
      name: metadata.name || `${username}'s Server`,
      lastUpdated: timestamp.toISOString(),
      ...metadata
    };

    if (existingIndex >= 0) {
      this.instances[existingIndex] = {
        ...this.instances[existingIndex],
        ...instanceData
      };
    } else {
      this.instances.push(instanceData);
    }

    return instanceData;
  },

  /**
   * Update an existing instance's status and metadata
   * @param {string} instanceId - Vultr instance ID
   * @param {string} status - New status
   * @param {Object} metadata - Additional metadata to merge
   */
  updateInstance(instanceId, status, metadata = {}) {
    const instanceIndex = this.instances.findIndex(i => i.id === instanceId);

    if (instanceIndex >= 0) {
      this.instances[instanceIndex] = {
        ...this.instances[instanceIndex],
        status,
        lastUpdated: new Date().toISOString(),
        ...metadata
      };

      return this.instances[instanceIndex];
    }

    return null;
  },

  /**
   * Get all active (non-terminated) instances
   */
  getActiveInstances() {
    return this.instances.filter(i =>
      i.status !== 'terminated' && i.status !== 'destroyed'
    );
  },

  /**
   * Get a specific instance by ID
   * @param {string} instanceId - Vultr instance ID
   */
  getInstance(instanceId) {
    return this.instances.find(i => i.id === instanceId);
  },

  /**
   * Get all instances for a specific user
   * @param {string} userId - Discord user ID
   */
  getUserInstances(userId) {
    return this.instances.filter(i => i.creator.id === userId);
  }
};

// Server creation state - tracks in-progress creations
export const serverCreationState = new Map();
