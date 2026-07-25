import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverbot-locks-'));
const locksFile = path.join(tempDir, 'server-locks.json');
const previousLocksFile = process.env.SERVER_LOCKS_FILE;
process.env.SERVER_LOCKS_FILE = locksFile;

test.beforeEach(() => {
  fs.rmSync(locksFile, { force: true });
  fs.rmSync(`${locksFile}.tmp`, { force: true });
  fs.writeFileSync(locksFile, '{"locks":[]}\n', { mode: 0o600 });
});

test.after(() => {
  if (previousLocksFile === undefined) delete process.env.SERVER_LOCKS_FILE;
  else process.env.SERVER_LOCKS_FILE = previousLocksFile;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a missing initialized lock file fails closed', async () => {
  const { getServerLock, isServerLocked } = await import('../src/services/serverLocks.js');
  fs.rmSync(locksFile);

  assert.throws(() => getServerLock('instance-1'), /server locks file is missing/i);
  assert.throws(() => isServerLocked('instance-1'), /server locks file is missing/i);
  assert.equal(fs.existsSync(locksFile), false);
});

test('locking a server persists a durable lock record', async () => {
  const { getServerLock, isServerLocked, lockServer } = await import('../src/services/serverLocks.js');

  const lock = await lockServer({
    instanceId: 'instance-1',
    serverLabel: 'Dallas Server',
    lockedBy: 'discord-user-1'
  });

  assert.deepEqual(getServerLock('instance-1'), lock);
  assert.equal(isServerLocked('instance-1'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(locksFile, 'utf8')), { locks: [lock] });
  assert.deepEqual(lock, {
    instance_id: 'instance-1',
    server_label: 'Dallas Server',
    locked_by: 'discord-user-1',
    locked_at: lock.locked_at
  });
  assert.equal(new Date(lock.locked_at).toISOString(), lock.locked_at);
});

test('locking the same server repeatedly is idempotent', async () => {
  const { lockServer } = await import('../src/services/serverLocks.js');
  const request = {
    instanceId: 'instance-1',
    serverLabel: 'Dallas Server',
    lockedBy: 'discord-user-1'
  };

  const first = await lockServer(request);
  const second = await lockServer(request);

  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(fs.readFileSync(locksFile, 'utf8')), { locks: [first] });
});

test('unlocking a server removes its persisted lock', async () => {
  const { isServerLocked, lockServer, unlockServer } = await import('../src/services/serverLocks.js');
  await lockServer({
    instanceId: 'instance-1',
    serverLabel: 'Dallas Server',
    lockedBy: 'discord-user-1'
  });

  assert.equal(await unlockServer('instance-1'), true);
  assert.equal(isServerLocked('instance-1'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(locksFile, 'utf8')), { locks: [] });
});

test('malformed JSON reports the lock file path clearly', async () => {
  const { getServerLock } = await import('../src/services/serverLocks.js');
  fs.writeFileSync(locksFile, '{not-json');

  assert.throws(
    () => getServerLock('instance-1'),
    error => {
      assert.match(error.message, /^Invalid JSON in server locks file /);
      assert.match(error.message, /server-locks\.json:/);
      return true;
    }
  );
});

test('a malformed lock registry schema reports the expected shape', async () => {
  const { getServerLock } = await import('../src/services/serverLocks.js');
  fs.writeFileSync(locksFile, JSON.stringify({ locks: {} }));

  assert.throws(
    () => getServerLock('instance-1'),
    error => {
      assert.match(error.message, /^Invalid server locks schema in /);
      assert.match(error.message, /must contain \{"locks":\[\.\.\.\]\}\.$/);
      return true;
    }
  );
});

test('a malformed lock record identifies the invalid field', async () => {
  const { getServerLock } = await import('../src/services/serverLocks.js');
  fs.writeFileSync(locksFile, JSON.stringify({
    locks: [{
      instance_id: 'instance-1',
      server_label: 'Dallas Server',
      locked_at: '2026-07-25T00:00:00.000Z'
    }]
  }));

  assert.throws(
    () => getServerLock('instance-1'),
    /Invalid server lock at index 0 .*locked_by/
  );
});

test('lock writes reject invalid record fields before changing the registry', async () => {
  const { lockServer } = await import('../src/services/serverLocks.js');
  const invalidInputs = [
    { instanceId: '', serverLabel: 'Server', lockedBy: 'admin' },
    { instanceId: '   ', serverLabel: 'Server', lockedBy: 'admin' },
    { instanceId: 'instance-1', serverLabel: '', lockedBy: 'admin' },
    { instanceId: 'instance-1', serverLabel: 'Server', lockedBy: '' }
  ];

  for (const input of invalidInputs) {
    await assert.rejects(lockServer(input), /must be a non-empty string/);
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(locksFile, 'utf8')), { locks: [] });
});

