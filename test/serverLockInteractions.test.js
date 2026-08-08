import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleServerLocksButton,
  handleServerLocksPageButton
} from '../src/discord/handlers/buttons.js';
import { handleServerLockToggle } from '../src/discord/handlers/selectMenus.js';

function baseInteraction(overrides = {}) {
  return {
    customId: 'btn_server_locks',
    user: { id: 'admin-1', username: 'James' },
    reply: async () => {},
    deferReply: async () => {},
    deferUpdate: async () => {},
    editReply: async () => {},
    ...overrides
  };
}

test('server-lock button denies non-admins before listing instances', async () => {
  const replies = [];
  let listCalls = 0;
  const interaction = baseInteraction({
    user: { id: 'friend-1', username: 'Friend' },
    reply: async payload => { replies.push(payload); }
  });

  await handleServerLocksButton(interaction, {
    isAdmin: () => false,
    list: async () => { listCalls += 1; return []; },
    isLocked: () => false
  });

  assert.equal(listCalls, 0);
  assert.match(replies[0].content, /administrators/i);
  assert.equal(replies[0].ephemeral, true);
});

test('server-lock button gives admins an ephemeral lock-state picker', async () => {
  const events = [];
  const edits = [];
  const interaction = baseInteraction({
    deferReply: async payload => { events.push(['defer', payload]); },
    editReply: async payload => { events.push(['edit', payload]); edits.push(payload); }
  });

  await handleServerLocksButton(interaction, {
    isAdmin: () => true,
    list: async () => {
      events.push(['list']);
      return [
        { id: 'one', label: 'Protected', status: 'active', power_status: 'running' },
        { id: 'two', label: 'Open', status: 'active', power_status: 'running' }
      ];
    },
    isLocked: instanceId => instanceId === 'one'
  });

  assert.deepEqual(events.map(event => event[0]), ['defer', 'list', 'edit']);
  assert.equal(events[0][1].ephemeral, true);
  const menu = edits[0].components[0].toJSON().components[0];
  assert.equal(menu.custom_id, 'server_lock_toggle');
  assert.equal(menu.options[0].emoji.name, '🔒');
  assert.equal(menu.options[0].value, 'unlock:one');
  assert.equal(menu.options[1].emoji.name, '🔓');
  assert.equal(menu.options[1].value, 'lock:two');
});

test('server-lock controls paginate beyond Discord twenty-five-option limit', async () => {
  const instances = Array.from({ length: 26 }, (_, index) => ({
    id: `instance-${index + 1}`,
    label: `Server ${index + 1}`,
    status: 'active',
    power_status: 'running'
  }));
  const firstPageEdits = [];
  await handleServerLocksButton(baseInteraction({
    editReply: async payload => { firstPageEdits.push(payload); }
  }), {
    isAdmin: () => true,
    list: async () => instances,
    isLocked: () => false
  });

  const firstPage = firstPageEdits[0];
  assert.equal(firstPage.components[0].toJSON().components[0].options.length, 25);
  assert.equal(firstPage.components[1].toJSON().components[0].custom_id, 'server_locks_page_1');

  const events = [];
  const secondPageEdits = [];
  await handleServerLocksPageButton(baseInteraction({
    customId: 'server_locks_page_1',
    deferUpdate: async () => { events.push('defer'); },
    editReply: async payload => { secondPageEdits.push(payload); }
  }), 1, {
    isAdmin: () => true,
    list: async () => instances,
    isLocked: () => false
  });

  assert.deepEqual(events, ['defer']);
  const secondPage = secondPageEdits[0];
  const secondMenu = secondPage.components[0].toJSON().components[0];
  assert.equal(secondMenu.options.length, 1);
  assert.equal(secondMenu.options[0].value, 'lock:instance-26');
  assert.equal(secondPage.components[1].toJSON().components[0].custom_id, 'server_locks_page_0');
});

test('server-lock toggle rechecks admin permission before mutating state', async () => {
  const replies = [];
  let writes = 0;
  const interaction = baseInteraction({
    customId: 'server_lock_toggle',
    user: { id: 'friend-1', username: 'Friend' },
    values: ['lock:instance-1'],
    reply: async payload => { replies.push(payload); }
  });

  await handleServerLockToggle(interaction, {
    isAdmin: () => false,
    setLockState: async () => { writes += 1; }
  });

  assert.equal(writes, 0);
  assert.match(replies[0].content, /administrators/i);
});

