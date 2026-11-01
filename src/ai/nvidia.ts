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
import {
  ENGLISH_ONLY_RETRY_INSTRUCTION,
  isEnglishOnlyReply,
} from '../components/english-only.js';
import {
  IDENTITY_RETRY_INSTRUCTION,
  validateReplyIdentity,
  type IdentityValidationContext,
  type IdentityViolationReason,
} from '../components/identity-policy.js';
import {
  appendGroupRosterInstruction,
  appendRetryInstruction,
  type BotIdentity,
} from '../components/personality.js';
import { sanitizeGroupRoster, type GroupRoster } from '../browser/group-roster.js';
import { appendIdentityAwarenessInstruction } from '../components/identity-awareness.js';
import { stripParticipantSpeakerLabel } from '../components/reply-normalization.js';

const NVIDIA_CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_CHAT_COMPLETIONS_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const DEFAULT_REQUEST_TIMEOUT_MS = 50_000;
const REPLY_MAX_TOKENS = 256;
const MAX_ASSISTANT_HISTORY_TURNS = 3;
const VALIDATION_MAX_TOKENS = 4096;

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

export class NvidiaIdentityError extends Error {
  constructor(
    readonly reason: IdentityViolationReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NvidiaIdentityError';
  }
}

export interface ConversationDiagnostic {
  messageId: string | null;
  reason: IdentityViolationReason;
}

export type ConversationDiagnosticHandler = (diagnostic: ConversationDiagnostic) => void;

export interface NvidiaRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface NvidiaReplyRequestOptions extends NvidiaRequestOptions {
  systemInstruction: string;
  identity: BotIdentity;
  roster?: GroupRoster;
  onDiagnostic?: ConversationDiagnosticHandler;
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
      }
    }
    try {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    } catch {
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

function normalizeIdentityValue(value: string): string {
  return value
    .normalize('NFC')
    .replace(/^@+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function identityComparableNames(identity: BotIdentity): Set<string> {
  return new Set(
    [identity.name, ...(identity.aliases ?? [])]
      .map(normalizeIdentityValue)
      .filter(Boolean),
  );
}

function collectParticipantNames(
  messages: readonly BackreadMessage[],
  identity: BotIdentity,
): string[] {
  const ownNames = identityComparableNames(identity);
  const participantNames: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.direction === 'OUTGOING') {
      continue;
    }
    const senderName = typeof message.sender === 'string' ? message.sender.trim() : '';
    const comparable = normalizeIdentityValue(senderName);
    if (!senderName || comparable === 'unknown' || comparable === 'you' ||
        ownNames.has(comparable) || seen.has(comparable)) {
      continue;
    }
    seen.add(comparable);
    participantNames.push(senderName);
  }
  return participantNames;
}

function combineParticipantNames(
  identity: BotIdentity,
  ...nameLists: readonly (readonly string[])[]
): string[] {
  const ownNames = identityComparableNames(identity);
  const seen = new Set<string>();
  const participantNames: string[] = [];
  for (const name of nameLists.flat()) {
    const normalized = name.trim();
    const comparable = normalizeIdentityValue(normalized);
    if (!normalized || comparable === 'unknown' || comparable === 'you' ||
        ownNames.has(comparable) || seen.has(comparable)) {
      continue;
    }
    seen.add(comparable);
    participantNames.push(normalized);
  }
  return participantNames;
}

function collectRosterParticipantNames(roster?: GroupRoster): string[] {
  if (!roster || roster.status === 'unavailable' || roster.status === 'not-group') {
    return [];
  }
  return roster.members
    .filter(member => !member.isPuppet)
    .map(member => member.firstName);
}

function createIdentityContext(
  identity: BotIdentity,
  participantNames: readonly string[],
): IdentityValidationContext {
  return {
    name: identity.name,
    aliases: identity.aliases,
    participantNames,
  };
}

function buildConversationTurns(
  messages: readonly BackreadMessage[],
  identityContext: IdentityValidationContext,
  participantNames: readonly string[],
  onDiagnostic?: ConversationDiagnosticHandler,
): ConversationTurn[] {
  const ownNames = identityComparableNames(identityContext);
  const conversationMessages: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.direction !== 'INCOMING' && message.direction !== 'OUTGOING') {
      continue;
    }
    const content = message.message.trim();
    if (!content) {
      continue;
    }
    const senderName = typeof message.sender === 'string' ? message.sender.trim() : '';
    const senderIsBot = senderName !== '' &&
      senderName.toUpperCase() !== 'UNKNOWN' &&
      ownNames.has(normalizeIdentityValue(senderName));
    const isAssistantTurn = message.direction === 'OUTGOING' ||
      (message.direction === 'INCOMING' && senderIsBot);
    const turnContent = isAssistantTurn
      ? stripParticipantSpeakerLabel(content, participantNames)
      : content;
    if (isAssistantTurn) {
      const identityResult = validateReplyIdentity(turnContent, identityContext);
      if (!identityResult.valid) {
        onDiagnostic?.({
          messageId: message.id || null,
          reason: identityResult.reason,
        });
        continue;
      }
    }
    conversationMessages.push({
      role: isAssistantTurn ? 'assistant' : 'user',
      content: isAssistantTurn || !senderName || senderName === 'UNKNOWN'
        ? turnContent
        : `[from ${senderName}] ${turnContent}`,
    });
  }
  return conversationMessages;
}

