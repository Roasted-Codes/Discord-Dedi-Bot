import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assignXlinkAccount,
  getXlinkAssignmentByInstanceId,
  updateXlinkAssignmentInstance
} from '../src/xlink/credentials.js';
import { buildRecoveredInstanceMetadata } from '../src/services/instanceProvenance.js';

test('startup recovery prefers persisted creator and manual snapshot label', () => {
  const recovered = buildRecoveredInstanceMetadata({
    instance: {
      id: 'instance-1',
      label: 'realones-test',
      region: 'dfw',
      snapshot_id: 'snapshot-1',
      date_created: '2026-07-22T00:00:00.000Z'
    },
    assignment: {
      creator: 'James',
      creator_id: 'discord-user-1',
      snapshot_id: 'snapshot-1',
      snapshot_label: 'Manual image'
    },
    configuredSnapshot: null,
    providerSnapshot: { id: 'snapshot-1', description: 'Provider image' }
  });

  assert.equal(recovered.userId, 'discord-user-1');
  assert.equal(recovered.creatorName, 'James');
  assert.equal(recovered.snapshotId, 'snapshot-1');
  assert.equal(recovered.snapshotLabel, 'Manual image');
});

test('startup recovery remains backward compatible with legacy assignments', () => {
  const recovered = buildRecoveredInstanceMetadata({
    instance: { id: 'instance-1', label: 'legacy', snapshot_id: 'configured-1' },
    assignment: { creator: 'LegacyUser' },
    configuredSnapshot: { id: 'configured-1', key: 'classic', label: 'Classic V2' }
  });

  assert.equal(recovered.userId, 'unknown');
  assert.equal(recovered.creatorName, 'LegacyUser');
  assert.equal(recovered.snapshotLabel, 'Classic V2');
});

test('XLink assignments persist safe panel provenance', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverbot-provenance-'));
  const accountsFile = path.join(tempDir, 'accounts.json');
  const assignmentsFile = path.join(tempDir, 'assignments.json');
  fs.writeFileSync(accountsFile, JSON.stringify({
    accounts: [{ xtag: 'test-account', password: 'test-password' }]
  }));

  const previousAccountsFile = process.env.XLINK_ACCOUNTS_FILE;
  const previousAssignmentsFile = process.env.XLINK_ASSIGNMENTS_FILE;
  process.env.XLINK_ACCOUNTS_FILE = accountsFile;
  process.env.XLINK_ASSIGNMENTS_FILE = assignmentsFile;

  try {
    const { assignment } = await assignXlinkAccount({
      serverId: 'realones-test',
      region: 'dfw',
      cityLabel: 'Dallas',
      creator: 'James',
      creatorId: 'discord-user-1',
      snapshotId: 'snapshot-1',
      snapshotLabel: 'Classic V2',
      random: () => 0
    });
    await updateXlinkAssignmentInstance(assignment.server_id, 'instance-1');

    assert.deepEqual(getXlinkAssignmentByInstanceId('instance-1'), {
      server_id: 'realones-test',
      vultr_instance_id: 'instance-1',
      xtag: 'test-account',
      region: 'dfw',
      city_label: 'Dallas',
      creator: 'James',
      creator_id: 'discord-user-1',
      snapshot_id: 'snapshot-1',
      snapshot_label: 'Classic V2',
      assigned_at: assignment.assigned_at
    });
  } finally {
    if (previousAccountsFile === undefined) delete process.env.XLINK_ACCOUNTS_FILE;
    else process.env.XLINK_ACCOUNTS_FILE = previousAccountsFile;
    if (previousAssignmentsFile === undefined) delete process.env.XLINK_ASSIGNMENTS_FILE;
    else process.env.XLINK_ASSIGNMENTS_FILE = previousAssignmentsFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
