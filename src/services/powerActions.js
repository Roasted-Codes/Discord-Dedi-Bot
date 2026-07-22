export function formatPowerActionMessage(result) {
  if (result.status === 'completed' && result.action === 'restart') {
    return 'Restart completed and the server returned to running.';
  }
  if (result.status === 'completed' && result.action === 'start') {
    return 'The stopped server was started and is now running.';
  }

  const messages = {
    accepted_unconfirmed: 'The restart request was accepted, but completion was not confirmed within two minutes. Check the Vultr console before retrying.',
    timed_out: 'The start request was accepted, but the server did not reach running state within two minutes. Check the Vultr console before retrying.',
    busy: 'A power action is already in progress for this server.',
    not_found: 'This server is no longer available for management.',
    failed: 'The provider power request failed. No success was assumed.'
  };

  if (result.status === 'unsupported') {
    return `The server is currently in an unsupported power state (${result.powerStatus || 'unknown'}). Try again after the state settles.`;
  }
  return messages[result.status] || 'The power request finished with an unknown result.';
}

export function createPowerActionCoordinator({
  getInstance,
  startInstance,
  restartInstance,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  verificationAttempts = 24,
  verificationIntervalMs = 5000
}) {
  const activeOperations = new Set();

  async function verifyRestart(instanceId) {
    let sawTransition = false;
    for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
      await sleep(verificationIntervalMs);
      try {
        const observed = await getInstance(instanceId);
        const powerStatus = observed?.power_status;
        if (powerStatus && powerStatus !== 'running') {
          sawTransition = true;
        } else if (sawTransition && powerStatus === 'running') {
          return true;
        }
      } catch {
        // Provider reads can fail transiently; verification remains bounded.
      }
    }
    return false;
  }

  return async function executePowerAction(instanceId) {
    if (activeOperations.has(instanceId)) {
      return { status: 'busy' };
    }

    activeOperations.add(instanceId);
    let action = null;
    try {
      const instance = await getInstance(instanceId);
      if (!instance) {
        return { status: 'not_found' };
      }

      if (instance.power_status === 'running') {
        action = 'restart';
        await restartInstance(instanceId);
        const restartVerified = await verifyRestart(instanceId);
        return restartVerified
          ? { status: 'completed', action }
          : { status: 'accepted_unconfirmed', action };
      }

      if (instance.power_status === 'stopped') {
        action = 'start';
        const reachedRunning = await startInstance(instanceId);
        return reachedRunning
          ? { status: 'completed', action }
          : { status: 'timed_out', action };
      }

      return {
        status: 'unsupported',
        powerStatus: instance.power_status || 'unknown'
      };
    } catch {
      return action
        ? { status: 'failed', action }
        : { status: 'failed' };
    } finally {
      activeOperations.delete(instanceId);
    }
  };
}
