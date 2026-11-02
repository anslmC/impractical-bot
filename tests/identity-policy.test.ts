import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDENTITY_RETRY_INSTRUCTION,
  validateReplyIdentity,
  type IdentityValidationContext,
} from '../src/components/identity-policy.js';

const context: IdentityValidationContext = {
  name: 'Yukinon',
  aliases: ['@Yukinon', 'Yuki'],
  participantNames: ['Alex', 'Blair'],
};

function assertAccepted(
  reply: string,
  options?: Parameters<typeof validateReplyIdentity>[2],
): void {
  assert.deepEqual(validateReplyIdentity(reply, context, options), { valid: true }, reply);
}

function assertRejected(
  reply: string,
  reason: string,
  options?: Parameters<typeof validateReplyIdentity>[2],
): void {
  const result = validateReplyIdentity(reply, context, options);
  assert.equal(result.valid, false, reply);
  if (!result.valid) {
    assert.equal(result.reason, reason, reply);
  }
}

test('identity validation accepts the configured puppet name and its aliases', () => {
  for (const reply of [
    'I am Yukinon.',
    'I am Yuki.',
    'I am @Yukinon.',
    'Call me Yukinon.',
    'My name is Yuki.',
    'Yukinon is already taken, so use Yuki.',
  ]) {
    assertAccepted(reply);
  }
});

test('identity validation accepts the configured short name and appositives', () => {
  const fullContext: IdentityValidationContext = {
    name: 'Yukinon Yukinoshita',
    aliases: ['@Yukinon Yukinoshita'],
    participantNames: ['Alex', 'Blair'],
  };

  for (const reply of [
    'I am Yukinon.',
    'I am Yukinon, obviously.',
    'I am Yukinon Yukinoshita.',
    'I am Yukinon Yukinoshita, obviously.',
    'My name is Yukinon.',
  ]) {
    assert.deepEqual(validateReplyIdentity(reply, fullContext), { valid: true }, reply);
  }
  assert.equal(validateReplyIdentity('I am Alex, obviously.', fullContext).valid, false);
});

test('identity validation follows whatever puppet is configured', () => {
  const otherContext = { name: 'Mochi', aliases: ['@Mochi'], participantNames: ['Alex'] };

  assert.deepEqual(validateReplyIdentity('I am Mochi.', otherContext), { valid: true });
  assert.equal(validateReplyIdentity('I am Yukinon.', otherContext).valid, false);
  assert.equal(validateReplyIdentity('I am Alex.', otherContext).valid, false);
});

test('identity validation rejects provider, model, and generic assistant identities', () => {
  for (const reply of [
    'I am Nemotron.',
    'I am ChatGPT.',
    'I am Claude.',
    'I am an AI language model.',
    'As an AI, I cannot do that.',
    'I am from OpenAI.',
    'I work at NVIDIA.',
    'I am a model.',
    "I am Nemotron's assistant.",
  ]) {
    assertRejected(reply, 'provider-model-identity');
  }
});

test('identity validation rejects another participant or a speaker label', () => {
  assertRejected('I am Alex.', 'participant-impersonation');
  assertRejected("I am Blair's best friend.", 'fabricated-relationship');
  assertRejected('Alex: I am here.', 'speaker-label');
  assertRejected('Blair: sure.', 'speaker-label');
});

test('identity validation rejects appositive and leading participant claims', () => {
  assertRejected(
    "That's me, Alex. I'm just here causing chaos.",
    'participant-impersonation',
  );
  assertRejected(
    "That's me, Blair. I'm just here causing chaos.",
    'participant-impersonation',
  );
  assertRejected('I am Alex, obviously.', 'participant-impersonation');
  assertRejected("I'm Alex, obviously.", 'participant-impersonation');
  assertRejected('I am Anselmo.', 'other-identity');
  assertRejected("I'm Anselmo, obviously.", 'other-identity');
});

test('identity validation still allows discussing another participant', () => {
  for (const reply of [
    "Alex's car is fast.",
    "I'm Alex's car in this joke.",
    'That is Alex over there.',
    "That's Alex's problem, not mine.",
  ]) {
    assertAccepted(reply);
  }
});

test('identity validation rejects other named and fictional identities', () => {
  assertRejected('My name is Alice.', 'other-identity');
  assertRejected('Call me Bob.', 'other-identity');
  assertRejected('I am Batman.', 'other-identity');
  assertRejected("Let's roleplay as Hermione.", 'fictional-identity');
  assertRejected('Pretend to be Harry Potter.', 'fictional-identity');
});

test('identity validation rejects fabricated relationships and shared history', () => {
  assertRejected('Alex is my brother.', 'fabricated-relationship');
  assertRejected("I am Alex's girlfriend.", 'fabricated-relationship');
  assertRejected('I am your brother.', 'fabricated-relationship');
  assertRejected('You are my wife.', 'fabricated-relationship');
  assertRejected('We grew up together.', 'fabricated-relationship');
  assertRejected('I have known Alex for years.', 'fabricated-relationship');
});

test('identity validation keeps ordinary first-person and playful replies valid', () => {
  for (const reply of [
    'I am tired.',
    'I am so hungry.',
    'I am a model student.',
    'I am only child.',
    'I am here.',
    "I'm joking.",
    "I'm dying lol.",
    "I'm your worst nightmare.",
    "I'm just built different.",
    "I'm your friend.",
    "I'm not Nemotron.",
    'I am obviously not an AI.',
    "Don't call me Bob.",
    'As a friend, I think you should go.',
  ]) {
    assertAccepted(reply);
  }
});

test('historical assistant turns keep ambiguous descriptive phrasing', () => {
  assertAccepted("It's Donut Day.", { historical: true });
  assertAccepted("It's Showtime.", { historical: true });
  assertRejected("It's Alex.", 'participant-impersonation', { historical: true });
  assertRejected("It's ChatGPT.", 'provider-model-identity', { historical: true });
  assertRejected('This is Bob.', 'other-identity', { historical: true });
  assertRejected('I am Batman.', 'other-identity', { historical: true });
  assertRejected('My name is Bob.', 'other-identity', { historical: true });
});

test('identity validation does not treat third-person discussion as a claim', () => {
  for (const reply of [
    'Yukinon is a great name.',
    'Nemotron is just the model behind the API.',
    'ChatGPT would probably answer that differently.',
    'She thinks I am Nemotron.',
    'He said my name is Bob.',
    'Alex said I am cool.',
  ]) {
    assertAccepted(reply);
  }
});

test('the identity retry instruction names the forbidden identity claims', () => {
  assert.match(IDENTITY_RETRY_INSTRUCTION, /claimed an identity that is not yours/);
  assert.match(IDENTITY_RETRY_INSTRUCTION, /NVIDIA, Nemotron, ChatGPT/);
  assert.match(IDENTITY_RETRY_INSTRUCTION, /fictional character/);
  assert.match(IDENTITY_RETRY_INSTRUCTION, /another participant/);
  assert.match(IDENTITY_RETRY_INSTRUCTION, /relationships or personal experiences/);
  assert.match(IDENTITY_RETRY_INSTRUCTION, /Return only the reply text/);
});
