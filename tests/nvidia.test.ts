import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadNvidiaApiKey,
  NvidiaApiKeyError,
  NvidiaIdentityError,
  NvidiaRequestError,
  generateNvidiaReply,
  resolveNvidiaEnvironmentPath,
  saveNvidiaApiKey,
  validateNvidiaApiKey,
} from '../src/ai/nvidia.js';
import {
  ENGLISH_ONLY_INSTRUCTION,
  ENGLISH_ONLY_RETRY_INSTRUCTION,
} from '../src/components/english-only.js';
import { IDENTITY_RETRY_INSTRUCTION } from '../src/components/identity-policy.js';
import { IDENTITY_AWARENESS_INSTRUCTION_MARKER } from '../src/components/identity-awareness.js';
import {
  generateReplyWithAntiEchoGuard,
  isEchoReply,
} from '../src/components/anti-echo.js';
import {
  CONVERSATIONAL_INITIATIVE_INSTRUCTION_MARKER,
  MEMORY_HONESTY_INSTRUCTION_MARKER,
} from '../src/components/personality.js';
import {
  createUnavailableGroupRoster,
  type GroupRoster,
} from '../src/browser/group-roster.js';

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

function generateTestReply(
  apiKey: string,
  messages: Parameters<typeof generateNvidiaReply>[1],
  options: Partial<Parameters<typeof generateNvidiaReply>[2]> = {},
): Promise<string> {
  return generateNvidiaReply(apiKey, messages, {
    systemInstruction: 'Test system instruction.',
    identity: { name: 'TestBot' },
    ...options,
  });
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

  const reply = await generateTestReply('nvapi-test-key', [{
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
  assert.equal(body.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.max_tokens, 256);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.startsWith('Test system instruction.'));
  assert.match(body.messages[0].content, /Identity and recipient awareness:/);
  assert.match(
    body.messages[0].content,
    /Other identified participants in this conversation: Alex, Blair\./,
  );
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: '[from Alex] Are you free tomorrow?' },
    { role: 'assistant', content: 'I think so.' },
    { role: 'user', content: '[from Blair] Great, what time works?' },
  ]);
});

test('reply generation uses a supplied system instruction before conversation messages', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [{
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
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.startsWith('Supplied instruction.'));
  assert.match(body.messages[0].content, /Identity and recipient awareness:/);
  assert.match(
    body.messages[0].content,
    /Other identified participants in this conversation: Alex\./,
  );
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: '[from Alex] Hello.' },
  ]);
});

