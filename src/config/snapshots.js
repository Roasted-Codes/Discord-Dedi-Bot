export const DEFAULT_DEDI_SNAPSHOT_KEY = 'classic_v2_1';

export const DEDI_SNAPSHOT_CHOICES = Object.freeze([
  Object.freeze({
    key: 'classic',
    label: 'Classic Dedi',
    id: '7307de02-528b-445a-9443-91c13e90a734',
    public: true,
    plan: 'voc-c-2c-4gb-50s-amd',
    description: 'Stable classic Docker Xemu/XLink image with xemu 0.8.76 and the original low-lag runtime.'
  }),
  Object.freeze({
    key: 'classic_v2',
    label: 'Classic V2',
    id: 'bbe476f9-8a2d-4304-b9cf-1a4d1cb83170',
    public: true,
    plan: 'voc-c-2c-4gb-50s-amd',
    description: 'Classic Dedi plus StatsBorg agent/QMP support and Dedi-Bot identity/XLink autologin prep; keeps classic xemu.'
  }),
  Object.freeze({
    key: 'classic_v2_1',
    label: 'Classic V2.1',
    id: '362659cf-47a1-4e9c-aabc-3dbc5710f46a',
    public: true,
    plan: 'voc-c-2c-4gb-50s-amd',
    description: 'Classic V2 with the Real Ones V2 Leadership Pass ISO, no external passleader automation, no automatic savestate loading, StatsBorg export, and Dedi-Bot XLink autologin/arena prep.'
  }),
  Object.freeze({
    key: 'auto_dedi_rc',
    label: 'Release Candidate - Auto Dedi',
    id: 'd547f241-4364-453c-9846-199d94103e83',
    public: false,
    plan: 'voc-c-2c-4gb-50s-amd',
    description: 'Hidden RC image with newer xemu and the experimental auto-dedi stats stack; retained for admin testing.'
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

export function getDediPublicSnapshotChoices() {
  return DEDI_SNAPSHOT_CHOICES.filter(snapshot => snapshot.public !== false);
}

export function getDediSnapshotDiscordChoices() {
  return getDediPublicSnapshotChoices().map(snapshot => ({
    name: snapshot.label,
    value: snapshot.key
  }));
}

export function formatDediSnapshotDescription(snapshot) {
  return snapshot?.description || 'No snapshot notes recorded.';
}
