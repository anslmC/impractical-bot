import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTI_ECHO_RETRY_INSTRUCTION,
  collectParticipantNames,
  findLatestIncomingMessage,
  generateReplyWithAntiEchoGuard,
  isEchoReply,
  normalizeForEchoComparison,
} from '../src/components/anti-echo.js';
import {
  composeSystemInstruction,
  getBotIdentityInstruction,
  getDefaultPersonalityInstruction,
  getPersonalityInstruction,
} from '../src/components/personality.js';

const names = ['Anselmo', '@Anselmo', 'Alex'];

test('an identical reply is detected as an echo', () => {
  assert.equal(isEchoReply('dude who are you', 'dude who are you'), true);
});

test('a sender-prefixed restatement is detected as an echo', () => {
  assert.equal(
    isEchoReply('Anselmo: dude who are you', 'dude who are you', { participantNames: names }),
    true,
  );
  assert.equal(
    isEchoReply('Blair: dude who are you', 'dude who are you', { participantNames: ['Blair'] }),
    true,
    'a participant name that is not the bot is still a transcript prefix',
  );
});

test('an emoji-suffixed restatement is detected as an echo', () => {
  assert.equal(
    isEchoReply('Anselmo: dude who are you 😳', 'dude who are you', { participantNames: names }),
    true,
  );
  assert.equal(isEchoReply('dude who are you 😳🔥', 'dude who are you'), true);
});

test('case, punctuation, whitespace, and newline differences are ignored', () => {
  assert.equal(isEchoReply('can you hear me', 'Can you hear me?'), true);
  assert.equal(isEchoReply('WHAT 😅', 'what'), true);
  assert.equal(
    isEchoReply('  Can   you\r\nhear me?\n', 'can you hear me'),
    true,
  );
  assert.equal(
    normalizeForEchoComparison('Anselmo:\n Dude   who are you 😳!!!', {
      participantNames: names,
    }),
    'dude who are you',
  );
});

test('legitimate short replies that share words with the incoming message stay valid', () => {
  const cases: Array<[string, string]> = [
    ['Are you there?', "Yeah, I'm here."],
    ['what?', 'Nothing much.'],
    ['Can you hear me?', 'Loud and clear.'],
    ['Who are you?', "I'm the bot your friend configured."],
    ['dude who are you', 'Anselmo, obviously.'],
    ['what', 'Nothing.'],
  ];

  for (const [incoming, reply] of cases) {
    assert.equal(
      isEchoReply(reply, incoming, { participantNames: names }),
      false,
      `${JSON.stringify(reply)} is a real answer to ${JSON.stringify(incoming)}`,
    );
  }
});

test('a leading self-mention difference does not hide an echo', () => {
  assert.equal(
    isEchoReply('can you hear me? 😳', '@Bot can you hear me?', { participantNames: ['Bot'] }),
    true,
  );
  assert.equal(
    isEchoReply('@Bot can you hear me? 😳', '@Bot can you hear me?', { participantNames: ['Bot'] }),
    true,
  );
});

test('the latest incoming message is the echo comparison target', () => {
  const messages = [
    { message: 'older question', direction: 'INCOMING', messageId: 'm-1' },
    { message: 'bot answer', direction: 'OUTGOING', messageId: 'm-2' },
    { message: 'latest question', direction: 'INCOMING', messageId: 'm-3' },
    { message: 'draft answer', direction: 'OUTGOING', messageId: 'm-4' },
  ];

  assert.equal(findLatestIncomingMessage(messages)?.messageId, 'm-3');
  assert.equal(findLatestIncomingMessage([{ message: 'x', direction: 'OUTGOING' }]), null);
  assert.deepEqual(
    collectParticipantNames({
      messages,
      names: ['Anselmo', '@Anselmo'],
    }).sort(),
    ['Anselmo'],
    'participant names come from configured names and message senders, not message text',
  );
  assert.deepEqual(
    collectParticipantNames({
      messages: [{ message: 'hi', direction: 'INCOMING', sender: 'Alex' }],
      names: ['Anselmo', '@Anselmo'],
    }).sort(),
    ['Alex', 'Anselmo'].sort(),
    'the @ form of a configured name is normalized away',
  );
});