test('supplied system instructions receive memory and initiative guardrails once', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [{
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
  const systemInstruction = String(body.messages[0].content);
  assert.match(systemInstruction, new RegExp(MEMORY_HONESTY_INSTRUCTION_MARKER));
  assert.match(systemInstruction, new RegExp(CONVERSATIONAL_INITIATIVE_INSTRUCTION_MARKER));
  assert.equal(systemInstruction.match(/Memory and conversational history:/gu)?.length, 1);
  assert.equal(systemInstruction.match(/Conversational initiative:/gu)?.length, 1);
  assert.ok(systemInstruction.startsWith('Supplied instruction.'));
});

test('a non-English reply is retried without dropping multilingual context', async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let call = 0;

  const reply = await generateTestReply('nvapi-test-key', [{
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
    { role: 'user', content: '[from Alex] dont speak atagalog' },
    {
      role: 'assistant',
      content: 'Okay lang naman yan. :p Ang sagot ko ay nakapag-alam ka naman...',
    },
    { role: 'user', content: '[from Blair] Ano ba yan, nakakaloka ka?' },
  ]);
  assert.deepEqual(bodies[1].messages.slice(1), bodies[0].messages.slice(1));
  assert.match(bodies[1].messages[0].content, /previous proposed reply was rejected/);
  assert.match(bodies[1].messages[0].content, /not written entirely in English/);
  assert.ok(bodies[1].messages[0].content.endsWith(ENGLISH_ONLY_RETRY_INSTRUCTION));
  assert.equal(
    bodies[1].messages[0].content.split(ENGLISH_ONLY_INSTRUCTION).length - 1,
    0,
    'the retry does not duplicate the canonical policy when the caller did not supply it',
  );
});

test('a persistently non-English reply is suppressed instead of sent', async () => {
  let call = 0;

  await assert.rejects(
    generateTestReply('nvapi-test-key', [{
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

test('an invalid identity is retried once with the identity correction', async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let call = 0;

  const reply = await generateTestReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'who are you?',
    ariaLabel: null,
  }], {
    systemInstruction: 'Production instruction.',
    identity: { name: 'Yukinon', aliases: ['@Yukinon', 'Yuki'] },
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      call += 1;
      return call === 1
        ? successfulCompletion('I am Nemotron.')
        : successfulCompletion('I am Yukinon.');
    },
  });

  assert.equal(call, 2, 'the rejected identity is retried exactly once');
  assert.equal(reply, 'I am Yukinon.');
  assert.ok(bodies[1].messages[0].content.startsWith('Production instruction.'));
  assert.ok(bodies[1].messages[0].content.endsWith(IDENTITY_RETRY_INSTRUCTION));
  assert.equal(
    bodies[1].messages[0].content.split(IDENTITY_RETRY_INSTRUCTION).length - 1,
    1,
  );
});

test('a persistently invalid identity is withheld instead of sent', async () => {
  let call = 0;

  await assert.rejects(
    generateTestReply('nvapi-test-key', [{
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: 'who are you?',
      ariaLabel: null,
    }], {
      identity: { name: 'Yukinon' },
      fetch: async () => {
        call += 1;
        return successfulCompletion('I am ChatGPT.');
      },
    }),
    error => {
      assert.ok(error instanceof NvidiaIdentityError);
      assert.equal(error.reason, 'provider-model-identity');
      return true;
    },
  );
  assert.equal(call, 2, 'there is no unbounded identity retry loop');
});

test('language and identity violations share one bounded corrective retry', async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let call = 0;

  const reply = await generateTestReply('nvapi-test-key', [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING',
    message: 'sino ka?',
    ariaLabel: null,
  }], {
    systemInstruction: 'Production instruction.',
    identity: { name: 'Yukinon' },
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      call += 1;
      return call === 1
        ? successfulCompletion('I am Nemotron, ang AI model na tumutulong sa iyo.')
        : successfulCompletion('I am Yukinon.');
    },
  });

  assert.equal(call, 2, 'both violations are corrected in a single retry');
  assert.equal(reply, 'I am Yukinon.');
  const retryInstruction = bodies[1].messages[0].content;
  assert.ok(retryInstruction.includes(ENGLISH_ONLY_RETRY_INSTRUCTION));
  assert.ok(retryInstruction.includes(IDENTITY_RETRY_INSTRUCTION));
});

test('generation requires a complete system instruction and a configured identity', async () => {
  const messages = [{
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING' as const,
    message: 'hello',
    ariaLabel: null,
  }];

  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', messages, {
      systemInstruction: '   ',
      identity: { name: 'Yukinon' },
      fetch: async () => successfulCompletion('hi'),
    }),
    /complete system instruction is required/,
  );
  await assert.rejects(
    generateNvidiaReply('nvapi-test-key', messages, {
      systemInstruction: 'Production instruction.',
      identity: { name: '   ' },
      fetch: async () => successfulCompletion('hi'),
    }),
    /configured bot identity is required/,
  );
});

test('the combined validation and anti-echo path makes at most four completion calls', async () => {
  const tagalog = 'Hear you? Opo, talo na ako sa\'yo ng tanong. Ano ba talaga ng bigay mo? :p';
  const replies = [tagalog, 'what', tagalog, 'nothing much'];
  let call = 0;

  const result = await generateReplyWithAntiEchoGuard({
    generate: ({ retry }) => generateTestReply('nvapi-test-key', [{
      id: 'incoming-1',
      timestamp: { original: null, normalized: null, resolved: false },
      sender: 'Alex',
      direction: 'INCOMING',
      message: 'what',
      ariaLabel: null,
    }], {
      systemInstruction: retry ? 'Production instruction with anti-echo.' : 'Production instruction.',
      identity: { name: 'Yukinon' },
      fetch: async () => {
        const content = replies[call] ?? 'unexpected extra call';
        call += 1;
        return successfulCompletion(content);
      },
    }),
    isEcho: reply => isEchoReply(reply, 'what'),
  });

  assert.equal(call, 4, 'two bounded corrections leave four calls as the maximum');
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') {
    assert.equal(result.reply, 'nothing much');
  }
});

test('reply generation keeps one API turn per Messenger message and ends with the incoming turn', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [{
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
    { role: 'user', content: '[from Alex] First incoming.' },
    { role: 'user', content: '[from Blair] Second incoming.' },
    { role: 'assistant', content: 'First outgoing.' },
    { role: 'assistant', content: 'Second outgoing.' },
    { role: 'user', content: '[from Casey] Latest incoming.' },
  ]);
});

