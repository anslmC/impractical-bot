import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTI_ECHO_RETRY_INSTRUCTION,
  SELF_REPETITION_RETRY_INSTRUCTION,
  collectParticipantNames,
  collectRecentAssistantMessages,
  findLatestIncomingMessage,
  generateReplyWithAntiEchoGuard,
  isEchoReply,
  isSelfRepetitionReply,
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

test('a metadata-prefixed restatement is detected as an echo', () => {
  const envelope =
    '[MESSAGE id="outgoing-1" time="unknown" sender="You" participant="TestBot" ' +
    'direction=OUTGOING]\n';

  assert.equal(isEchoReply(`${envelope}dude who are you`, 'dude who are you'), true);
  assert.equal(
    isEchoReply(
      `${envelope}Anselmo: dude who are you`,
      'dude who are you',
      { participantNames: names },
    ),
    true,
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

  assert.match(identity, /Respond to the latest incoming message in light of the conversation so far/);
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

test('self-repetition detection uses recent logical replies and ignores harmless punctuation changes', () => {
  const recent = collectRecentAssistantMessages([
    { message: 'older reply', direction: 'OUTGOING', messageId: 'out-1' },
    { message: 'first chunk of the last reply', direction: 'OUTGOING', messageId: 'out-2', replyBatchId: 'batch-a' },
    { message: 'second chunk of the last reply', direction: 'OUTGOING', messageId: 'out-3', replyBatchId: 'batch-a' },
    { message: 'another incoming', direction: 'INCOMING', messageId: 'in-1' },
  ]);

  assert.deepEqual(recent.map(message => message.messageId), ['out-3', 'out-2', 'out-1']);
  assert.equal(
    isSelfRepetitionReply(
      'Sorry,  I guess I kept talking in riddles about pacing and form!',
      ['sorry i guess i kept talking in riddles about pacing and form'],
    ),
    true,
  );
  assert.equal(
    isSelfRepetitionReply(
      'That sounds like a good plan; tell me what story you want next.',
      ['Sorry, I guess I kept talking in riddles about pacing and form.'],
    ),
    false,
    'sharing a phrase or subject is not a repetition',
  );
  assert.equal(
    isSelfRepetitionReply('yes', ['yes']),
    false,
    'short conversational acknowledgements are not meaningful duplicates',
  );
  assert.match(SELF_REPETITION_RETRY_INSTRUCTION, /already said in this conversation/);
});

test('short exact and near-duplicate self-repetitions are detected without suppressing natural reactions', () => {
  assert.equal(isSelfRepetitionReply('What part?', ['what part']), true);
  assert.equal(
    isSelfRepetitionReply(
      'I keep telling you the same thing about the pacing and the form.',
      ['I keep telling you the same thing about the pacing and form.'],
    ),
    true,
    'a one-word difference in a long reply is a near-duplicate',
  );
  assert.equal(isSelfRepetitionReply('yeah', ['yeah']), false);
  assert.equal(isSelfRepetitionReply('sounds good', ['sounds good']), false);
  assert.equal(
    isSelfRepetitionReply(
      'The blue plan still works if we move the meeting.',
      ['I would rather try the red option on Friday.'],
    ),
    false,
    'a genuinely different sentence with shared words is not a duplicate',
  );
});

test('a short exact reply is repeated only when an incoming message intervenes', () => {
  const withInterveningIncoming = [
    { message: 'whatever.', direction: 'OUTGOING', messageId: 'out-1' },
    { message: 'are you still there?', direction: 'INCOMING', messageId: 'in-1' },
    { message: 'what do you think?', direction: 'INCOMING', messageId: 'in-2' },
  ];
  const withoutInterveningIncoming = [
    { message: 'whatever.', direction: 'OUTGOING', messageId: 'out-1' },
  ];

  assert.equal(
    isSelfRepetitionReply('  Whatever.  ', [], { history: withInterveningIncoming }),
    true,
    'case and whitespace differences do not hide the repeat',
  );
  assert.equal(
    isSelfRepetitionReply('whatever.', [], { history: withoutInterveningIncoming }),
    false,
    'another observation of the same turn is not a repeated reply',
  );
  assert.equal(
    isSelfRepetitionReply('whatever.', ['whatever.']),
    false,
    'the legacy fallback keeps acknowledging short messages as non-repetitions',
  );
  assert.equal(
    isSelfRepetitionReply('sounds good', [], {
      history: [
        { message: 'sounds good', direction: 'OUTGOING', messageId: 'out-1' },
        { message: 'want to study?', direction: 'INCOMING', messageId: 'in-1' },
      ],
    }),
    false,
    'the legitimate short-reply allowlist is preserved',
  );
  assert.equal(
    isSelfRepetitionReply('Fair enough.', [], {
      history: [
        { message: 'fair enough', direction: 'OUTGOING', messageId: 'out-1' },
        { message: 'you got plans?', direction: 'INCOMING', messageId: 'in-1' },
      ],
    }),
    true,
    'a repeated generic acknowledgment is still a repetition',
  );
  assert.equal(
    isSelfRepetitionReply('No thanks.', [], {
      history: [
        { message: 'no thanks', direction: 'OUTGOING', messageId: 'out-1' },
        { message: 'can you kiss my ass?', direction: 'INCOMING', messageId: 'in-1' },
      ],
    }),
    true,
    'a repeated flat refusal is still a repetition',
  );
});

test('composer batches are compared as one logical reply, not separate bubbles', () => {
  const history = [
    {
      message: 'whatever.',
      direction: 'OUTGOING',
      messageId: 'out-1',
      replyBatchId: 'batch-a',
    },
    {
      message: 'Tell me more.',
      direction: 'OUTGOING',
      messageId: 'out-2',
      replyBatchId: 'batch-a',
    },
    {
      message: 'are you still there?',
      direction: 'INCOMING',
      messageId: 'in-1',
    },
  ];

  assert.equal(
    isSelfRepetitionReply('whatever.', [], { history }),
    false,
    'the first sliced bubble is not treated as the whole earlier reply',
  );
});

test('duplicate observations of the same outgoing message are collected once', () => {
  const recent = collectRecentAssistantMessages([
    { message: 'first reply', direction: 'OUTGOING', messageId: 'out-1' },
    { message: 'first reply', direction: 'OUTGOING', messageId: 'out-1' },
    { message: 'second reply', direction: 'OUTGOING', messageId: 'out-2' },
  ]);

  assert.deepEqual(recent.map(message => message.messageId), ['out-2', 'out-1']);
});

test('near-echoes with small additions are detected while real answers remain valid', () => {
  assert.equal(
    isEchoReply('can you hear me right now', 'can you hear me'),
    true,
    'a small trailing addition does not hide an echo',
  );
  assert.equal(
    isEchoReply('dude who are you exactly', 'dude who are you'),
    true,
    'a small trailing addition does not hide an echo',
  );
  assert.equal(
    isEchoReply("Yeah, I'm here.", 'Are you there?'),
    false,
    'a real answer is not a near-echo',
  );
  assert.equal(
    isEchoReply('Nothing much, just working.', 'what are you doing today?'),
    false,
    'an unrelated reply is not a near-echo',
  );
});

test('a repeated assistant reply is retried once with a self-repetition instruction and then suppressed', async () => {
  const attempts: Array<{ retry: boolean; reason?: string }> = [];
  const logs: string[] = [];
  const repeated = 'Sorry, I guess I kept talking in riddles about pacing and form.';
  const outcome = await generateReplyWithAntiEchoGuard({
    generate: async attempt => {
      attempts.push(attempt);
      return repeated;
    },
    isEcho: () => false,
    isRepeat: reply => isSelfRepetitionReply(reply, [repeated]),
    log: message => logs.push(message),
  });

  assert.deepEqual(attempts, [
    { retry: false },
    { retry: true, reason: 'repeat-self' },
  ]);
  assert.deepEqual(outcome, {
    status: 'suppressed',
    reason: 'repeat-self',
    attempts: 2,
  });
  assert.ok(logs.some(line => line.includes('self-repetition instruction')));
});
