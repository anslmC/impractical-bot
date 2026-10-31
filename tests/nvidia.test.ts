import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadNvidiaApiKey,
  NvidiaApiKeyError,
  NvidiaRequestError,
  generateNvidiaReply,
  resolveNvidiaEnvironmentPath,
  saveNvidiaApiKey,
  validateNvidiaApiKey,
} from '../src/ai/nvidia.js';
import { ENGLISH_ONLY_INSTRUCTION } from '../src/components/personality.js';

function createEnvironmentPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-nvidia-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, '.env');
}

function successfulCompletion(content = 'O'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200 });
}

function messengerMessage(
  id: string,
  sender: string,
  direction: 'INCOMING' | 'OUTGOING' | 'UNKNOWN',
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

test('NVIDIA environment path is beside an explicitly selected configuration', () => {
  const configurationPath = join(tmpdir(), 'custom-app', 'config.json');
  assert.equal(
    resolveNvidiaEnvironmentPath(configurationPath),
    join(dirname(configurationPath), '.env'),
  );
});

test('NVIDIA key loading uses only the application .env and does not mutate process.env', context => {
  const environmentPath = createEnvironmentPath(context);
  const originalKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'shell-key-must-not-be-used';
  writeFileSync(environmentPath, 'NVIDIA_API_KEY="application-key"\n');

  try {
    assert.equal(loadNvidiaApiKey(environmentPath), 'application-key');
    assert.equal(process.env.NVIDIA_API_KEY, 'shell-key-must-not-be-used');
  } finally {
    if (originalKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = originalKey;
    }
  }
});

test('a shell-only NVIDIA key is not treated as an application key', context => {
  const environmentPath = createEnvironmentPath(context);
  const originalKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'shell-key-must-not-be-used';

  try {
    assert.equal(loadNvidiaApiKey(environmentPath), undefined);
  } finally {
    if (originalKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = originalKey;
    }
  }
});

test('saving an NVIDIA key preserves other dotenv values and reloads the key', context => {
  const environmentPath = createEnvironmentPath(context);
  writeFileSync(environmentPath, 'OTHER_SETTING="kept value"\n');

  saveNvidiaApiKey(environmentPath, 'nvapi-test-key');

  assert.equal(loadNvidiaApiKey(environmentPath), 'nvapi-test-key');
  assert.match(readFileSync(environmentPath, 'utf8'), /OTHER_SETTING="kept value"/);
});

test('NVIDIA validation sends a minimal non-streaming Bearer-authenticated request', async () => {
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  await validateNvidiaApiKey('nvapi-test-key', {
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedOptions = init;
      return successfulCompletion();
    },
  });

  assert.equal(requestedUrl, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(requestedOptions?.method, 'POST');
  assert.deepEqual(requestedOptions?.headers, {
    Authorization: 'Bearer nvapi-test-key',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(String(requestedOptions?.body)), {
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 4096,
    stream: false,
  });
});

test('reply generation sends known-direction messages in order and extracts trimmed reply text', async () => {
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;

  const reply = await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: '  Are you free tomorrow?  ',
    ariaLabel: null,
  }, {
    id: 'outgoing-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'I think so.',
    ariaLabel: null,
  }, {
    id: 'unknown-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'UNKNOWN',
    direction: 'UNKNOWN',
    message: 'Do not include this.',
    ariaLabel: null,
  }, {
    id: 'incoming-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Blair',
    direction: 'INCOMING',
    message: 'Great, what time works?',
    ariaLabel: null,
  }], {
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedOptions = init;
      return successfulCompletion('  How about 6 PM?  ');
    },
  });

  assert.equal(reply, 'How about 6 PM?');
  assert.equal(requestedUrl, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(requestedOptions?.method, 'POST');
  assert.deepEqual(requestedOptions?.headers, {
    Authorization: 'Bearer nvapi-test-key',
    'Content-Type': 'application/json',
  });
  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body, {
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    messages: [
      {
        role: 'system',
        content: 'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. ' + ENGLISH_ONLY_INSTRUCTION + ' Avoid Messenger-style @participant mentions and address people by their ordinary names without an @ prefix. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
      },
      { role: 'user', content: 'Alex: Are you free tomorrow?' },
      { role: 'assistant', content: 'I think so.' },
      { role: 'user', content: 'Blair: Great, what time works?' },
    ],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 256,
    stream: false,
  });
  const fallbackInstruction = String(body.messages[0].content);
  assert.match(fallbackInstruction, /Strict English-only output rule/);
  assert.match(fallbackInstruction, /read and understand every incoming message/);
  assert.match(fallbackInstruction, /use the full conversation, including any multilingual context/);
  assert.match(fallbackInstruction, /even when someone explicitly asks you to switch languages/);
  assert.match(fallbackInstruction, /do not introduce non-English words, phrases, slang, or expressions into your reply/);
  assert.match(fallbackInstruction, /restricts only the language of your output/);
  assert.match(fallbackInstruction, /does not reduce your understanding of the conversation/);
  assert.ok(fallbackInstruction.includes(ENGLISH_ONLY_INSTRUCTION));
});