test('reply generation drops assistant turns that trail the latest incoming message', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [{
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
    { role: 'user', content: '[from Alex] Can you check this?' },
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

  await generateTestReply('nvapi-test-key', [...context, latest], {
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
      '[from Alex] say your name (1)',
      '[from Alex] say your name (2)',
      '[from Alex] say your name (3)',
      '[from Alex] say your name (4)',
      '[from Alex] say your name (5)',
      '[from Alex] say your name (6)',
      '[from Alex] say your name (7)',
      '[from Alex] say your name (8)',
      '[from Blair] what time is the match?',
    ],
    'every human instruction is kept, in chronological order, with its sender',
  );
  assert.deepEqual(turns.at(-1), {
    role: 'user',
    content: '[from Blair] what time is the match?',
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

  await generateTestReply('nvapi-test-key', [
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
    { role: 'user', content: '[from Alex] book the 7pm table' },
    { role: 'assistant', content: 'Booked for 7pm.' },
    { role: 'user', content: '[from Blair] and the taxi?' },
  ]);
});

test('reply generation drops a participant speaker label from assistant history', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [
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
    { role: 'user', content: '[from Anselmo] you the grumpy one lmao' },
    { role: 'assistant', content: 'whatever you say kid, keep dreaming' },
    { role: 'assistant', content: 'You have no taste, Anselmo.' },
    { role: 'user', content: '[from Anselmo] ok whatever' },
  ]);
});

test('reply generation preserves the literal trigger and attributes prior bot output as assistant', async () => {
  let requestedOptions: RequestInit | undefined;
  const literalRequest = "say the word '@PleaseGetout Daily'";

  await generateTestReply('nvapi-test-key', [{
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
    { role: 'user', content: '[from Alex] hey' },
    { role: 'assistant', content: 'Hey, what is up?' },
    { role: 'user', content: `[from Blair] ${literalRequest}` },
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

  await generateTestReply('nvapi-test-key', messages, {
    fetch: async (_input, init) => {
      requestedOptions = init;
      return successfulCompletion('ok');
    },
  });

  const body = JSON.parse(String(requestedOptions?.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: '[from Alex] same text' },
    { role: 'user', content: '[from Blair] same text' },
  ]);
});

test('reply generation omits the sender prefix when the sender is unknown', async () => {
  let requestedOptions: RequestInit | undefined;

  await generateTestReply('nvapi-test-key', [{
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
    generateTestReply('nvapi-test-key', [{
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
      generateTestReply('nvapi-test-key', context, { fetch: async () => response }),
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
    generateTestReply('nvapi-test-key', context, {
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
    generateTestReply(apiKey, context, {
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
    generateTestReply('nvapi-test-key', context, {
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
    generateTestReply(apiKey, [{
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
test('generation includes identity-awareness guidance with configured identity and participants', async () => {
  let systemInstruction = '';
  await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'TestBot, are you around?'),
    messengerMessage('out-1', 'You', 'OUTGOING', 'I am here.'),
    messengerMessage('in-2', 'Blair', 'INCOMING', 'Alex, can you send the file?'),
  ], {
    identity: { name: 'TestBot', aliases: ['@TestBot', 'TB'] },
    fetch: async (_input, init) => {
      systemInstruction = JSON.parse(String(init?.body)).messages[0].content;
      return successfulCompletion('Here.');
    },
  });

  assert.match(systemInstruction, new RegExp(IDENTITY_AWARENESS_INSTRUCTION_MARKER));
  assert.match(systemInstruction, /You are TestBot/);
  assert.match(systemInstruction, /aliases @TestBot, TB refer to you/);
  assert.match(systemInstruction, /Other identified participants in this conversation: Alex, Blair\./);
  assert.doesNotMatch(systemInstruction, /Other identified participants.*TestBot/);
  assert.match(systemInstruction, /You do not need an invitation/);
  assert.match(systemInstruction, /addressed to another participant/);
  assert.match(systemInstruction, /saying "I am <name>"/);
  assert.match(systemInstruction, /configured identity is authoritative/);
});

test('generation keeps identity-awareness guidance across the corrective retry', async () => {
  const instructions: string[] = [];
  let calls = 0;

  const reply = await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'who are you?'),
  ], {
    identity: { name: 'TestBot' },
    fetch: async (_input, init) => {
      instructions.push(JSON.parse(String(init?.body)).messages[0].content);
      calls += 1;
      return successfulCompletion(calls === 1 ? 'I am Alex.' : 'I am TestBot.');
    },
  });

  assert.equal(reply, 'I am TestBot.');
  assert.equal(calls, 2);
  for (const instruction of instructions) {
    assert.match(instruction, new RegExp(IDENTITY_AWARENESS_INSTRUCTION_MARKER));
    assert.match(instruction, /You are TestBot/);
  }
  assert.ok(instructions[1].endsWith(IDENTITY_RETRY_INSTRUCTION));
});

test('generation proceeds when the roster is unavailable', async () => {
  let systemInstruction = '';
  const reply = await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'hello'),
  ], {
    roster: createUnavailableGroupRoster('roster timed out'),
    fetch: async (_input, init) => {
      systemInstruction = JSON.parse(String(init?.body)).messages[0].content;
      return successfulCompletion('Hi.');
    },
  });

  assert.equal(reply, 'Hi.');
  assert.match(systemInstruction, /Group membership context: unavailable\./u);
  assert.match(systemInstruction, new RegExp(IDENTITY_AWARENESS_INSTRUCTION_MARKER));
  assert.match(systemInstruction, /Other identified participants in this conversation: Alex\./);
});

test('withheld assistant turns are reported and excluded from the transcript', async () => {
  const diagnostics: Array<{ messageId: string | null; reason: string }> = [];
  let body: { messages: { role: string; content: string }[] } | undefined;

  const reply = await generateNvidiaReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'who are you?'),
    messengerMessage('out-1', 'You', 'OUTGOING', 'I am Nemotron.'),
    messengerMessage('in-2', 'Alex', 'INCOMING', 'say it again'),
  ], {
    systemInstruction: 'Production instruction.',
    identity: { name: 'Yukinon' },
    onDiagnostic: diagnostic => diagnostics.push({
      messageId: diagnostic.messageId,
      reason: diagnostic.reason,
    }),
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return successfulCompletion('I am Yukinon.');
    },
  });

  assert.equal(reply, 'I am Yukinon.');
  assert.deepEqual(diagnostics, [
    { messageId: 'out-1', reason: 'provider-model-identity' },
  ]);
  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Alex] who are you?' },
    { role: 'user', content: '[from Alex] say it again' },
  ]);
});

test('a message authored by the configured identity is serialized as an assistant turn', async () => {
  let body: { messages: { role: string; content: string }[] } | undefined;

  await generateNvidiaReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'hi'),
    messengerMessage('own-1', 'Yukinon', 'INCOMING', 'I am here.'),
    messengerMessage('in-2', 'Alex', 'INCOMING', 'good'),
  ], {
    systemInstruction: 'Production instruction.',
    identity: { name: 'Yukinon' },
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return successfulCompletion('Hey.');
    },
  });

  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Alex] hi' },
    { role: 'assistant', content: 'I am here.' },
    { role: 'user', content: '[from Alex] good' },
  ]);
});