test('locking persists protection before cancelling the self-destruct timer', async () => {
  const events = [];
  const edits = [];
  const tracked = {
    id: 'instance-1',
    status: 'running',
    selfDestructTimer: { expiresAt: Date.now() + 1000 }
  };
  const interaction = baseInteraction({
    customId: 'server_lock_toggle',
    values: ['lock:instance-1'],
    deferUpdate: async () => { events.push('defer'); },
    editReply: async payload => { edits.push(payload); }
  });

  await handleServerLockToggle(interaction, {
    isAdmin: () => true,
    fetchInstance: async () => ({ id: 'instance-1', label: 'Overnight Image' }),
    setLockState: async desired => {
      assert.equal(desired.locked, true);
      events.push('lock');
      return { changed: true, locked: true };
    },
    state: {
      getInstance: () => tracked,
      updateInstance: (id, status, metadata) => {
        events.push('timer-cancel');
        Object.assign(tracked, metadata);
      }
    },
    refreshPanel: async () => { events.push('refresh'); }
  });

  assert.deepEqual(events, ['defer', 'lock', 'timer-cancel', 'refresh']);
  assert.equal(tracked.selfDestructTimer, null);
  assert.match(edits[0].content, /locked/i);
  assert.match(edits[0].content, /timer.*cancelled/i);
  assert.deepEqual(edits[0].components, []);
});

test('unlocking leaves timers unset and reports success even if panel refresh fails', async () => {
  const edits = [];
  let unlockCalls = 0;
  const interaction = baseInteraction({
    customId: 'server_lock_toggle',
    values: ['unlock:instance-2'],
    editReply: async payload => { edits.push(payload); }
  });

  await handleServerLockToggle(interaction, {
    isAdmin: () => true,
    fetchInstance: async () => ({ id: 'instance-2', label: 'Protected' }),
    setLockState: async desired => {
      assert.equal(desired.locked, false);
      unlockCalls += 1;
      return { changed: true, locked: false };
    },
    state: {
      getInstance: () => ({ id: 'instance-2', status: 'running', selfDestructTimer: null }),
      updateInstance: () => { throw new Error('timer should not be changed'); }
    },
    refreshPanel: async () => { throw new Error('Discord unavailable'); }
  });

  assert.equal(unlockCalls, 1);
  assert.match(edits[0].content, /unlocked/i);
});

test('stale desired-action options are idempotent and never invert current lock state', async () => {
  let setCalls = 0;
  const edits = [];
  const interaction = baseInteraction({
    customId: 'server_lock_toggle',
    values: ['lock:instance-3'],
    editReply: async payload => { edits.push(payload); }
  });

  await handleServerLockToggle(interaction, {
    isAdmin: () => true,
    fetchInstance: async () => ({ id: 'instance-3', label: 'Already Protected' }),
    setLockState: async desired => {
      assert.equal(desired.locked, true);
      setCalls += 1;
      return { changed: false, locked: true };
    },
    state: { getInstance: () => null, updateInstance: () => {} },
    refreshPanel: null
  });

  assert.equal(setCalls, 1);
  assert.match(edits[0].content, /already locked/i);
});

test('a committed lock remains a reported success when timer cancellation fails', async () => {
  const edits = [];
  const interaction = baseInteraction({
    customId: 'server_lock_toggle',
    values: ['lock:instance-4'],
    editReply: async payload => { edits.push(payload); }
  });

  await handleServerLockToggle(interaction, {
    isAdmin: () => true,
    fetchInstance: async () => ({ id: 'instance-4', label: 'Protected' }),
    setLockState: async () => ({ changed: true, locked: true }),
    state: {
      getInstance: () => ({ status: 'running', selfDestructTimer: { expiresAt: 1 } }),
      updateInstance: () => { throw new Error('state unavailable'); }
    },
    refreshPanel: null
  });

  assert.match(edits[0].content, /is locked/i);
  assert.doesNotMatch(edits[0].content, /could not be changed/i);
});
