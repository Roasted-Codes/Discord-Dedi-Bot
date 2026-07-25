const deletionsInFlight = new Set();

export async function submitUnlockedDeletion({
  instanceId,
  deleteInstance,
  runUnlocked
}) {
  if (typeof runUnlocked !== 'function') {
    throw new TypeError('runUnlocked is required for serialized deletion protection');
  }
  if (deletionsInFlight.has(instanceId)) {
    return { submitted: false, locked: false, inFlight: true };
  }

  deletionsInFlight.add(instanceId);
  try {
    return await runUnlocked(instanceId, () => deleteInstance(instanceId));
  } finally {
    deletionsInFlight.delete(instanceId);
  }
}

export function shouldInitializeSelfDestructTimer({ tracked, isLocked }) {
  return Boolean(tracked && !tracked.selfDestructTimer && !isLocked(tracked.id));
}

export async function submitSelfDestructDeletion({
  tracked,
  isLocked,
  deleteInstance,
  runUnlocked,
  state
}) {
  const result = await submitUnlockedDeletion({
    instanceId: tracked.id,
    deleteInstance,
    runUnlocked
  });

  if (result.locked) {
    state.updateInstance(tracked.id, tracked.status, {
      selfDestructTimer: null
    });
  }

  return result;
}
