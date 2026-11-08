import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildParticipantAwareness,
  buildParticipantNameForms,
  findParticipantIdentity,
  normalizeParticipantName,
  participantNameKey,
} from '../src/components/participant-awareness.js';

test('participant names normalize NFC, leading mentions, separators, and whitespace', () => {
  assert.equal(
    normalizeParticipantName('Jose\u0301  Smith'),
    'Jos\u00e9 Smith',
  );
  assert.equal(normalizeParticipantName('  @@@Alice  '), 'Alice');
  assert.equal(
    normalizeParticipantName('Please_Getout-Daily'),
    'Please Getout Daily',
  );
  assert.equal(
    normalizeParticipantName('  Alice \t Smith \n Jones '),
    'Alice Smith Jones',
  );
  assert.equal(participantNameKey('  @ALICE  Smith '), 'alice smith');
});

test('participant forms include canonical, first-name, and joined variants', () => {
  assert.deepEqual(
    buildParticipantNameForms('Alice Smith'),
    ['Alice Smith', 'Alice', 'AliceSmith'],
  );
  assert.deepEqual(
    buildParticipantNameForms('@Alice_Smith-Jr'),
    ['Alice Smith Jr', 'Alice', 'AliceSmithJr'],
  );
  assert.deepEqual(buildParticipantNameForms('Alice'), ['Alice']);
  assert.deepEqual(buildParticipantNameForms(' @@@ '), []);
});

test('participant awareness derives bot aliases and deduplicates observed forms', () => {
  const awareness = buildParticipantAwareness({
    bot: { name: 'TestBot', aliases: ['@TestBot', 'TB'] },
    messages: [
      { sender: 'Alice Smith', direction: 'INCOMING' },
      { sender: '@Alice_Smith', direction: 'INCOMING' },
      { sender: 'Blair', direction: 'INCOMING' },
      { sender: 'Blair', direction: 'INCOMING' },
    ],
  });

  assert.deepEqual(awareness.botNames, ['TestBot', 'TB']);
  assert.deepEqual(awareness.canonicalNames, ['Alice Smith', 'Blair']);
  assert.deepEqual(awareness.participantNames, [
    'Alice Smith',
    'Alice',
    'AliceSmith',
    'Blair',
  ]);
  assert.deepEqual(awareness.allNames, [
    'Alice Smith',
    'Alice',
    'AliceSmith',
    'Blair',
    'TestBot',
    'TB',
  ]);
  assert.equal(
    new Set(awareness.allNames.map(participantNameKey)).size,
    awareness.allNames.length,
  );

  const alice = awareness.participants.find(
    participant => participant.canonicalName === 'Alice Smith',
  );
  assert.ok(alice);
  assert.deepEqual(alice.forms, ['Alice Smith', 'Alice', 'AliceSmith']);
  assert.equal(awareness.participantNames.includes('TestBot'), false);
  assert.equal(awareness.participantNames.includes('TB'), false);
});

test('participant awareness marks duplicate roster names ambiguous and excludes the bot', () => {
  const awareness = buildParticipantAwareness({
    bot: { name: 'TestBot', aliases: ['@TestBot'] },
    roster: {
      status: 'partial',
      members: [
        { firstName: 'TestBot', isPuppet: true },
        { firstName: 'Sam', isPuppet: false },
        { firstName: 'Sam', isPuppet: false },
      ],
      puppet: { firstName: 'TestBot', isPuppet: true },
      duplicateFirstNames: ['Sam'],
    },
  });

  assert.deepEqual(awareness.canonicalNames, ['Sam']);
  assert.equal(awareness.participants.length, 1);
  assert.equal(awareness.participants[0]?.ambiguous, true);

  const sam = findParticipantIdentity(awareness, 'Sam');
  assert.ok(sam);
  assert.equal(sam.ambiguous, true);
  assert.equal(findParticipantIdentity(awareness, 'TestBot'), null);
});

test('participant awareness filters unknown, outgoing, and bot-authored senders', () => {
  const awareness = buildParticipantAwareness({
    bot: { name: 'Bot', aliases: ['@Bot', 'BT'] },
    messages: [
      { sender: 'Incoming', direction: 'INCOMING' },
      { sender: 'Outgoing', direction: 'OUTGOING' },
      { sender: 'UNKNOWN', direction: 'INCOMING' },
      { sender: 'unknown', direction: 'INCOMING' },
      { sender: 'You', direction: 'INCOMING' },
      { sender: 'you', direction: 'INCOMING' },
      { sender: '', direction: 'INCOMING' },
      { sender: '   ', direction: 'INCOMING' },
      { sender: 42, direction: 'INCOMING' },
      { sender: 'Bot', direction: 'INCOMING' },
      { sender: '@Bot', direction: 'INCOMING' },
      { sender: 'BT', direction: 'INCOMING' },
    ],
  });

  assert.deepEqual(awareness.canonicalNames, ['Incoming']);
  assert.deepEqual(awareness.participantNames, ['Incoming']);
  assert.deepEqual(awareness.allNames, ['Incoming', 'Bot', 'BT']);
});

test('participant identity lookup accepts exact and normalized forms', () => {
  const awareness = buildParticipantAwareness({
    bot: { name: 'TestBot', aliases: ['@TestBot', 'TB'] },
    messages: [{ sender: 'Alice Smith', direction: 'INCOMING' }],
  });

  for (const value of [
    'Alice Smith',
    '@Alice_Smith',
    '  alice   smith ',
    'Alice',
    'AliceSmith',
  ]) {
    const identity = findParticipantIdentity(awareness, value);
    assert.ok(identity, value);
    assert.equal(identity.canonicalName, 'Alice Smith', value);
  }

  assert.equal(findParticipantIdentity(awareness, 'TestBot'), null);
  assert.equal(findParticipantIdentity(awareness, 'TB'), null);
  assert.equal(findParticipantIdentity(awareness, ''), null);
  assert.equal(findParticipantIdentity(awareness, 'UNKNOWN'), null);
});

test('name collisions keep participant forms and deduplicate allNames', () => {
  const awareness = buildParticipantAwareness({
    bot: { name: 'Alice' },
    messages: [{ sender: 'Alice Smith', direction: 'INCOMING' }],
  });

  assert.deepEqual(awareness.botNames, ['Alice']);
  assert.deepEqual(awareness.participants[0]?.forms, [
    'Alice Smith',
    'Alice',
    'AliceSmith',
  ]);
  assert.deepEqual(awareness.allNames, [
    'Alice Smith',
    'Alice',
    'AliceSmith',
  ]);
  assert.equal(
    new Set(awareness.allNames.map(participantNameKey)).size,
    awareness.allNames.length,
  );
});
