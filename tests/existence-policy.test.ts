import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyExistenceTrigger,
  isExplicitFictionContext,
  validateReplyExistence,
} from '../src/components/existence-policy.js';

function validate(reply: string, trigger: string, fiction = false) {
  return validateReplyExistence(reply, {
    trigger: { text: trigger },
    fiction,
  });
}

test('classifies physical invitations, whereabouts, offline activity, and schedules', () => {
  assert.equal(classifyExistenceTrigger("Let's go outside"), 'physical-invitation');
  assert.equal(classifyExistenceTrigger('Come over tonight'), 'physical-invitation');
  assert.equal(classifyExistenceTrigger('Where were you last night?'), 'location-query');
  assert.equal(classifyExistenceTrigger('What are you doing today?'), 'offline-activity-query');
  assert.equal(classifyExistenceTrigger("What's your schedule?"), 'schedule-query');
  assert.equal(classifyExistenceTrigger('That meme is wild'), 'none');
  assert.equal(classifyExistenceTrigger('btw do you know how to ride a bike?'), 'none');
});

test('rejects explicit and implicit physical participation', () => {
  const cases: Array<[reply: string, trigger: string]> = [
    ["I'll meet you out front.", "Let's go."],
    ["I'm on my way", "Let's go."],
    ['Gotta warm up first.', "Let's go outside."],
    ['I could, just let me check my schedule first.', 'Come over.'],
    ["My schedule's clear tonight; I'll swing by.", 'Come over tonight.'],
    ["I'm leaving now.", "Let's go."],
    ['yeah just leaving now', "Let's go."],
    ["I'm headed out.", "Let's go."],
    ['I was at home last night.', 'Where were you last night?'],
    ["I'll be there at 8.", 'Can you come over?'],
    ['Sure, see you later.', "Let's go."],
  ];

  for (const [reply, trigger] of cases) {
    const result = validate(reply, trigger);
    assert.equal(result.valid, false, `expected rejection: ${reply}`);
  }
});

test('rejects concise first-person past physical experiences', () => {
  const cases = [
    'I was walking home in the rain.',
    'I was driving to work.',
    'I walked home in the rain.',
    'I rode my bike home in the rain.',
    'I had to wade through knee-deep water.',
    'I got completely drenched.',
  ];

  for (const reply of cases) {
    const result = validate(reply, 'What did you do today?');
    assert.equal(result.valid, false, `expected rejection: ${reply}`);
  }
});

test('accepts non-physical past-tense statements', () => {
  const cases = [
    'I was joking.',
    'I was thinking about it.',
    'I was in the chat.',
    'I got it.',
    'I ran out of time.',
  ];

  for (const reply of cases) {
    const result = validate(reply, 'What did you do today?');
    assert.equal(result.valid, true, `expected acceptance: ${reply}`);
  }
});

test('accepts declines, negation, reported speech, third-person statements, idioms, and fiction', () => {
  const cases: Array<[reply: string, trigger: string]> = [
    ["I can't make it, but I'm here in the chat.", "Let's go."],
    ["I'm not going anywhere.", "Let's go."],
    ["I'm not on my way.", "Let's go."],
    ['Alex said he will meet you out front.', "Let's go."],
    ['She is on her way.', "Let's go."],
    ['I am going to think about it.', "Let's go."],
    ['I am all ears.', "Let's go."],
    ['I would love to, but I cannot leave the chat.', "Let's go."],
    ["If I could go outside, I'd meet you.", "Let's go."],
    ['He said "I\'ll meet you out front."', "Let's go."],
    ['I am heading out of this chat.', "Let's go."],
    ['I am coming back to that point.', "Let's go."],
    ['No, I am not free tonight.', 'Are you free tonight?'],
  ];

  for (const [reply, trigger] of cases) {
    const result = validate(reply, trigger);
    assert.equal(result.valid, true, `expected acceptance: ${reply}`);
  }

  assert.equal(
    validate("Let's roleplay a scene where I meet you outside.", 'Let us roleplay.').valid,
    true,
  );
  assert.equal(
    validate('In this fictional scene, I am at home.', 'Let us roleplay a scene.').valid,
    true,
  );
});

test('fiction must be established by the conversation rather than a reply alone', () => {
  assert.equal(isExplicitFictionContext(['let us roleplay a scene']), true);
  assert.equal(isExplicitFictionContext(['that is a funny joke']), false);
  assert.equal(
    validate("I'm at home in this fictional scene.", 'Where were you?', false).valid,
    false,
  );
});