test('generation labels known senders as authors and leaves unknown senders unlabeled', async () => {
  let body: { messages: { role: string; content: string }[] } | undefined;
  await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'TestBot'),
    messengerMessage('out-1', 'You', 'OUTGOING', 'An earlier reply.'),
    messengerMessage('in-2', 'Alex', 'INCOMING', 'Hello TestBot can you hear me?'),
    messengerMessage('in-3', 'Alex', 'INCOMING', 'Blair can you hear me?'),
    messengerMessage('in-4', 'Alex', 'INCOMING', 'Can you hear me?'),
    messengerMessage('in-5', 'UNKNOWN', 'INCOMING', 'no sender label'),
  ], {
    identity: { name: 'TestBot' },
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return successfulCompletion('Here.');
    },
  });

  assert.deepEqual(body?.messages.slice(1), [
    { role: 'user', content: '[from Alex] TestBot' },
    { role: 'assistant', content: 'An earlier reply.' },
    { role: 'user', content: '[from Alex] Hello TestBot can you hear me?' },
    { role: 'user', content: '[from Alex] Blair can you hear me?' },
    { role: 'user', content: '[from Alex] Can you hear me?' },
    { role: 'user', content: 'no sender label' },
  ]);
  assert.doesNotMatch(body?.messages[1].content ?? '', /Alex:/);
});
test('generation appends roster context using first names only', async () => {
  const roster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'TestBot', isPuppet: true },
      { firstName: 'Alex', isPuppet: false },
    ],
    puppet: { firstName: 'TestBot', isPuppet: true },
    duplicateFirstNames: [],
  };
  let systemInstruction = '';

  await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'Hello.'),
  ], {
    roster,
    fetch: async (_input, init) => {
      systemInstruction = JSON.parse(String(init?.body)).messages[0].content;
      return successfulCompletion('Hi Alex.');
    },
  });

  assert.match(systemInstruction, /Test system instruction\./u);
  assert.match(systemInstruction, /Group membership context: partial\./u);
  assert.match(systemInstruction, /Observed first names: TestBot \(you\), Alex\./u);
  assert.equal(systemInstruction.includes('Smith'), false);
});

