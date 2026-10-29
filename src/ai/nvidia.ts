import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { config as loadDotenv, parse } from 'dotenv';
import { resolveConfigurationPaths } from '../config/configuration.js';
import type { BackreadMessage } from '../components/backread.js';

const NVIDIA_CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_CHAT_COMPLETIONS_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const DEFAULT_REQUEST_TIMEOUT_MS = 50_000;
// A Messenger reply is a chat message, not an essay: cap the completion so a
// runaway generation cannot ramble, and so a slow response cannot widen the
// window in which another reply is generated for the same trigger.
const REPLY_MAX_TOKENS = 256;
// Every incoming message is kept because it carries the human's instructions,
// but only the newest few assistant turns are sent: a long run of the bot's own
// earlier replies makes the model continue an obsolete exchange (for example,
// re-arguing about its own alias) instead of answering the newest message.
const MAX_ASSISTANT_HISTORY_TURNS = 3;
const VALIDATION_MAX_TOKENS = 4096;
const DEFAULT_SYSTEM_INSTRUCTION = 'Write a short, natural Messenger reply that matches the conversation\'s tone and directly addresses the latest incoming message. Aim for roughly 3–12 words when appropriate, but do not force an exact word count; use more words when needed for a natural answer. Avoid unsolicited email copy, calls to action, headings, labels, and unrelated prefixes such as "Verse 3.1". Return only the reply text. This reply is a proposal until the application sends it.';

export type NvidiaApiKeyErrorKind = 'authentication' | 'network' | 'service';

export class NvidiaApiKeyError extends Error {
  constructor(readonly kind: NvidiaApiKeyErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NvidiaApiKeyError';
  }
}

export type NvidiaRequestErrorKind = 'network' | 'service';

export class NvidiaRequestError extends Error {
  constructor(readonly kind: NvidiaRequestErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NvidiaRequestError';
  }
}

export interface NvidiaRequestOptions {
  fetch?: typeof fetch;
  systemInstruction?: string;
  timeoutMs?: number;
}

export type NvidiaValidationOptions = NvidiaRequestOptions;

function redactCredentials(value: string, apiKey: string): string {
  const withApiKeyRedacted = apiKey
    ? value.replaceAll(apiKey, '[REDACTED]')
    : value;
  return withApiKeyRedacted.replace(
    /(["']?(?:[\w-]*api[_-]?key|access[_-]?token|authorization|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi,
    '$1[REDACTED]',
  );
}

async function readErrorResponse(response: Response, apiKey: string): Promise<{
  status: number;
  body: string;
}> {
  const status = response.status;
  let body: string;
  try {
    body = await response.text();
  } catch {
    body = '(response body could not be read)';
  }
  const redactedBody = redactCredentials(body.trim(), apiKey);
  return {
    status,
    body: redactedBody || '(empty response body)',
  };
}

function formatHttpFailure(status: number, body: string): string {
  return `HTTP ${status}. Response body: ${body}`;
}

export function resolveNvidiaEnvironmentPath(configurationFilePath?: string): string {
  const selectedConfigurationPath = configurationFilePath ?? resolveConfigurationPaths().filePath;
  return join(dirname(selectedConfigurationPath), '.env');
}

export function loadNvidiaApiKey(environmentFilePath: string): string | undefined {
  const result = loadDotenv({
    path: environmentFilePath,
    processEnv: {},
    override: true,
    quiet: true,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error('Unable to load the application NVIDIA API key.');
  }

  const key = result.parsed?.NVIDIA_API_KEY?.trim();
  return key || undefined;
}

export function saveNvidiaApiKey(environmentFilePath: string, apiKey: string): void {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey || /[\r\n]/.test(normalizedKey)) {
    throw new Error('The NVIDIA API key cannot be saved because its format is invalid.');
  }

  let variables: Record<string, string> = {};
  try {
    variables = parse(readFileSync(environmentFilePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to read the application environment file.');
    }
  }
  variables.NVIDIA_API_KEY = normalizedKey;

  const content = `${Object.entries(variables)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
  const directory = dirname(environmentFilePath);
  const temporaryPath = join(directory, `.${basename(environmentFilePath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    mkdirSync(directory, { recursive: true });
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, environmentFilePath);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Keep the original persistence failure.
      }
    }
    try {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Keep the original persistence failure.
    }
    throw new Error('Unable to save the application NVIDIA API key.');
  }
}

function isCompletionResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('choices' in value)) {
    return false;
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null || !('message' in firstChoice)) {
    return false;
  }
  const message = (firstChoice as { message?: unknown }).message;
  return typeof message === 'object' && message !== null &&
    'content' in message && typeof (message as { content?: unknown }).content === 'string';
}