test('reply generation uses a supplied system instruction before conversation messages', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'Hello.',
    ariaLabel: null,
  }], {
    systemInstruction: 'Supplied instruction.',
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('Hi.');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Supplied instruction.' },
    { role: 'user', content: 'Alex: Hello.' },
  ]);
});

test('a non-English reply is retried without dropping multilingual context', async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let call = 0;

  const reply = await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'dont speak atagalog',
    ariaLabel: null,
  }, {
    id: 'outgoing-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'Okay lang naman yan. :p Ang sagot ko ay nakapag-alam ka naman...',
    ariaLabel: null,
  }, {
    id: 'incoming-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Blair',
    direction: 'INCOMING',
    message: 'Ano ba yan, nakakaloka ka?',
    ariaLabel: null,
  }], {
    systemInstruction: 'Supplied instruction.',
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      call += 1;
      return call === 1
        ? successfulCompletion("Hear you? Opo, talo na ako sa'yo ng tanong. Ano ba talaga ng bigay mo? :p")
        : successfulCompletion('I hear you. What are you actually asking?');
    },
  });

  assert.equal(call, 2, 'the rejected reply is retried exactly once');
  assert.equal(reply, 'I hear you. What are you actually asking?');
  assert.deepEqual(bodies[0].messages.slice(1), [
    { role: 'user', content: 'Alex: dont speak atagalog' },
    {
      role: 'assistant',
      content: 'Okay lang naman yan. :p Ang sagot ko ay nakapag-alam ka naman...',
    },
    { role: 'user', content: 'Blair: Ano ba yan, nakakaloka ka?' },
  ]);
  assert.deepEqual(bodies[1].messages.slice(1), bodies[0].messages.slice(1));
  assert.match(bodies[1].messages[0].content, /previous proposed reply was rejected/);
  assert.match(bodies[1].messages[0].content, /not written entirely in English/);
  assert.ok(bodies[1].messages[0].content.endsWith(ENGLISH_ONLY_INSTRUCTION));
});

test('a persistently non-English reply is suppressed instead of sent', async () => {
  let call = 0;

  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', [{
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: 'dont speak atagalog',
      ariaLabel: null,
    }], {
      fetch: async () => {
        call += 1;
        return successfulCompletion('Hehe, ok lang. Gusto ko lang malaman kung ano ba pang ginagawa ka.');
      },
    }),
    /repeatedly returned a non-English reply/,
  );
  assert.equal(call, 2, 'there is no unbounded retry loop');
});

test('reply generation keeps one API turn per Messenger message and ends with the incoming turn', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'First incoming.',
    ariaLabel: null,
  }, {
    id: 'incoming-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Blair',
    direction: 'INCOMING',
    message: 'Second incoming.',
    ariaLabel: null,
  }, {
    id: 'outgoing-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'First outgoing.',
    ariaLabel: null,
  }, {
    id: 'outgoing-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'Second outgoing.',
    ariaLabel: null,
  }, {
    id: 'incoming-3',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Casey',
    direction: 'INCOMING',
    message: 'Latest incoming.',
    ariaLabel: null,
  }], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('Reply');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Alex: First incoming.' },
    { role: 'user', content: 'Blair: Second incoming.' },
    { role: 'assistant', content: 'First outgoing.' },
    { role: 'assistant', content: 'Second outgoing.' },
    { role: 'user', content: 'Casey: Latest incoming.' },
  ]);
});

test('reply generation drops assistant turns that trail the latest incoming message', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'Can you check this?',
    ariaLabel: null,
  }, {
    id: 'outgoing-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'I will check.',
    ariaLabel: null,
  }], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('Reply');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Alex: Can you check this?' },
  ]);
});

