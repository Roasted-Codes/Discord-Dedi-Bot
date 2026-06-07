export const DEFAULT_DEDI_SNAPSHOT_KEY = 'classic';

export const DEDI_SNAPSHOT_CHOICES = Object.freeze([
  Object.freeze({
    key: 'classic',
    label: 'Classic',
    id: '7307de02-528b-445a-9443-91c13e90a734'
  }),
  Object.freeze({
    key: 'auto_dedi_rc',
    label: 'Release Candidate - Auto Dedi',
    id: '4a7bb8d6-1766-4cdf-9314-dacc3e80479b'
  })
]);

const snapshotsByKey = new Map(DEDI_SNAPSHOT_CHOICES.map(snapshot => [snapshot.key, snapshot]));
const snapshotsById = new Map(DEDI_SNAPSHOT_CHOICES.map(snapshot => [snapshot.id, snapshot]));

export function getDediSnapshotChoice(key = DEFAULT_DEDI_SNAPSHOT_KEY) {
  const snapshotKey = key || DEFAULT_DEDI_SNAPSHOT_KEY;
  const snapshot = snapshotsByKey.get(snapshotKey);

  if (!snapshot) {
    throw new Error(`Unsupported snapshot selection: ${snapshotKey}`);
  }

  return snapshot;
}

export function getDediSnapshotChoiceById(snapshotId) {
  return snapshotsById.get(snapshotId) || null;
}

export function getDediSnapshotDiscordChoices() {
  return DEDI_SNAPSHOT_CHOICES.map(snapshot => ({
    name: snapshot.label,
    value: snapshot.key
  }));
}