test('generation receives roster context with duplicates preserved', async () => {
  const roster: GroupRoster = {
    status: 'partial',
    members: [
      { firstName: 'TestBot', isPuppet: true },
      { firstName: 'Alex', isPuppet: false },
      { firstName: 'Sam', isPuppet: false },
      { firstName: 'Sam', isPuppet: false },
    ],
    puppet: { firstName: 'TestBot', isPuppet: true },
    duplicateFirstNames: ['Sam'],
  };
  let systemInstruction = '';

  const reply = await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Alex', 'INCOMING', 'Sam, can you send it?'),
  ], {
    roster,
    fetch: async (_input, init) => {
      systemInstruction = JSON.parse(String(init?.body)).messages[0].content;
      return successfulCompletion('Sam can send it.');
    },
  });

  assert.equal(reply, 'Sam can send it.');
  assert.match(systemInstruction, /Group membership context: partial\./u);
  assert.match(systemInstruction, /Observed first names: TestBot \(you\), Alex, Sam, Sam\./u);
  assert.match(systemInstruction, /Duplicate first names observed: Sam/u);
  assert.match(systemInstruction, /Other identified participants in this conversation: Alex, Sam\./u);
});

test('generation sanitizes full display names before building the request', async () => {
  const roster = {
    status: 'partial',
    members: [
      { firstName: 'Yukinon Yukinoshita', isPuppet: true },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
    ],
    puppet: { firstName: 'Yukinon Yukinoshita', isPuppet: true },
    duplicateFirstNames: [],
  } as GroupRoster;
  let requestBody = '';

  await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Geoff', 'INCOMING', 'Hello.'),
  ], {
    identity: { name: 'Yukinon' },
    roster,
    fetch: async (_input, init) => {
      requestBody = String(init?.body);
      return successfulCompletion('Hi Geoff.');
    },
  });

  assert.match(requestBody, /Observed first names: Yukinon \(you\), Geoff\./u);
  for (const surname of ['Yukinoshita', 'Markus', 'Del Rio']) {
    assert.equal(requestBody.includes(surname), false);
  }
});

test('generation sanitizes full display names and duplicate first names', async () => {
  const roster = {
    status: 'partial',
    members: [
      { firstName: 'TestBot Testbotson', isPuppet: true },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
    ],
    puppet: { firstName: 'TestBot Testbotson', isPuppet: true },
    duplicateFirstNames: ['Geoff Markus Del Rio'],
  } as GroupRoster;
  let requestBody = '';

  const reply = await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Geoff', 'INCOMING', 'Geoff, can you send it?'),
  ], {
    roster,
    fetch: async (_input, init) => {
      requestBody = String(init?.body);
      return successfulCompletion('Geoff can send it.');
    },
  });

  assert.equal(reply, 'Geoff can send it.');
  assert.match(requestBody, /Observed first names: TestBot \(you\), Geoff, Geoff\./u);
  assert.match(requestBody, /Duplicate first names observed: Geoff/u);
  assert.match(requestBody, /Other identified participants in this conversation: Geoff\./u);
  for (const surname of ['Testbotson', 'Markus', 'Del Rio']) {
    assert.equal(requestBody.includes(surname), false);
  }
});

test('a sanitized roster puppet does not block the configured identity', async () => {
  let calls = 0;
  const roster = {
    status: 'partial',
    members: [
      { firstName: 'Yukinon Yukinoshita', isPuppet: true },
      { firstName: 'Geoff Markus Del Rio', isPuppet: false },
    ],
    puppet: { firstName: 'Yukinon Yukinoshita', isPuppet: true },
    duplicateFirstNames: [],
  } as GroupRoster;

  const reply = await generateTestReply('nvapi-test-key', [
    messengerMessage('in-1', 'Geoff', 'INCOMING', 'Who are you?'),
  ], {
    identity: { name: 'Yukinon' },
    roster,
    fetch: async () => {
      calls += 1;
      return successfulCompletion('I am Yukinon.');
    },
  });

  assert.equal(reply, 'I am Yukinon.');
  assert.equal(calls, 1);
});
