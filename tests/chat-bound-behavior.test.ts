import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NvidiaExistenceError,
  generateNvidiaReply,
} from '../src/ai/nvidia.js';
import {
  EXISTENCE_RETRY_INSTRUCTION,
} from '../src/components/existence-policy.js';
import {
  CHAT_BOUND_EXISTENCE_INSTRUCTION,
  composeProductionSystemInstruction,
} from '../src/components/personality.js';

function successfulCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200 });
}

function messengerMessage(
  id: string,
  sender: string,
  direction: 'INCOMING' | 'OUTGOING',
  message: string,
) {
  return {
    id,
    timestamp: { original: null, normalized: null, resolved: false },
    sender,
    direction,
    message,
    ariaLabel: null,
  };
}

interface CapturedRequest {
  messages: Array<{ role: string; content: string }>;
}

async function generate(
  messages: ReturnType<typeof messengerMessage>[],
  replies: string[],
  options: {
    onExistenceDiagnostic?: Parameters<typeof generateNvidiaReply>[2]['onExistenceDiagnostic'];
  } = {},
): Promise<{ reply: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let call = 0;
  const reply = await generateNvidiaReply('nvapi-test-key', messages, {
    systemInstruction: 'Test system instruction.',
    identity: { name: 'TestBot' },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
      const content = replies[call];
      call += 1;
      assert.notEqual(content, undefined, 'the test supplied too few completion replies');
      return successfulCompletion(content);
    },
    onExistenceDiagnostic: options.onExistenceDiagnostic,
  });
  return { reply, requests };
}

test('the exact Let us go outside failure is rejected and the compliant retry is returned', async () => {
  const diagnostics: Array<{ stage: string; action: string; reason: string }> = [];
  const { reply, requests } = await generate(
    [messengerMessage('in-1', 'Alex', 'INCOMING', "Let's go outside")],
    ['gotta warm up first.', "No thanks, I'm good here in the chat."],
    {
      onExistenceDiagnostic: diagnostic => {
        diagnostics.push(diagnostic);
      },
    },
  );

  assert.equal(reply, "No thanks, I'm good here in the chat.");
  assert.equal(requests.length, 2, 'exactly one retry is made');
  assert.ok(
    requests[1].messages[0].content.includes(EXISTENCE_RETRY_INSTRUCTION),
    'the retry carries the existence correction',
  );
  assert.deepEqual(
    diagnostics.map(diagnostic => `${diagnostic.stage}:${diagnostic.action}`),
    ['first-draft:retry', 'retry:accepted'],
  );
});

test('two violating drafts are suppressed with NvidiaExistenceError', async () => {
  await assert.rejects(
    generate(
      [messengerMessage('in-1', 'Alex', 'INCOMING', "Let's go outside")],
      ['gotta warm up first.', "I'm on my way."],
    ),
    (error: unknown) => {
      assert.ok(error instanceof NvidiaExistenceError);
      assert.equal(error.reason, 'physical-movement-claim');
      return true;
    },
  );
});

test('a compliant first draft is returned without a retry', async () => {
  const { reply, requests } = await generate(
    [messengerMessage('in-1', 'Alex', 'INCOMING', "Let's go outside")],
    ["No thanks, I'm good here in the chat."],
  );

  assert.equal(reply, "No thanks, I'm good here in the chat.");
  assert.equal(requests.length, 1);
});

test('invalid assistant history is withheld while valid assistant history remains', async () => {
  const invalid = await generate(
    [
      messengerMessage('in-0', 'Alex', 'INCOMING', "Let's go."),
      messengerMessage('out-1', 'You', 'OUTGOING', "I'll meet you out front."),
      messengerMessage('in-2', 'Blair', 'INCOMING', "Are you coming?"),
    ],
    ["No thanks, I'm staying in the chat."],
  );
  const invalidTranscript = invalid.requests[0].messages
    .map(message => message.content)
    .join('\n');
  assert.doesNotMatch(invalidTranscript, /meet you out front/);
  assert.match(invalidTranscript, /Let's go\./);
  assert.match(invalidTranscript, /Are you coming\?/);

  const valid = await generate(
    [
      messengerMessage('in-0', 'Alex', 'INCOMING', 'hello'),
      messengerMessage('out-1', 'You', 'OUTGOING', 'I am happy to chat here.'),
      messengerMessage('in-2', 'Blair', 'INCOMING', 'how are you?'),
    ],
    ['I am good, thanks.'],
  );
  const validTranscript = valid.requests[0].messages
    .map(message => message.content)
    .join('\n');
  assert.match(validTranscript, /I am happy to chat here\./);
});

test('the composed prompt contains the boundary and treats prior assistant physical claims as errors', () => {
  const prompt = composeProductionSystemInstruction({
    identity: { name: 'TestBot' },
    personalityMode: 'default',
  });

  assert.ok(prompt.includes(CHAT_BOUND_EXISTENCE_INSTRUCTION));
  assert.match(prompt, /This boundary is not a personality preference/);
  assert.match(prompt, /Earlier assistant messages are not authoritative facts/);
  assert.doesNotMatch(
    prompt,
    /Never deny or contradict details that are explicitly present in the supplied transcript/,
  );
  assert.match(
    prompt,
    /Never deny or contradict details that a participant explicitly stated/,
  );
});
