import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadNvidiaApiKey,
  NvidiaApiKeyError,
  resolveNvidiaEnvironmentPath,
  saveNvidiaApiKey,
  validateNvidiaApiKey,
} from '../src/ai/nvidia.js';

function createEnvironmentPath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'impractical-bot-nvidia-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, '.env');
}

function successfulCompletion(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'O' } }],
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
    model: 'openai/gpt-oss-20b',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    reasoning_effort: 'low',
    max_tokens: 4096,
    stream: false,
  });
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

test('NVIDIA transport failures are network errors and do not expose the key', async () => {
  const key = 'nvapi-secret-test-key';

  await assert.rejects(
    validateNvidiaApiKey(key, {
      fetch: async () => { throw new TypeError(`request failed for ${key}`); },
    }),
    error => {
      assert.ok(error instanceof NvidiaApiKeyError);
      assert.equal(error.kind, 'network');
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