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
import {
  CONVERSATION_METADATA_RETRY_INSTRUCTION,
  appendCurrentTriggerInstruction,
  extractConversationMessageBody,
  normalizeConversationDirection,
  normalizeConversationSender,
  resolveConversationMessageId,
  serializeConversationMessage,
  targetingForTrigger,
  type ConversationDirection,
  type ConversationMessage,
  type ConversationTriggerInfo,
} from '../components/conversation-context.js';
import {
  ENGLISH_ONLY_RETRY_INSTRUCTION,
  isEnglishOnlyReply,
} from '../components/english-only.js';
import {
  EMOJI_RETRY_INSTRUCTION,
  containsEmoji,
} from '../components/emoji.js';
import {
  IDENTITY_RETRY_INSTRUCTION,
  validateReplyIdentity,
  type IdentityValidationContext,
  type IdentityViolationReason,
} from '../components/identity-policy.js';
import {
  appendConversationalInitiativeInstruction,
  appendGroupRosterInstruction,
  appendMemoryHonestyInstruction,
  appendRetryInstruction,
  type BotIdentity,
} from '../components/personality.js';
import { sanitizeGroupRoster, type GroupRoster } from '../browser/group-roster.js';
import { appendIdentityAwarenessInstruction } from '../components/identity-awareness.js';
import {
  appendMessageTargetingInstruction,
  classifyMessageTargeting,
  type MessageTargetingContext,
} from '../components/message-targeting.js';
import {
  buildParticipantAwareness,
  findParticipantIdentity,
  normalizeParticipantName,
  type ParticipantAwareness,
} from '../components/participant-awareness.js';
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
  targeting?: MessageTargetingContext;
  trigger?: ConversationMessage | null;
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
  messageId: string | null;
  direction: ConversationDirection;
  isAssistant: boolean;
}