test('concurrent lock writes are serialized without losing records', async () => {
  const { lockServer } = await import('../src/services/serverLocks.js');
  const instanceIds = Array.from({ length: 12 }, (_, index) => `instance-${index + 1}`);

  await Promise.all(instanceIds.map(instanceId => lockServer({
    instanceId,
    serverLabel: `Server ${instanceId}`,
    lockedBy: 'discord-user-1'
  })));

  const persistedIds = JSON.parse(fs.readFileSync(locksFile, 'utf8'))
    .locks
    .map(lock => lock.instance_id)
    .sort();
  assert.deepEqual(persistedIds, [...instanceIds].sort());
});

test('writes use unique 0600 temporary files before rename and fsync the parent directory', async () => {
  const { lockServer } = await import('../src/services/serverLocks.js');
  const originalRename = fs.promises.rename;
  const originalOpen = fs.promises.open;
  const renameCalls = [];
  const syncedPaths = [];
  fs.promises.rename = async (...args) => {
    renameCalls.push(args);
    return originalRename(...args);
  };
  fs.promises.open = async (target, ...args) => {
    const handle = await originalOpen(target, ...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      syncedPaths.push(target);
      return originalSync();
    };
    return handle;
  };

  try {
    await lockServer({
      instanceId: 'instance-1',
      serverLabel: 'Dallas Server',
      lockedBy: 'discord-user-1'
    });
    await lockServer({
      instanceId: 'instance-2',
      serverLabel: 'Seattle Server',
      lockedBy: 'discord-user-1'
    });
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.open = originalOpen;
  }

  assert.equal(renameCalls.length, 2);
  const temporaryFiles = renameCalls.map(([temporaryFile, targetFile]) => {
    assert.equal(targetFile, locksFile);
    assert.match(temporaryFile, new RegExp(`^${locksFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-`));
    return temporaryFile;
  });
  assert.notEqual(temporaryFiles[0], temporaryFiles[1]);
  assert.deepEqual(syncedPaths, [
    temporaryFiles[0], path.dirname(locksFile),
    temporaryFiles[1], path.dirname(locksFile)
  ]);
  assert.equal(fs.statSync(locksFile).mode & 0o777, 0o600);
  for (const temporaryFile of temporaryFiles) {
    assert.equal(fs.existsSync(temporaryFile), false);
  }
});

test('exclusive-create collisions never delete a temporary file owned by another writer', async () => {
  const { lockServer } = await import('../src/services/serverLocks.js');
  const originalOpen = fs.promises.open;
  const originalWriteFile = fs.promises.writeFile;
  const collisionContents = 'pre-existing collision\n';
  let collisionFile;

  const createCollision = target => {
    collisionFile = target;
    fs.writeFileSync(target, collisionContents, { mode: 0o600 });
  };

  fs.promises.open = async (target, flags, ...args) => {
    if (flags === 'wx') {
      createCollision(target);
    }
    return originalOpen(target, flags, ...args);
  };
  fs.promises.writeFile = async (target, data, options) => {
    if (options?.flag === 'wx') {
      createCollision(target);
    }
    return originalWriteFile(target, data, options);
  };

  try {
    await assert.rejects(
      lockServer({
        instanceId: 'instance-1',
        serverLabel: 'Dallas Server',
        lockedBy: 'discord-user-1'
      }),
      error => error?.code === 'EEXIST'
    );
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.writeFile = originalWriteFile;
  }

  assert.notEqual(collisionFile, undefined);
  assert.equal(fs.existsSync(collisionFile), true);
  assert.equal(fs.readFileSync(collisionFile, 'utf8'), collisionContents);
  fs.rmSync(collisionFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(locksFile, 'utf8')), { locks: [] });
});

test('empty provider inventory never prunes persisted server locks', async () => {
  const { getServerLock, lockServer, reconcileServerLocks } = await import('../src/services/serverLocks.js');
  await lockServer({
    instanceId: 'instance-1',
    serverLabel: 'Dallas Server',
    lockedBy: 'discord-user-1'
  });

  assert.deepEqual(
    await reconcileServerLocks([]),
    { skipped: true, reason: 'empty_inventory' }
  );
  assert.notEqual(getServerLock('instance-1'), null);
});

test('authoritative non-empty inventory prunes only locks for absent instances', async () => {
  const {
    getServerLock,
    lockServer,
    reconcileServerLocks
  } = await import('../src/services/serverLocks.js');
  await lockServer({
    instanceId: 'instance-present',
    serverLabel: 'Present Server',
    lockedBy: 'discord-user-1'
  });
  await lockServer({
    instanceId: 'instance-absent',
    serverLabel: 'Absent Server',
    lockedBy: 'discord-user-1'
  });

  assert.deepEqual(
    await reconcileServerLocks(
      [{ id: 'instance-present' }],
      async instanceId => instanceId === 'instance-absent'
    ),
    {
      skipped: false,
      removedInstanceIds: ['instance-absent'],
      remaining: 1
    }
  );
  assert.notEqual(getServerLock('instance-present'), null);
  assert.equal(getServerLock('instance-absent'), null);
});