function buildRequestTranscript(
  messages: readonly BackreadMessage[],
  identityContext: IdentityValidationContext,
  participantNames: readonly string[],
  onDiagnostic?: ConversationDiagnosticHandler,
): ConversationTurn[] | null {
  return selectRequestTurns(
    buildConversationTurns(messages, identityContext, participantNames, onDiagnostic),
  );
}

function selectRequestTurns(
  conversationMessages: readonly ConversationTurn[],
): ConversationTurn[] | null {
  let latestIncomingIndex = -1;
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (conversationMessages[index].role === 'user') {
      latestIncomingIndex = index;
      break;
    }
  }
  if (latestIncomingIndex === -1) {
    return null;
  }
  return limitAssistantHistory(
    conversationMessages.slice(0, latestIncomingIndex + 1),
  );
}

interface CompletionRequestOptions {
  apiKey: string;
  systemInstruction: string;
  messages: readonly ConversationTurn[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTokens: number;
  responseFormat?: unknown;
  networkMessage: string;
  pendingMessage: string;
  failureMessage: string;
  malformedMessage: string;
  emptyMessage: string;
}

async function requestNvidiaCompletion({
  apiKey,
  systemInstruction,
  messages,
  fetch: fetchImplementation,
  timeoutMs,
  maxTokens,
  responseFormat,
  networkMessage,
  pendingMessage,
  failureMessage,
  malformedMessage,
  emptyMessage,
}: CompletionRequestOptions): Promise<string> {
  let response: Response;
  try {
    response = await (fetchImplementation ?? fetch)(NVIDIA_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NVIDIA_CHAT_COMPLETIONS_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          ...messages,
        ],
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NvidiaRequestError(
      'network',
      networkMessage,
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
      `${pendingMessage} ${formatHttpFailure(failure!.status, failure!.body)} Try again later.`,
    );
  }
  if (response.status !== 200) {
    throw new NvidiaRequestError(
      'service',
      `${failureMessage} ${formatHttpFailure(failure!.status, failure!.body)}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NvidiaRequestError(
        'service',
        malformedMessage,
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
    throw new NvidiaRequestError('service', malformedMessage);
  }

  const content = (body as { choices: { message: { content: string } }[] })
    .choices[0].message.content.trim();
  if (!content) {
    throw new NvidiaRequestError('service', emptyMessage);
  }
  return content;
}

export async function generateNvidiaReply(
  apiKey: string,
  messages: readonly BackreadMessage[],
  options: NvidiaReplyRequestOptions,
): Promise<string> {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new NvidiaApiKeyError('authentication', 'The NVIDIA API key is empty or malformed.');
  }
  if (!options.systemInstruction.trim()) {
    throw new Error('A complete system instruction is required to generate a reply.');
  }
  if (!options.identity.name.trim()) {
    throw new Error('A configured bot identity is required to generate a reply.');
  }

  const roster = options.roster ? sanitizeGroupRoster(options.roster) : undefined;
  const participantNames = collectParticipantNames(messages, options.identity);
  const identityContext = createIdentityContext(
    options.identity,
    combineParticipantNames(
      options.identity,
      participantNames,
      collectRosterParticipantNames(roster),
    ),
  );
  const requestMessages = buildRequestTranscript(
    messages,
    identityContext,
    participantNames,
    options.onDiagnostic,
  );
  if (!requestMessages) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }

  const requestCompletion = (systemInstruction: string): Promise<string> =>
    requestNvidiaCompletion({
      apiKey,
      systemInstruction,
      messages: requestMessages,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxTokens: REPLY_MAX_TOKENS,
      networkMessage:
        'Unable to reach NVIDIA to generate a reply. Check the network connection and try again.',
      pendingMessage: 'NVIDIA accepted the reply request but left it pending.',
      failureMessage: 'NVIDIA could not generate a reply.',
      malformedMessage: 'NVIDIA returned an unexpected reply response.',
      emptyMessage: 'NVIDIA returned an empty reply.',
    });

  const systemInstruction = appendIdentityAwarenessInstruction(
    appendGroupRosterInstruction(options.systemInstruction.trim(), roster),
    {
      identity: options.identity,
      participantNames: combineParticipantNames(
        options.identity,
        participantNames,
        collectRosterParticipantNames(roster),
      ),
    },
  );
  const firstReply = await requestCompletion(systemInstruction);
  const firstLanguageValid = isEnglishOnlyReply(firstReply);
  const firstIdentityResult = validateReplyIdentity(firstReply, identityContext);
  if (firstLanguageValid && firstIdentityResult.valid) {
    return firstReply;
  }

  const retryInstructions: string[] = [];
  if (!firstLanguageValid) {
    retryInstructions.push(ENGLISH_ONLY_RETRY_INSTRUCTION);
  }
  if (!firstIdentityResult.valid) {
    retryInstructions.push(IDENTITY_RETRY_INSTRUCTION);
  }
  const retryReply = await requestCompletion(
    appendRetryInstruction(systemInstruction, ...retryInstructions),
  );
  const retryIdentityResult = validateReplyIdentity(retryReply, identityContext);
  if (!retryIdentityResult.valid) {
    throw new NvidiaIdentityError(
      retryIdentityResult.reason,
      'NVIDIA repeatedly returned a reply with an invalid identity. The reply was not sent.',
    );
  }
  if (!isEnglishOnlyReply(retryReply)) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a non-English reply. The reply was not sent.',
    );
  }
  return retryReply;
}
