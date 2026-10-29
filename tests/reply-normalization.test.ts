import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAliases } from '../src/components/alias-engine.js';
import {
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