test('reconciliation requires immediate absence confirmation before pruning', async () => {
  const { getServerLock, lockServer, reconcileServerLocks } = await import('../src/services/serverLocks.js');
  await lockServer({
    instanceId: 'stale-snapshot-instance',
    serverLabel: 'Newly Created Server',
    lockedBy: 'discord-user-1'
  });

  await assert.rejects(
    reconcileServerLocks([{ id: 'some-other-instance' }]),
    /confirmAbsent must be a function/
  );

  const result = await reconcileServerLocks(
    [{ id: 'some-other-instance' }],
    async () => false
  );

  assert.deepEqual(result, {
    skipped: false,
    removedInstanceIds: [],
    remaining: 1
  });
  assert.notEqual(getServerLock('stale-snapshot-instance'), null);
});

test('reconciliation errors preserve every candidate lock', async () => {
  const { getServerLock, lockServer, reconcileServerLocks } = await import('../src/services/serverLocks.js');
  await lockServer({
    instanceId: 'provider-error-instance',
    serverLabel: 'Provider Error Server',
    lockedBy: 'discord-user-1'
  });

  await assert.rejects(
    reconcileServerLocks(
      [{ id: 'some-other-instance' }],
      async () => {
        throw new Error('provider unavailable');
      }
    ),
    /provider unavailable/
  );
  assert.notEqual(getServerLock('provider-error-instance'), null);
});

test('invalid provider inventory cannot be mistaken for authoritative absence', async () => {
  const { reconcileServerLocks } = await import('../src/services/serverLocks.js');

  await assert.rejects(
    reconcileServerLocks(undefined),
    /provider inventory must be an array/
  );
});

test('only an explicit provider 404 proves one instance is absent', async () => {
  const { isAuthoritativeInstanceAbsence } = await import('../src/services/serverLocks.js');

  assert.equal(isAuthoritativeInstanceAbsence({ response: { status: 404 } }), true);
  assert.equal(isAuthoritativeInstanceAbsence({ response: { status: 403 } }), false);
  assert.equal(isAuthoritativeInstanceAbsence(new Error('network unavailable')), false);
  assert.equal(isAuthoritativeInstanceAbsence(null), false);
});

test('final unlocked operation is serialized behind an earlier lock mutation', async () => {
  const { lockServer, runIfServerUnlocked } = await import('../src/services/serverLocks.js');
  let actionCalls = 0;

  const locking = lockServer({
    instanceId: 'ordered-instance',
    serverLabel: 'Ordered',
    lockedBy: 'admin-1'
  });
  const guarded = runIfServerUnlocked('ordered-instance', async () => {
    actionCalls += 1;
  });

  await locking;
  assert.deepEqual(await guarded, { submitted: false, locked: true });
  assert.equal(actionCalls, 0);
});

test('concurrent opposite desired-state requests commit in queue order', async () => {
  const {
    isServerLocked,
    lockServer,
    setServerLockState
  } = await import('../src/services/serverLocks.js');
  await lockServer({ instanceId: 'instance-race', serverLabel: 'Race', lockedBy: 'admin-1' });

  const originalRename = fs.promises.rename;
  let releaseFirstWrite;
  let signalFirstWrite;
  let pauseNextWrite = true;
  const firstWriteStarted = new Promise(resolve => { signalFirstWrite = resolve; });
  const firstWritePending = new Promise(resolve => { releaseFirstWrite = resolve; });

  fs.promises.rename = async (...args) => {
    if (pauseNextWrite) {
      pauseNextWrite = false;
      signalFirstWrite();
      await firstWritePending;
    }
    return originalRename(...args);
  };

  try {
    const unlockPending = setServerLockState({ instanceId: 'instance-race', locked: false });
    await firstWriteStarted;
    const relockPending = setServerLockState({
      instanceId: 'instance-race',
      locked: true,
      serverLabel: 'Race',
      lockedBy: 'admin-2'
    });
    releaseFirstWrite();

    assert.deepEqual(await unlockPending, { changed: true, locked: false, lock: null });
    assert.equal((await relockPending).changed, true);
    assert.equal(isServerLocked('instance-race'), true);
  } finally {
    fs.promises.rename = originalRename;
    releaseFirstWrite();
  }
});

test('default registry path is stable when the process working directory changes', async () => {
  const { getServerLocksFile } = await import('../src/services/serverLocks.js');
  const originalCwd = process.cwd();
  const configuredPath = process.env.SERVER_LOCKS_FILE;

  try {
    delete process.env.SERVER_LOCKS_FILE;
    const before = getServerLocksFile();
    process.chdir(tempDir);
    const after = getServerLocksFile();

    assert.equal(after, before);
    assert.match(after, /data\/server-locks\.json$/);
  } finally {
    process.chdir(originalCwd);
    process.env.SERVER_LOCKS_FILE = configuredPath;
  }
});