interface PreparedConversationMessage {
  rawIndex: number;
  raw: ConversationMessage;
  messageId: string | null;
  timestamp: ConversationMessage['timestamp'];
  sender: string;
  direction: ConversationDirection;
  content: string;
  isAssistant: boolean;
  isBotAuthored: boolean;
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

function prepareConversationMessages(
  messages: readonly ConversationMessage[],
  identityContext: IdentityValidationContext,
  participantNames: readonly string[],
  onDiagnostic?: ConversationDiagnosticHandler,
): PreparedConversationMessage[] {
  const ownNames = identityComparableNames(identityContext);
  const prepared: PreparedConversationMessage[] = [];
  for (let rawIndex = 0; rawIndex < messages.length; rawIndex += 1) {
    const raw = messages[rawIndex];
    const content = raw.message.trim();
    if (!content) {
      continue;
    }
    const messageId = resolveConversationMessageId(raw);
    const direction = normalizeConversationDirection(raw.direction);
    const sender = normalizeConversationSender(raw.sender);
    const senderIsBot = sender !== 'UNKNOWN' &&
      ownNames.has(normalizeIdentityValue(sender));
    const isAssistant = direction === 'OUTGOING' ||
      (direction === 'INCOMING' && senderIsBot);
    const turnContent = isAssistant
      ? stripParticipantSpeakerLabel(content, participantNames)
      : content;
    if (isAssistant) {
      const identityResult = validateReplyIdentity(
        turnContent,
        identityContext,
        { historical: true },
      );
      if (!identityResult.valid) {
        onDiagnostic?.({
          messageId,
          reason: identityResult.reason,
        });
        continue;
      }
    }
    prepared.push({
      rawIndex,
      raw,
      messageId,
      timestamp: raw.timestamp ?? null,
      sender,
      direction,
      content: turnContent,
      isAssistant,
      isBotAuthored: isAssistant,
    });
  }
  return prepared;
}

function participantLabel(
  sender: string,
  isBotAuthored: boolean,
  awareness: ParticipantAwareness,
  identity: BotIdentity,
): string {
  if (isBotAuthored) {
    return identity.name.trim() || 'unknown';
  }
  if (sender === 'UNKNOWN') {
    return 'unknown';
  }
  const participant = findParticipantIdentity(awareness, sender);
  if (!participant) {
    return normalizeParticipantName(sender) || 'unknown';
  }
  return participant.ambiguous
    ? `ambiguous: ${participant.canonicalName}`
    : participant.canonicalName;
}

function buildConversationTurns(
  messages: readonly ConversationMessage[],
  prepared: readonly PreparedConversationMessage[],
  participantAwareness: ParticipantAwareness,
  roster: GroupRoster | undefined,
  identity: BotIdentity,
  targeting: MessageTargetingContext | undefined,
  trigger: ConversationMessage | null,
): ConversationTurn[] {
  const triggerId = trigger ? resolveConversationMessageId(trigger) : null;
  const ownTargeting = targetingForTrigger(targeting, triggerId);
  const conversationMessages: ConversationTurn[] = [];

  for (const message of prepared) {
    const isTrigger = message.raw === trigger ||
      (triggerId !== null && message.messageId === triggerId);
    const prefixAwareness = buildParticipantAwareness({
      bot: identity,
      roster,
      messages: messages.slice(0, message.rawIndex + 1),
    });
    const messageTargeting = isTrigger && ownTargeting
      ? ownTargeting
      : message.isAssistant
        ? null
        : classifyMessageTargeting({
          message: message.raw,
          awareness: prefixAwareness,
          recentMessages: prepared
            .filter(candidate => candidate.rawIndex < message.rawIndex)
            .map(candidate => candidate.raw),
        });
    const content = message.isAssistant
      ? message.content
      : serializeConversationMessage({
        id: message.messageId,
        timestamp: message.timestamp ?? null,
        sender: message.sender,
        participant: participantLabel(
          message.sender,
          message.isBotAuthored,
          participantAwareness,
          identity,
        ),
        direction: message.direction,
        addressedTo: messageTargeting?.addressedTo ?? null,
        isTrigger,
      }, message.content);
    conversationMessages.push({
      role: message.isAssistant ? 'assistant' : 'user',
      content,
      messageId: message.messageId,
      direction: message.direction,
      isAssistant: message.isAssistant,
    });
  }
  return conversationMessages;
}

function selectRequestTurns(
  conversationMessages: readonly ConversationTurn[],
): ConversationTurn[] | null {
  let latestUserIndex = -1;
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (!conversationMessages[index].isAssistant) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) {
    return null;
  }
  return limitAssistantHistory(
    conversationMessages.slice(0, latestUserIndex + 1),
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
          ...messages.map(message => ({
            role: message.role,
            content: message.content,
          })),
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
  messages: readonly ConversationMessage[],
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
  const explicitTrigger = options.trigger ?? null;
  const triggerId = explicitTrigger
    ? resolveConversationMessageId(explicitTrigger)
    : null;
  const triggerFromHistory = triggerId === null
    ? undefined
    : messages.find(message => resolveConversationMessageId(message) === triggerId);
  const trigger = triggerFromHistory ?? explicitTrigger;
  const awarenessMessages = trigger && !messages.includes(trigger)
    ? [...messages, trigger]
    : messages;
  const participantAwareness = buildParticipantAwareness({
    bot: options.identity,
    roster,
    messages: awarenessMessages,
  });
  const participantNames = participantAwareness.participantNames;
  const identityContext = createIdentityContext(
    options.identity,
    participantNames,
  );
  const prepared = prepareConversationMessages(
    messages,
    identityContext,
    participantNames,
    options.onDiagnostic,
  );
  if (!prepared.some(message => message.direction === 'INCOMING')) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }
  const latestIncoming = [...prepared]
    .reverse()
    .find(message => message.direction === 'INCOMING');
  const resolvedTrigger = trigger ?? latestIncoming?.raw ?? null;
  const resolvedTriggerId = resolvedTrigger
    ? resolveConversationMessageId(resolvedTrigger)
    : null;
  const preparedTrigger = resolvedTriggerId === null
    ? undefined
    : prepared.find(message => message.messageId === resolvedTriggerId);
  const triggerPrefixMessages = preparedTrigger
    ? messages.slice(0, preparedTrigger.rawIndex)
    : [];
  const triggerAwareness = buildParticipantAwareness({
    bot: options.identity,
    roster,
    messages: resolvedTrigger
      ? [...triggerPrefixMessages, resolvedTrigger]
      : triggerPrefixMessages,
  });
  const triggerTargeting = targetingForTrigger(
    options.targeting,
    resolvedTriggerId,
  ) ?? (resolvedTrigger
    ? classifyMessageTargeting({
      message: resolvedTrigger,
      awareness: triggerAwareness,
      recentMessages: triggerPrefixMessages,
    })
    : null);
  const triggerSender = resolvedTrigger
    ? normalizeConversationSender(resolvedTrigger.sender)
    : 'UNKNOWN';
  const triggerDirection = resolvedTrigger
    ? normalizeConversationDirection(resolvedTrigger.direction)
    : 'UNKNOWN';
  const triggerIsBot = triggerSender !== 'UNKNOWN' &&
    identityComparableNames(identityContext).has(
      normalizeIdentityValue(triggerSender),
    );
  const triggerInfo: ConversationTriggerInfo | null = resolvedTrigger
    ? {
      messageId: resolvedTriggerId,
      timestamp: resolvedTrigger.timestamp ?? null,
      sender: triggerSender,
      participant: participantLabel(
        triggerSender,
        triggerIsBot || triggerDirection === 'OUTGOING',
        triggerAwareness,
        options.identity,
      ),
      direction: triggerDirection,
      addressedTo: triggerTargeting?.addressedTo ?? null,
      targetKind: triggerTargeting?.kind ?? null,
      text: resolvedTrigger.message.trim(),
      presentInHistory: false,
    }
    : null;
  const requestMessages = selectRequestTurns(
    buildConversationTurns(
      messages,
      prepared,
      participantAwareness,
      roster,
      options.identity,
      triggerTargeting ?? undefined,
      resolvedTrigger,
    ),
  );
  if (!requestMessages) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }
  if (triggerInfo) {
    triggerInfo.presentInHistory = triggerInfo.messageId !== null &&
      requestMessages.some(message => message.messageId === triggerInfo.messageId);
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

  const awarenessInstruction = appendIdentityAwarenessInstruction(
    appendGroupRosterInstruction(options.systemInstruction.trim(), roster),
    {
      identity: options.identity,
      participantNames: participantAwareness.canonicalNames,
    },
  );
  const systemInstruction = appendConversationalInitiativeInstruction(
    appendMemoryHonestyInstruction(
      appendMessageTargetingInstruction(
        triggerInfo
          ? appendCurrentTriggerInstruction(awarenessInstruction, triggerInfo)
          : awarenessInstruction,
        triggerTargeting ?? undefined,
      ),
    ),
  );
  const firstReply = await requestCompletion(systemInstruction);
  const firstLanguageValid = isEnglishOnlyReply(firstReply);
  const firstEmojiFree = !containsEmoji(firstReply);
  const firstMetadataFree = !extractConversationMessageBody(firstReply).hadEnvelope;
  const firstIdentityResult = validateReplyIdentity(firstReply, identityContext);
  if (firstLanguageValid && firstEmojiFree && firstMetadataFree &&
      firstIdentityResult.valid) {
    return firstReply;
  }

  const retryInstructions: string[] = [];
  if (!firstLanguageValid) {
    retryInstructions.push(ENGLISH_ONLY_RETRY_INSTRUCTION);
  }
  if (!firstEmojiFree) {
    retryInstructions.push(EMOJI_RETRY_INSTRUCTION);
  }
  if (!firstMetadataFree) {
    retryInstructions.push(CONVERSATION_METADATA_RETRY_INSTRUCTION);
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
  if (containsEmoji(retryReply)) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a reply containing an emoji. The reply was not sent.',
    );
  }
  if (extractConversationMessageBody(retryReply).hadEnvelope) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a reply containing conversation metadata. The reply was not sent.',
    );
  }
  return retryReply;
}
