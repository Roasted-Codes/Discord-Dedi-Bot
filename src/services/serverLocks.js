import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOCKS_FILE = fileURLToPath(
  new URL('../../data/server-locks.json', import.meta.url)
);

let mutationQueue = Promise.resolve();

export function getServerLocksFile() {
  return process.env.SERVER_LOCKS_FILE
    ? path.resolve(process.cwd(), process.env.SERVER_LOCKS_FILE)
    : DEFAULT_LOCKS_FILE;
}

function loadLocks() {
  const locksFile = getServerLocksFile();
  if (!fs.existsSync(locksFile)) {
    throw new Error(`Server locks file is missing: ${locksFile}`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(locksFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in server locks file ${locksFile}: ${error.message}`);
  }

  if (!data || !Array.isArray(data.locks)) {
    throw new Error(`Invalid server locks schema in ${locksFile}: must contain {"locks":[...]}.`);
  }

  data.locks.forEach((lock, index) => {
    for (const field of ['instance_id', 'server_label', 'locked_by']) {
      if (typeof lock?.[field] !== 'string' || !lock[field].trim()) {
        throw new Error(`Invalid server lock at index ${index} in ${locksFile}: ${field} must be a non-empty string.`);
      }
    }

    if (typeof lock.locked_at !== 'string' ||
        !Number.isFinite(Date.parse(lock.locked_at)) ||
        new Date(lock.locked_at).toISOString() !== lock.locked_at) {
      throw new Error(`Invalid server lock at index ${index} in ${locksFile}: locked_at must be an ISO-8601 timestamp.`);
    }
  });

  return data.locks;
}

async function saveLocks(locks) {
  const locksFile = getServerLocksFile();
  const tempFile = `${locksFile}.tmp-${process.pid}-${randomUUID()}`;
  await fs.promises.mkdir(path.dirname(locksFile), { recursive: true, mode: 0o700 });
  let temporaryFileOwned = false;
  try {
    const tempHandle = await fs.promises.open(tempFile, 'wx', 0o600);
    temporaryFileOwned = true;
    try {
      await tempHandle.writeFile(`${JSON.stringify({ locks }, null, 2)}\n`, 'utf8');
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await fs.promises.chmod(tempFile, 0o600);
    await fs.promises.rename(tempFile, locksFile);
    temporaryFileOwned = false;
    const directoryHandle = await fs.promises.open(path.dirname(locksFile), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryFileOwned) {
      await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    }
  }
}

function withMutationLock(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

export function getServerLock(instanceId) {
  return loadLocks().find(lock => lock.instance_id === instanceId) || null;
}

export function isServerLocked(instanceId) {
  return getServerLock(instanceId) !== null;
}

export function isAuthoritativeInstanceAbsence(error) {
  return error?.response?.status === 404;
}

export function setServerLockState({ instanceId, locked, serverLabel, lockedBy }) {
  return withMutationLock(async () => {
    if (typeof locked !== 'boolean') {
      throw new TypeError('locked must be a boolean');
    }
    const requiredFields = locked
      ? { instanceId, serverLabel, lockedBy }
      : { instanceId };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${field} must be a non-empty string`);
      }
    }

    const locks = loadLocks();
    const existing = locks.find(lock => lock.instance_id === instanceId);
    if (locked) {
      if (existing) {
        return { changed: false, locked: true, lock: existing };
      }

      const lock = {
        instance_id: instanceId,
        server_label: serverLabel,
        locked_by: lockedBy,
        locked_at: new Date().toISOString()
      };
      await saveLocks([...locks, lock]);
      return { changed: true, locked: true, lock };
    }

    if (!existing) {
      return { changed: false, locked: false, lock: null };
    }

    await saveLocks(locks.filter(lock => lock.instance_id !== instanceId));
    return { changed: true, locked: false, lock: null };
  });
}

export async function lockServer({ instanceId, serverLabel, lockedBy }) {
  const result = await setServerLockState({
    instanceId,
    locked: true,
    serverLabel,
    lockedBy
  });
  return result.lock;
}

export async function unlockServer(instanceId) {
  const result = await setServerLockState({ instanceId, locked: false });
  return result.changed;
}

export function runIfServerUnlocked(instanceId, action) {
  if (typeof instanceId !== 'string' || !instanceId) {
    throw new Error('instanceId is required for a lock-guarded operation');
  }
  if (typeof action !== 'function') {
    throw new Error('action is required for a lock-guarded operation');
  }

  return withMutationLock(async () => {
    const locks = loadLocks();
    if (locks.some(lock => lock.instance_id === instanceId)) {
      return { submitted: false, locked: true };
    }

    await action();
    return { submitted: true, locked: false };
  });
}

export async function reconcileServerLocks(instances, confirmAbsent) {
  if (!Array.isArray(instances)) {
    throw new TypeError('provider inventory must be an array');
  }
  if (instances.length === 0) {
    return { skipped: true, reason: 'empty_inventory' };
  }
  if (typeof confirmAbsent !== 'function') {
    throw new TypeError('confirmAbsent must be a function');
  }

  const providerIds = new Set();
  for (const [index, instance] of instances.entries()) {
    if (typeof instance?.id !== 'string' || !instance.id.trim()) {
      throw new TypeError(`provider inventory item ${index} must have a non-empty string id`);
    }
    providerIds.add(instance.id);
  }

  return withMutationLock(async () => {
    const locks = loadLocks();
    const removalCandidates = locks.filter(lock => !providerIds.has(lock.instance_id));
    const removedInstanceIds = [];

    for (const lock of removalCandidates) {
      const absent = await confirmAbsent(lock.instance_id);
      if (typeof absent !== 'boolean') {
        throw new TypeError('confirmAbsent must resolve to a boolean');
      }
      if (absent) removedInstanceIds.push(lock.instance_id);
    }

    const removedIds = new Set(removedInstanceIds);
    const remainingLocks = locks.filter(lock => !removedIds.has(lock.instance_id));

    if (removedInstanceIds.length > 0) {
      await saveLocks(remainingLocks);
    }

    return {
      skipped: false,
      removedInstanceIds,
      remaining: remainingLocks.length
    };
  });
}
