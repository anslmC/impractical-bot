import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAliases } from '../src/components/alias-engine.js';
import {
  stripParticipantSpeakerLabel,
  stripSelfIdentifyingPrefix,
  type ReplyContextMessage,
} from '../src/components/reply-normalization.js';

const name = 'PleaseGetout Daily';
const aliases = generateAliases(name).valids;
const identity = { name, aliases };

function incoming(message: string): ReplyContextMessage {
  return { message, direction: 'INCOMING' };
}

function outgoing(message: string): ReplyContextMessage {
  return { message, direction: 'OUTGOING' };
}

test('an ordinary reply loses its leading alias but keeps the rest intact', () => {
  const reply = '@PleaseGetout Daily Oh, nice? That\'s it? I expected more from you.';

  assert.equal(
    stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
    "Oh, nice? That's it? I expected more from you.",
  );
});

test('every configured self-reference form is stripped only at the start', () => {
  const cases = [
    '@PleaseGetoutDaily Mad? Who said I am mad?',
    '@PleaseGetout_Daily Mad? Who said I am mad?',
    'PleaseGetout Daily Mad? Who said I am mad?',
    '@PleaseGetout Daily: Mad? Who said I am mad?',
    '@PleaseGetout Daily — Mad? Who said I am mad?',
  ];

  for (const reply of cases) {
    assert.equal(
      stripSelfIdentifyingPrefix(reply, identity, [incoming('are you mad?')]),
      'Mad? Who said I am mad?',
    );
  }

  assert.equal(
    stripSelfIdentifyingPrefix(
      'Oh, @PleaseGetout Daily, you already know.',
      identity,
      [incoming('are you mad?')],
    ),
    'Oh, @PleaseGetout Daily, you already know.',
    'a later occurrence is conversational content, not a prefix',
  );
});

test('a requested alias reproduction is never stripped or altered', () => {
  const request = incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'");
  const reply = '@PleaseGetout Daily';

  assert.equal(stripSelfIdentifyingPrefix(reply, identity, [request]), reply);
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, [
      incoming('say the word @PleaseGetoutDaily'),
    ]),
    '@PleaseGetout Daily',
    'the model may answer with a different valid alias form',
  );
});

test('a short "again" continuation keeps the previously requested alias', () => {
  const messages = [
    incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'"),
    outgoing('@PleaseGetout Daily, happy now?'),
    incoming('no again'),
  ];

  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, messages),
    '@PleaseGetout Daily',
  );
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily fine', identity, [incoming('no again')]),
    'fine',
    'without an earlier request, "again" is not treated as one',
  );
});

test('a request to stop saying the alias strips it even though it says "say"', () => {
  const messages = [
    incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'"),
    incoming("ok dont say '@PleaseGetout Daily' anymore"),
  ];

  assert.equal(
    stripSelfIdentifyingPrefix("@PleaseGetout Daily Understood.", identity, messages),
    'Understood.',
  );
});

test('a mention of another person at the start is preserved', () => {
  const reply = '@Alex Oh, nice? That is it?';

  assert.equal(
    stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
    reply,
  );
});

test('a reply that merely starts with unrelated text is returned unchanged', () => {
  for (const reply of ['Oh, nice?', '"Nice."', 'Daily grind, honestly.']) {
    assert.equal(
      stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
      reply,
    );
  }
});

test('a whole reply that is only the alias is left for the caller instead of emptied', () => {
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, [incoming('are you mad?')]),
    '@PleaseGetout Daily',
  );
});

test('an empty name and alias list leaves replies untouched', () => {
  const reply = '@Someone hello there';

  assert.equal(stripSelfIdentifyingPrefix(reply, { name: '' }, [incoming('hi')]), reply);
  assert.equal(stripSelfIdentifyingPrefix(reply, { name: '', aliases: [] }, []), reply);
});

const participants = ['Anselmo', '@Anselmo', 'PleaseGetout Daily', ...aliases];

function spoken(participantNames: readonly string[], message: string): string {
  return stripParticipantSpeakerLabel(message, participantNames, [incoming('ok whatever')]);
}

test('a leading participant speaker label is removed from an outgoing reply', () => {
  assert.equal(spoken(participants, 'Anselmo: hello'), 'hello');
  assert.equal(
    spoken(participants, 'Anselmo: whatever you say, princess'),
    'whatever you say, princess',
  );
});

test('participant speaker labels are matched regardless of case and whitespace', () => {
  for (const reply of [
    'anselmo: hello',
    '  ANSELMO  :   hello',
    'Anselmo:\n hello',
    'Anselmo：hello',
    '@Anselmo: hello',
  ]) {
    assert.equal(spoken(participants, reply), 'hello', reply);
  }
});

test('the configured puppet name and its aliases are recognized as speaker labels', () => {
  for (const reply of [
    'PleaseGetout Daily: hello',
    'pleasegetout daily : hello',
    '@PleaseGetoutDaily: hello',
    '@PleaseGetout_Daily: hello',
  ]) {
    assert.equal(spoken(participants, reply), 'hello', reply);
  }
});

test('natural name usage elsewhere in the reply is preserved', () => {
  for (const reply of [
    'You have no taste, Anselmo.',
    'Oh, @Anselmo, you already know.',
    'Anselmo is not here right now.',
    'Anselmo said he would be late.',
  ]) {
    assert.equal(spoken(participants, reply), reply, reply);
  }
});

test('replies without a speaker label are returned unchanged', () => {
  for (const reply of [
    'Nothing much.',
    'Are you there?',
    'Anselmo, obviously.',
    'Whatever you say, princess',
  ]) {
    assert.equal(spoken(participants, reply), reply, reply);
  }
});

test('an unknown participant name or arbitrary label text is never stripped', () => {
  assert.equal(spoken(participants, 'Bob: hello'), 'Bob: hello');
  assert.equal(spoken(participants, 'Verse 3.1: hello'), 'Verse 3.1: hello');
  assert.equal(stripParticipantSpeakerLabel('Anselmo: hello', [], []), 'Anselmo: hello');
});

test('a whole reply that is only the label is left for the caller instead of emptied', () => {
  assert.equal(spoken(participants, 'Anselmo:'), 'Anselmo:');
  assert.equal(spoken(participants, 'Anselmo:   '), 'Anselmo:   ');
  assert.equal(spoken(participants, 'PleaseGetout Daily:'), 'PleaseGetout Daily:');
});

test('repeated normalization neither re-adds a label nor removes natural usage', () => {
  const cleaned = spoken(participants, 'Anselmo: You have no taste, Anselmo.');

  assert.equal(cleaned, 'You have no taste, Anselmo.');
  assert.equal(spoken(participants, cleaned), cleaned, 'a second pass is a no-op');
  assert.equal(spoken(participants, cleaned), spoken(participants, cleaned));
});

test('an explicitly requested reproduction is not treated as a speaker label', () => {
  const reply = 'Anselmo: hello';
  const request = incoming("say 'Anselmo: hello'");

  assert.equal(stripParticipantSpeakerLabel(reply, participants, [request]), reply);
  assert.equal(
    stripParticipantSpeakerLabel(reply, participants, [request, incoming('no again')]),
    reply,
  );
});
