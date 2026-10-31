import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ReplyRejectedError,
  assertReplyApproved,
  buildReplyAdjudicationInstruction,
  parseReplyAdjudicationContent,
} from '../src/components/reply-adjudication.js';

test('adjudication instruction uses the configured identity and participants', () => {
  const instruction = buildReplyAdjudicationInstruction({
    identity: { name: 'Yukinon', aliases: ['@Yukinon', 'Yuki'] },
    participantNames: ['Alex', 'Blair'],
  });

  assert.match(instruction, /identity is exactly "Yukinon"/);
  assert.match(instruction, /aliases are @Yukinon, Yuki/);
  assert.match(instruction, /Other identified participants: Alex, Blair/);
  assert.match(instruction, /addressed to another identifiable participant/);
  assert.match(instruction, /"decision":"approve"\|"reject"/);
  assert.doesNotMatch(instruction, /Anselmo/);
});

test('adjudication instruction distinguishes message author from intended recipient', () => {
  const instruction = buildReplyAdjudicationInstruction({
    identity: { name: 'Yukinon', aliases: ['@Yukinon'] },
    participantNames: ['Katsuyo', 'Anselmo'],
  });

  assert.match(instruction, /\[from Name\] identifies who authored the message/);
  assert.match(instruction, /never identifies the intended recipient/);
  assert.match(instruction, /Do not assume the sender is the addressee/);
  assert.match(instruction, /Determine the intended recipient from the message content and conversational context/);
  assert.match(instruction, /message without an explicit recipient is not automatically addressed to its sender/);
  assert.match(instruction, /use the surrounding conversation/i);
  assert.match(instruction, /identity is exactly "Yukinon"/);
  assert.doesNotMatch(instruction, /Katsuyo is the recipient/);
});

test('adjudication instruction distinguishes mentions, explicit addresses, and ambiguity', () => {
  const instruction = buildReplyAdjudicationInstruction({
    identity: { name: 'Yukinon', aliases: ['@Yukinon'] },
    participantNames: ['Katsuyo', 'Anselmo'],
  });

  assert.match(instruction, /distinguish a participant being mentioned from a participant being explicitly addressed/);
  assert.match(instruction, /named in a message is not sufficient evidence that the message is addressed/);
  assert.match(instruction, /Explicitly addressing the configured bot identity.*should generally result in approval/);
  assert.match(instruction, /without an explicit recipient can still be appropriate opportunities/);
  assert.match(instruction, /clearly addressed to another identifiable participant and does not invite bot participation/);
  assert.match(instruction, /Do not automatically reject ambiguous messages/);
  assert.match(instruction, /Do not treat every mention of another participant as a reason to withhold a reply/);
});

test('adjudication keeps the configured identity separate from mentioned participants', () => {
  const instruction = buildReplyAdjudicationInstruction({
    identity: { name: 'Yukinon', aliases: ['@Yukinon'] },
    participantNames: ['Anselmo'],
  });

  assert.match(instruction, /identity is exactly "Yukinon"/);
  assert.match(instruction, /Other identified participants: Anselmo/);
  assert.match(instruction, /configured bot identity is authoritative and distinct from other participants/);
  assert.match(instruction, /Do not substitute another participant's identity, location, presence, actions, or responses/);
  assert.doesNotMatch(instruction, /identity is exactly "Anselmo"/);
});

test('adjudication instruction follows whatever identity is configured', () => {
  const instruction = buildReplyAdjudicationInstruction({
    identity: { name: 'Mochi', aliases: [] },
    participantNames: [],
  });

  assert.match(instruction, /identity is exactly "Mochi"/);
  assert.match(instruction, /aliases are none/);
  assert.match(instruction, /Other identified participants: none identified/);
  assert.doesNotMatch(instruction, /Yukinon/);
});

test('adjudication parser accepts only an explicit approve or reject decision', () => {
  assert.deepEqual(
    parseReplyAdjudicationContent('{"decision":"approve","reason":"direct question"}'),
    { decision: 'approve', reason: 'direct question' },
  );
  assert.deepEqual(
    parseReplyAdjudicationContent('{"decision":" REJECT ","reason":"addressed to Alex"}'),
    { decision: 'reject', reason: 'addressed to Alex' },
  );
  assert.deepEqual(
    parseReplyAdjudicationContent('{"decision":"approve"}'),
    { decision: 'approve', reason: 'approved by adjudicator' },
  );
});

test('adjudication parser fails closed on malformed or incomplete output', () => {
  for (const content of [
    '',
    'approve',
    '```json\n{"decision":"approve"}\n```',
    '{"decision":"pending"}',
    '{"decision":"maybe"}',
    '{"reason":"no decision"}',
    '[]',
  ]) {
    assert.equal(parseReplyAdjudicationContent(content).decision, 'reject', content);
  }
});

test('approval assertion rejects pending and rejected packets', () => {
  assert.throws(
    () => assertReplyApproved({ reply: 'pending' }, 'test'),
    ReplyRejectedError,
  );
  assert.throws(
    () => assertReplyApproved({ reply: 'reject' }, 'test'),
    ReplyRejectedError,
  );
  assert.doesNotThrow(() => assertReplyApproved({ reply: 'approve' }, 'test'));
});