export async function validateNvidiaApiKey(
  apiKey: string,
  options: NvidiaValidationOptions = {},
): Promise<void> {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new NvidiaApiKeyError('authentication', 'The NVIDIA API key is empty or malformed.');
  }

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(NVIDIA_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NVIDIA_CHAT_COMPLETIONS_MODEL,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        chat_template_kwargs: { enable_thinking: false  },
        max_tokens: VALIDATION_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NvidiaApiKeyError(
      'network',
      'Unable to reach NVIDIA to validate the API key. Check the network connection and try again.',
      { cause: error },
    );
  }

  const failure = response.status === 200
    ? undefined
    : await readErrorResponse(response, apiKey);
  if (response.status === 401) {
    throw new NvidiaApiKeyError(
      'authentication',
      `NVIDIA rejected the API key. ${formatHttpFailure(failure!.status, failure!.body)}`,
    );
  }
  if (response.status === 202) {
    throw new NvidiaApiKeyError(
      'service',
      `NVIDIA accepted the validation request but left it pending. ` +
      `${formatHttpFailure(failure!.status, failure!.body)} Try again later.`,
    );
  }
  if (response.status !== 200) {
    throw new NvidiaApiKeyError(
      'service',
      `NVIDIA could not validate the API key. ` +
      `${formatHttpFailure(failure!.status, failure!.body)} ` +
      'This does not establish that the key is invalid.',
    );
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NvidiaApiKeyError('service', 'NVIDIA returned an unexpected validation response.');
    }
    throw new NvidiaApiKeyError(
      'network',
      'The NVIDIA validation response could not be read. Try again.',
      { cause: error },
    );
  }
  if (!isCompletionResponse(body)) {
    throw new NvidiaApiKeyError('service', 'NVIDIA returned an unexpected validation response.');
  }
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Keeps every incoming turn (they carry the human's instructions and the current
// topic) and only the newest assistant turns, so recent continuity survives while
// stale self-replies cannot dominate the request. Order is never changed and the
// latest incoming message stays last because it is the newest turn.
function limitAssistantHistory(
  turns: readonly ConversationTurn[],
): ConversationTurn[] {
  let assistantTurns = 0;
  const kept: ConversationTurn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === 'assistant') {
      if (assistantTurns >= MAX_ASSISTANT_HISTORY_TURNS) {
        continue;
      }
      assistantTurns += 1;
    }
    kept.push(turn);
  }
  return kept.reverse();
}

export async function generateNvidiaReply(
  apiKey: string,
  messages: readonly BackreadMessage[],
  options: NvidiaRequestOptions = {},
): Promise<string> {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new NvidiaApiKeyError('authentication', 'The NVIDIA API key is empty or malformed.');
  }

  // One API turn per Messenger message keeps speaker attribution and turn
  // boundaries intact: every incoming message is a user turn prefixed with its
  // sender, and every outgoing message is an assistant turn (the bot's own post).
  // Messages are never merged or repeated.
  const conversationMessages: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.direction !== 'INCOMING' && message.direction !== 'OUTGOING') {
      continue;
    }
    const content = message.message.trim();
    if (!content) {
      continue;
    }
    const isIncoming = message.direction === 'INCOMING';
    const senderName = typeof message.sender === 'string' ? message.sender.trim() : '';
    const sender = isIncoming && senderName && senderName !== 'UNKNOWN'
      ? `${senderName}: `
      : '';
    conversationMessages.push({
      role: isIncoming ? 'user' : 'assistant',
      content: `${sender}${content}`,
    });
  }
  if (conversationMessages.length === 0) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }
  let latestIncomingIndex = -1;
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (conversationMessages[index].role === 'user') {
      latestIncomingIndex = index;
      break;
    }
  }
  if (latestIncomingIndex === -1) {
    throw new Error('No incoming Messenger messages are available to generate a reply.');
  }
  // Trailing assistant turns are replies that the current reply supersedes; the
  // request must end with the message being answered, without restating it twice.
  const requestMessages = limitAssistantHistory(
    conversationMessages.slice(0, latestIncomingIndex + 1),
  );

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(NVIDIA_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NVIDIA_CHAT_COMPLETIONS_MODEL,
        messages: [
          {
            role: 'system',
            content: options.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION,
          },
          ...requestMessages,
        ],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: REPLY_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NvidiaRequestError(
      'network',
      'Unable to reach NVIDIA to generate a reply. Check the network connection and try again.',
      { cause: error },
    );
  }

  const failure = response.status === 200
    ? undefined
    : await readErrorResponse(response, apiKey);
  if (response.status === 401) {
    throw new NvidiaApiKeyError(
      'authentication',
      `NVIDIA rejected the API key. ${formatHttpFailure(failure!.status, failure!.body)}`,
    );
  }
  if (response.status === 202) {
    throw new NvidiaRequestError(
      'service',
      `NVIDIA accepted the reply request but left it pending. ` +
      `${formatHttpFailure(failure!.status, failure!.body)} Try again later.`,
    );
  }
  if (response.status !== 200) {
    throw new NvidiaRequestError(
      'service',
      `NVIDIA could not generate a reply. ${formatHttpFailure(failure!.status, failure!.body)}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NvidiaRequestError(
        'service',
        'NVIDIA returned an unexpected reply response.',
        { cause: error },
      );
    }
    throw new NvidiaRequestError(
      'network',
      'The NVIDIA reply response could not be read. Try again.',
      { cause: error },
    );
  }
  if (!isCompletionResponse(body)) {
    throw new NvidiaRequestError('service', 'NVIDIA returned an unexpected reply response.');
  }

  const reply = (body as { choices: { message: { content: string } }[] })
    .choices[0].message.content.trim();
  if (!reply) {
    throw new NvidiaRequestError('service', 'NVIDIA returned an empty reply.');
  }
  return reply;
}