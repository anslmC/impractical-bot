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
  assert.deepEqual(JSON.parse(String(requestedOptions?.body)), {
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    messages: [
      {
        role: 'system',
        content: 'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.',
      },
      { role: 'user', content: 'Alex: Are you free tomorrow?' },
      { role: 'assistant', content: 'I think so.' },
      { role: 'user', content: 'Blair: Great, what time works?' },
    ],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 4096,
    stream: false,
  });
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

test('reply generation coalesces consecutive roles and ends with the incoming turn', async () => {
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
    { role: 'user', content: 'Alex: First incoming.\nBlair: Second incoming.' },
    { role: 'assistant', content: 'First outgoing.\nSecond outgoing.' },
    { role: 'user', content: 'Casey: Latest incoming.' },
  ]);
});

test('reply generation repeats the latest actual incoming turn after a trailing assistant turn', async () => {
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
    { role: 'assistant', content: 'I will check.' },
    { role: 'user', content: 'Alex: Can you check this?' },
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