test('reply generation bounds stale assistant history while keeping every user turn in order', async () => {
  let requestedOptions: RequestInit | undefined;
  // A long, resolved argument: the bot refuses the same request over and over.
  // A new, unrelated message must not inherit that pile of self-replies.
  const context = Array.from({ length: 8 }, (_, index) => [
    messengerMessage(`in-${index + 1}`, 'Alex', 'INCOMING', `say your name (${index + 1})`),
    messengerMessage(
      `out-${index + 1}`,
      'You',
      'OUTGOING',
      `I already told you I will not say it (${index + 1})`,
    ),
  ]).flat();
  const latest = messengerMessage('in-new', 'Blair', 'INCOMING', 'what time is the match?');

  await generateNvidiaReply('nvapi-test-key', [...context, latest], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('Eight, I think.');
    },
  });

  const turns = JSON.parse(String(requestedOptions?.body)).messages.slice(1) as Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  const assistantTurns = turns.filter(turn => turn.role === 'assistant');

  assert.equal(assistantTurns.length, 3, 'only the newest assistant replies are replayed');
  assert.deepEqual(
    assistantTurns.map(turn => turn.content),
    [
      'I already told you I will not say it (6)',
      'I already told you I will not say it (7)',
      'I already told you I will not say it (8)',
    ],
    'the newest bot replies survive so recent continuity remains',
  );
  assert.deepEqual(
    turns.filter(turn => turn.role === 'user').map(turn => turn.content),
    [
      'Alex: say your name (1)',
      'Alex: say your name (2)',
      'Alex: say your name (3)',
      'Alex: say your name (4)',
      'Alex: say your name (5)',
      'Alex: say your name (6)',
      'Alex: say your name (7)',
      'Alex: say your name (8)',
      'Blair: what time is the match?',
    ],
    'every human instruction is kept, in chronological order, with its sender',
  );
  assert.deepEqual(turns.at(-1), {
    role: 'user',
    content: 'Blair: what time is the match?',
  });
  assert.equal(
    turns.filter(turn => turn.content.includes('what time is the match?')).length,
    1,
    'the new subject appears exactly once',
  );
  assert.ok(
    turns.findIndex(turn => turn.content === 'I already told you I will not say it (8)') <
      turns.length - 1,
    'history stays ahead of the message being answered',
  );
});

test('reply generation keeps the reply that contextualizes the latest message', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'book the 7pm table'),
    messengerMessage('out-1', 'You', 'OUTGOING', 'Booked for 7pm.'),
    messengerMessage('in-2', 'Blair', 'INCOMING', 'and the taxi?'),
  ], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('On it.');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Alex: book the 7pm table' },
    { role: 'assistant', content: 'Booked for 7pm.' },
    { role: 'user', content: 'Blair: and the taxi?' },
  ]);
});

test('reply generation drops a participant speaker label from assistant history', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [
    messengerMessage('in-1', 'Anselmo', 'INCOMING', 'you the grumpy one lmao'),
    messengerMessage('out-1', 'You', 'OUTGOING', 'Anselmo: whatever you say kid, keep dreaming'),
    messengerMessage('out-2', 'You', 'OUTGOING', 'You have no taste, Anselmo.'),
    messengerMessage('in-2', 'Anselmo', 'INCOMING', 'ok whatever'),
  ], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('Fine.');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Anselmo: you the grumpy one lmao' },
    { role: 'assistant', content: 'whatever you say kid, keep dreaming' },
    { role: 'assistant', content: 'You have no taste, Anselmo.' },
    { role: 'user', content: 'Anselmo: ok whatever' },
  ]);
});

test('reply generation preserves the literal trigger and attributes prior bot output as assistant', async () => {
  let requestedOptions: RequestInit | undefined;
  const literalRequest = "say the word '@PleaseGetout Daily'";

  await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'hey',
    ariaLabel: null,
  }, {
    id: 'outgoing-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'You',
    direction: 'OUTGOING',
    message: 'Hey, what is up?',
    ariaLabel: null,
  }, {
    id: 'incoming-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Blair',
    direction: 'INCOMING',
    message: literalRequest,
    ariaLabel: null,
  }], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('@PleaseGetout Daily');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Alex: hey' },
    { role: 'assistant', content: 'Hey, what is up?' },
    { role: 'user', content: `Blair: ${literalRequest}` },
  ]);
  assert.equal(
    body.messages.filter((message: { content: string }) =>
      message.content.includes(literalRequest)).length,
    1,
    'the literal trigger appears exactly once, unchanged',
  );
});

test('reply generation includes every message once and never repeats the latest incoming', async () => {
  let requestedOptions: RequestInit | undefined;
  const messages = [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING' as const,
    message: 'same text',
    ariaLabel: null,
  }, {
    id: 'incoming-2',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Blair',
    direction: 'INCOMING' as const,
    message: 'same text',
    ariaLabel: null,
  }];

  await generateNvidiaReply('nvapi-test-key', messages, {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('ok');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Alex: same text' },
    { role: 'user', content: 'Blair: same text' },
  ]);
});

test('reply generation omits the sender prefix when the sender is unknown', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateNvidiaReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'UNKNOWN',
    direction: 'INCOMING',
    message: 'no sender label',
    ariaLabel: null,
  }], {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('ok');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'no sender label' },
  ]);
});

