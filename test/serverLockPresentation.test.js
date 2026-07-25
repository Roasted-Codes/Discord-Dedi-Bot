import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDestroyOption,
  buildServerLockOption,
  formatServerPanelHeading,
  formatServerProtectionLine
} from '../src/services/serverLockPresentation.js';

const instance = {
  id: 'instance-1',
  label: 'Overnight Image Work',
  power_status: 'running',
  main_ip: '203.0.113.10',
  region: 'dfw'
};

test('locked server presentation shows a padlock in the panel and destroy picker', () => {
  assert.equal(
    formatServerPanelHeading({
      statusEmoji: '🟢',
      serverName: instance.label,
      statusText: '',
      locked: true
    }),
    '🟢 🔒 **Overnight Image Work**\n'
  );
  assert.equal(formatServerProtectionLine(true), '> Protection: Locked by an administrator\n');

  const option = buildDestroyOption(instance, true);
  assert.deepEqual(option.emoji, { name: '🔒' });
  assert.match(option.description, /^LOCKED — protected by an administrator/);
  assert.equal(option.value, instance.id);
});

test('unlocked destroy options retain provider status context', () => {
  const option = buildDestroyOption(instance, false);

  assert.equal(option.label, instance.label);
  assert.equal(option.emoji, undefined);
  assert.match(option.description, /Status: running/);
  assert.match(option.description, /DFW/);
});

test('lock management options describe the current action and respect Discord limits', () => {
  const longInstance = {
    ...instance,
    id: 'instance-long',
    label: 'x'.repeat(140)
  };

  const lockedOption = buildServerLockOption(longInstance, true);
  const unlockedOption = buildServerLockOption(longInstance, false);

  assert.equal(lockedOption.label.length, 100);
  assert.equal(lockedOption.emoji.name, '🔒');
  assert.match(lockedOption.description, /select to unlock/i);
  assert.equal(lockedOption.value, 'unlock:instance-long');
  assert.equal(unlockedOption.emoji.name, '🔓');
  assert.match(unlockedOption.description, /select to lock/i);
  assert.equal(unlockedOption.value, 'lock:instance-long');
  assert.ok(lockedOption.description.length <= 100);
  assert.ok(unlockedOption.description.length <= 100);
});
