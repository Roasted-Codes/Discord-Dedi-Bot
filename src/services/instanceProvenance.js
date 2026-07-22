export function buildRecoveredInstanceMetadata({
  instance,
  assignment = null,
  configuredSnapshot = null,
  providerSnapshot = null
}) {
  const snapshotId = instance.snapshot_id || assignment?.snapshot_id || configuredSnapshot?.id || null;
  const snapshotLabel = assignment?.snapshot_label ||
    configuredSnapshot?.label ||
    providerSnapshot?.description ||
    snapshotId ||
    'Unknown snapshot';

  return {
    userId: assignment?.creator_id || 'unknown',
    creatorName: assignment?.creator || 'System Recovery',
    snapshotId,
    snapshotKey: configuredSnapshot?.key || null,
    snapshotLabel,
    createdAt: instance.date_created || assignment?.assigned_at || new Date().toISOString()
  };
}
