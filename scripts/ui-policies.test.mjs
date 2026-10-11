import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERAL_WORKSPACE_VALUE,
  makeNewChatPayload,
  preferredNewChatWorkspace,
} from '../src/lib/new-chat-policy.mjs';
import {
  followsLiveEdge,
  followsMessages,
  shouldLoadOlder,
} from '../src/lib/thread-scroll-policy.mjs';

const directories = [
  { directory: '/projects/alpha', name: 'Alpha' },
  { directory: '/projects/beta', name: 'Beta' },
];

test('new chat workspace follows project, active chat, then saved preference', () => {
  assert.equal(preferredNewChatWorkspace(directories, '/projects/beta', '/projects/alpha', '/projects/alpha'), '/projects/beta');
  assert.equal(preferredNewChatWorkspace(directories, null, '/projects/alpha', '/projects/beta'), '/projects/alpha');
  assert.equal(preferredNewChatWorkspace(directories, null, null, '/projects/beta'), '/projects/beta');
});

test('stale workspace preference is ignored and ambiguous lists stay unselected', () => {
  assert.equal(preferredNewChatWorkspace(directories, null, null, '/deleted/project'), '');
  assert.equal(preferredNewChatWorkspace([directories[0]], null, null, '/deleted/project'), '/projects/alpha');
});

test('new chat payload preserves the selected engine and General means no workspace', () => {
  assert.deepEqual(makeNewChatPayload('opencode', '/projects/alpha'), {
    title: 'New conversation', engine: 'opencode', workspace: '/projects/alpha', mode: 'build',
  });
  assert.deepEqual(makeNewChatPayload('pi', GENERAL_WORKSPACE_VALUE), {
    title: 'New conversation', engine: 'pi', mode: 'build',
  });
});

test('prepend suppresses live-follow until the reader position is restored', () => {
  assert.equal(followsMessages(true, true), false);
  assert.equal(followsMessages(true, false), true);
  assert.equal(followsMessages(false, false), false);
});

test('upward motion near the live edge pauses follow; moving down resumes it', () => {
  assert.equal(followsLiveEdge(true, true), false);
  assert.equal(followsLiveEdge(true, false), true);
  assert.equal(followsLiveEdge(false, false), false);
});

test('older-page loading remains independent from bottom proximity', () => {
  assert.equal(shouldLoadOlder(0, true), true);
  assert.equal(shouldLoadOlder(56, true), true);
  assert.equal(shouldLoadOlder(57, true), false);
  assert.equal(shouldLoadOlder(0, false), false);
});
