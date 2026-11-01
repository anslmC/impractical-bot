import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDENTITY_AWARENESS_INSTRUCTION_MARKER,
  appendIdentityAwarenessInstruction,
  buildIdentityAwarenessInstruction,
} from '../src/components/identity-awareness.js';
import { composeProductionSystemInstruction } from '../src/components/personality.js';

test('identity awareness uses the configured identity, aliases, and participants', () => {
  const instruction = buildIdentityAwarenessInstruction({
    identity: { name: 'TestBot', aliases: ['@TestBot', 'TB'] },
    participantNames: ['Alex', 'Blair', 'Alex'],
  });

  assert.match(instruction, new RegExp(IDENTITY_AWARENESS_INSTRUCTION_MARKER));
  assert.match(instruction, /You are TestBot/);
  assert.match(instruction, /identity is exactly "TestBot"/);
  assert.match(instruction, /aliases @TestBot, TB refer to you/);
  assert.match(instruction, /Other identified participants in this conversation: Alex, Blair\./);
  assert.doesNotMatch(instruction, /Other identified participants in this conversation:.*TestBot/);
  assert.doesNotMatch(instruction, /Yukinon/);
});

test('identity awareness distinguishes message authors from intended recipients', () => {
  const instruction = buildIdentityAwarenessInstruction({
    identity: { name: 'TestBot' },
    participantNames: ['Alex', 'Blair'],
  });

  assert.match(instruction, /\[from Name\]/);
  assert.match(instruction, /identifies the author, not the intended recipient/);
  assert.match(instruction, /addressed to you, to another participant/);
  assert.match(instruction, /You do not need an invitation/);
  assert.match(instruction, /may still respond naturally/);
  assert.match(instruction, /Keep every participant distinct from yourself/);
});

test('identity awareness treats self-identification as an author statement', () => {
  const instruction = buildIdentityAwarenessInstruction({
    identity: { name: 'TestBot' },
    participantNames: ['Alex'],
  });

  assert.match(instruction, /saying "I am <name>" is identifying themselves/);
  assert.match(instruction, /does not change your identity/);
  assert.match(instruction, /configured identity is authoritative/);
});

test('identity awareness has no approve-or-reject decision contract', () => {
  const instruction = buildIdentityAwarenessInstruction({
    identity: { name: 'TestBot' },
    participantNames: ['Alex'],
  });

  assert.doesNotMatch(instruction, /"decision"/);
  assert.doesNotMatch(instruction, /\bapprove\b/i);
  assert.doesNotMatch(instruction, /\breject\b/i);
  assert.doesNotMatch(instruction, /json/i);
});

test('identity awareness follows a different configured identity without stale names', () => {
  const instruction = buildIdentityAwarenessInstruction({
    identity: { name: 'Mochi' },
    participantNames: [],
  });

  assert.match(instruction, /You are Mochi/);
  assert.match(instruction, /identity is exactly "Mochi"/);
  assert.match(instruction, /Other identified participants in this conversation: none identified yet\./);
  assert.doesNotMatch(instruction, /TestBot/);
});

test('identity awareness returns no instruction without a configured identity', () => {
  assert.equal(buildIdentityAwarenessInstruction({ identity: { name: '   ' } }), '');
  assert.equal(
    appendIdentityAwarenessInstruction('Base instruction.', { identity: { name: '' } }),
    'Base instruction.',
  );
});

test('identity awareness is composed into the production instruction', () => {
  const instruction = composeProductionSystemInstruction({
    identity: { name: 'TestBot', aliases: ['@TestBot'] },
    personalityMode: 'default',
  });

  assert.match(instruction, new RegExp(IDENTITY_AWARENESS_INSTRUCTION_MARKER));
  assert.match(instruction, /You are TestBot/);
});

test('appending enriched awareness replaces the composed section without duplicating it', () => {
  const composed = composeProductionSystemInstruction({
    identity: { name: 'TestBot', aliases: ['@TestBot'] },
    personalityMode: 'default',
  });
  const enriched = appendIdentityAwarenessInstruction(composed, {
    identity: { name: 'TestBot', aliases: ['@TestBot'] },
    participantNames: ['Alex', 'Blair'],
  });

  assert.equal(
    enriched.split(IDENTITY_AWARENESS_INSTRUCTION_MARKER).length - 1,
    1,
    'the awareness section is replaced rather than appended twice',
  );
  assert.match(enriched, /Other identified participants in this conversation: Alex, Blair\./);
});

test('malformed participant data falls back without blocking the system instruction', () => {
  const participantNames = [{
    trim: () => {
      throw new Error('bad participant');
    },
  }] as unknown as readonly string[];

  const instruction = appendIdentityAwarenessInstruction('Base instruction.', {
    identity: { name: 'TestBot' },
    participantNames,
  });

  assert.match(instruction, /^Base instruction\./);
  assert.match(instruction, /You are TestBot/);
  assert.match(instruction, /Other identified participants in this conversation: none identified yet\./);
  assert.doesNotMatch(instruction, /bad participant/);
});
