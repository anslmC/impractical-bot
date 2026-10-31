import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEnglishOnlyRetryInstruction,
  ENGLISH_ONLY_INSTRUCTION,
  ENGLISH_ONLY_RETRY_INSTRUCTION,
  isEnglishOnlyReply,
} from '../src/components/english-only.js';

const SMOKE_TEST_FAILURES = [
  "Hear you? Opo, talo na ako sa'yo ng tanong. Ano ba talaga ng bigay mo? :p",
  "Okay lang naman yan. :p Ang sagot ko ay nakapag-alam ka naman...",
  'Hehe, ok lang. Gusto ko lang malaman kung ano ba pang ginagawa ka.',
  'Hearing test! Loud and clear. So, may bagong balita ka ba o puro testing lang?',
];

test('the real Tagalog and Taglish smoke-test replies are rejected', () => {
  for (const reply of SMOKE_TEST_FAILURES) {
    assert.equal(isEnglishOnlyReply(reply), false, reply);
  }
});

test('English replies with humor, slang, names, and short reactions are accepted', () => {
  const replies = [
    'Hearing test! Loud and clear. So, what is new?',
    'I hear you. What are you actually asking?',
    'Okay, I see. What do you want me to do?',
    'Honestly, that is hilarious.',
    'whatever you say kid, keep dreaming',
    'Anselmo is still waiting.',
    '@PleaseGetout Daily',
    'On it.',
    'How about 6 PM?',
    'Fine.',
  ];

  for (const reply of replies) {
    assert.equal(isEnglishOnlyReply(reply), true, reply);
  }
});

test('non-Latin and accented non-English replies are rejected', () => {
  assert.equal(isEnglishOnlyReply('何をしていますか？'), false);
  assert.equal(isEnglishOnlyReply('Отвечай по-английски.'), false);
  assert.equal(isEnglishOnlyReply('بالتأكيد.'), false);
  assert.equal(isEnglishOnlyReply('¿Cómo estás?'), false);
});

test('the retry instruction appends without duplicating the canonical English-only policy', () => {
  const retryInstruction = buildEnglishOnlyRetryInstruction(
    `Initial instruction.\n\n${ENGLISH_ONLY_INSTRUCTION}`,
  );

  assert.match(retryInstruction, /previous proposed reply was rejected/);
  assert.match(retryInstruction, /not written entirely in English/);
  assert.match(retryInstruction, /Preserve the conversation's meaning, tone, humor, and personality/);
  assert.ok(retryInstruction.startsWith('Initial instruction.'));
  assert.ok(retryInstruction.endsWith(ENGLISH_ONLY_RETRY_INSTRUCTION));
  assert.equal(retryInstruction.split(ENGLISH_ONLY_INSTRUCTION).length - 1, 1);
  assert.ok(ENGLISH_ONLY_RETRY_INSTRUCTION.length > 0);
});