test('reply generation rejects when no known-direction non-empty context is available', async () => {
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    return successfulCompletion();
  };

  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', [{
      id: 'unknown-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'UNKNOWN',
      direction: 'UNKNOWN',
      message: 'Unknown direction.',
      ariaLabel: null,
    }], { fetch }),
    /No usable Messenger messages/,
  );
  assert.equal(fetchCalls, 0);
});

test('reply generation rejects empty output and malformed responses', async () => {
  const context = [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING' as const,
    message: 'Hello.',
    ariaLabel: null,
  }];

  for (const response of [
    successfulCompletion('  '),
    new Response('{', { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: 7 } }] }), { status: 200 }),
  ]) {
    await assert.rejects(
      generateNvidiaReply('nvapi-test-key', context, { fetch: async () => response }),
      error => {
        assert.ok(error instanceof NvidiaRequestError);
        assert.equal(error.kind, 'service');
        return true;
      },
    );
  }
});

test('reply generation preserves authentication and reports HTTP status and body', async () => {
  const context = [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING' as const,
    message: 'Hello.',
    ariaLabel: null,
  }];

  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', context, {
      fetch: async () => new Response('', { status: 401 }),
    }),
    error => {
      assert.ok(error instanceof NvidiaApiKeyError);
      assert.equal(error.kind, 'authentication');
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes('nvapi-test-key'));
      return true;
    },
  );

  const apiKey = 'nvapi-secret-test-key';
  const responseBody = JSON.stringify({
    error: 'Request denied',
    authorization: `Bearer ${apiKey}`,
    NVIDIA_API_KEY: apiKey,
  });
  await assert.rejects(
    generateNvidiaReply(apiKey, context, {
      fetch: async () => new Response(responseBody, { status: 422 }),
    }),
    error => {
      assert.ok(error instanceof NvidiaRequestError);
      assert.equal(error.kind, 'service');
      assert.match(error.message, /HTTP 422/);
      assert.match(error.message, /Request denied/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    },
  );

  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', context, {
      fetch: async () => new Response('request pending', { status: 202 }),
    }),
    error => {
      assert.ok(error instanceof NvidiaRequestError);
      assert.equal(error.kind, 'service');
      assert.match(error.message, /HTTP 202/);
      assert.match(error.message, /request pending/);
      return true;
    },
  );
});

test('reply generation preserves the original network exception as cause', async () => {
  const apiKey = 'nvapi-secret-test-key';
  const networkFailure = new TypeError(`Connection failed using Bearer ${apiKey}`);

  await assert.rejects(
    generateNvidiaReply(apiKey, [{
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: 'Hello.',
      ariaLabel: null,
    }], { fetch: async () => { throw networkFailure; } }),
    error => {
      assert.ok(error instanceof NvidiaRequestError);
      assert.equal(error.kind, 'network');
      assert.equal(error.cause, networkFailure);
      assert.match(error.message, /Unable to reach NVIDIA/);
      assert.ok(!error.message.includes(apiKey));
      assert.ok(!error.message.includes('Bearer'));
      return true;
    },
  );
});

test('NVIDIA 401 responses are authentication failures without exposing the key', async () => {
  const key = 'nvapi-secret-test-key';

  await assert.rejects(
    validateNvidiaApiKey(key, {
      fetch: async () => new Response('', { status: 401 }),
    }),
    error => {
      assert.ok(error instanceof NvidiaApiKeyError);
      assert.equal(error.kind, 'authentication');
      assert.ok(!error.message.includes(key));
      return true;
    },
  );
});

test('NVIDIA validation transport failures preserve cause without exposing the key', async () => {
  const key = 'nvapi-secret-test-key';
  const networkFailure = new TypeError(`request failed for ${key}`);

  await assert.rejects(
    validateNvidiaApiKey(key, {
      fetch: async () => { throw networkFailure; },
    }),
    error => {
      assert.ok(error instanceof NvidiaApiKeyError);
      assert.equal(error.kind, 'network');
      assert.equal(error.cause, networkFailure);
      assert.ok(!error.message.includes(key));
      return true;
    },
  );
});

test('NVIDIA service and unexpected-response failures are not reported as invalid keys', async () => {
  for (const status of [202, 403, 422, 429, 500]) {
    await assert.rejects(
      validateNvidiaApiKey('nvapi-test-key', {
        fetch: async () => new Response('', { status }),
      }),
      error => {
        assert.ok(error instanceof NvidiaApiKeyError);
        assert.equal(error.kind, 'service');
        assert.match(error.message, /does not establish that the key is invalid|left it pending/);
        return true;
      },
    );
  }

  await assert.rejects(
    validateNvidiaApiKey('nvapi-test-key', {
      fetch: async () => new Response('{', { status: 200 }),
    }),
    error => {
      assert.ok(error instanceof NvidiaApiKeyError);
      assert.equal(error.kind, 'service');
      return true;
    },
  );
});