test('an echoed first reply is retried once and the retry is sent', async () => {
  const attempts: boolean[] = [];
  const outcome = await generateReplyWithAntiEchoGuard({
    generate: async ({ retry }) => {
      attempts.push(retry);
      return retry ? 'Loud and clear.' : 'what';
    },
    isEcho: reply => isEchoReply(reply, 'what'),
  });

  assert.deepEqual(attempts, [false, true]);
  assert.deepEqual(outcome, { status: 'accepted', reply: 'Loud and clear.', attempts: 2 });
});

test('an echoed retry is suppressed, with at most one retry', async () => {
  let calls = 0;
  const logs: string[] = [];
  const outcome = await generateReplyWithAntiEchoGuard({
    generate: async () => {
      calls += 1;
      return 'dude who are you 😳';
    },
    isEcho: reply => isEchoReply(reply, 'dude who are you'),
    log: message => logs.push(message),
  });

  assert.equal(calls, 2, 'generation runs once and retries once, never more');
  assert.deepEqual(outcome, { status: 'suppressed', reason: 'repeat-echo', attempts: 2 });
  assert.ok(logs.some(line => line.includes('retrying once')));
});

test('a rejected echo is never returned to the code that sends it', async () => {
  const sent: string[] = [];
  const outcome = await generateReplyWithAntiEchoGuard({
    generate: async () => 'Anselmo: dude who are you 😳',
    isEcho: reply => isEchoReply(reply, 'dude who are you', { participantNames: names }),
  });
  if (outcome.status === 'accepted') {
    sent.push(outcome.reply);
  }

  assert.deepEqual(sent, []);
  assert.equal(outcome.status, 'suppressed');
});

test('a failing retry propagates as a generation error without suppressing the caller', async () => {
  const attempts: boolean[] = [];
  await assert.rejects(
    generateReplyWithAntiEchoGuard({
      generate: async ({ retry }) => {
        attempts.push(retry);
        if (retry) {
          throw new Error('retry generation failed');
        }
        return 'what';
      },
      isEcho: reply => isEchoReply(reply, 'what'),
    }),
    /retry generation failed/,
  );
  assert.deepEqual(attempts, [false, true], 'the failed retry is not repeated');
});

test('the shared identity instruction forbids restating the incoming message', () => {
  const identity = getBotIdentityInstruction({ name: 'Anselmo', aliases: ['@Anselmo'] });

  assert.match(identity, /Reply to the latest incoming message as a new conversational turn/);
  assert.match(identity, /Do not copy, quote, or restate that message as your response/);
  assert.match(identity, /do not continue it as if finishing the sender's line/);
  assert.match(identity, /never write a line as another participant/);
  assert.match(identity, /never prefix your reply with another participant's name/);
  assert.match(identity, /Never start a reply with a speaker label/);
  assert.match(identity, /not text to echo or imitate/);
});

test('the anti-restatement rule belongs to the identity layer, not the default personality', () => {
  assert.doesNotMatch(
    getDefaultPersonalityInstruction(),
    /Do not copy, quote, or restate that message as your response/,
  );
  assert.match(
    composeSystemInstruction(
      getBotIdentityInstruction({ name: 'Ada', aliases: ['@Ada'] }),
      getPersonalityInstruction('default'),
    ),
    /Do not copy, quote, or restate that message as your response/,
  );
});

test('default and custom personalities remain supported beside the identity rules', () => {
  const identity = getBotIdentityInstruction({ name: 'Ada', aliases: ['@Ada'] });
  const defaultComposed = composeSystemInstruction(
    identity,
    getPersonalityInstruction('default'),
  );
  const customComposed = composeSystemInstruction(
    identity,
    getPersonalityInstruction('custom', 'Deadpan and brief.'),
  );

  for (const composed of [defaultComposed, customComposed]) {
    assert.ok(composed.startsWith(identity), 'identity stays ahead of the personality layer');
    assert.match(composed, /Do not copy, quote, or restate that message as your response/);
  }
  assert.equal(getPersonalityInstruction('default'), getDefaultPersonalityInstruction());
  assert.match(customComposed, /Deadpan and brief\./);
});

test('the retry instruction is explicit about not echoing the incoming message', () => {
  assert.match(ANTI_ECHO_RETRY_INSTRUCTION, /repeated the incoming message/);
  assert.match(ANTI_ECHO_RETRY_INSTRUCTION, /Do not copy, quote, restate, translate, or continue/);
  assert.match(ANTI_ECHO_RETRY_INSTRUCTION, /do not prepend a participant name/);
});
