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
  appendActiveTurnInstruction,
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
  INTERNAL_NARRATION_RETRY_INSTRUCTION,
  isInternalNarrationReply,
} from '../components/internal-narration.js';
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
import { appendTimeAwarenessInstruction } from '../components/time-awareness.js';
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
import {
  formatGenerationDiagnostic,
  type GenerationDiagnosticInput,
} from '../components/reply-diagnostics.js';
import {
  EXISTENCE_RETRY_INSTRUCTION,
  isExplicitFictionContext,
  validateReplyExistence,
  type ExistenceDiagnostic,
  type ExistenceDiagnosticHandler,
  type ExistenceTriggerContext,
  type ExistenceViolationReason,
} from '../components/existence-policy.js';

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

export class NvidiaExistenceError extends Error {
  constructor(
    readonly reason: ExistenceViolationReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NvidiaExistenceError';
  }
}

export interface ConversationDiagnostic {
  messageId: string | null;
  reason: IdentityViolationReason;
}

export type ConversationDiagnosticHandler = (diagnostic: ConversationDiagnostic) => void;

function sanitizePreview(text: string, limit = 80): string {
  const compact = extractConversationMessageBody(text).text.replace(/\s+/gu, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function logRequestDiagnostics(
  diagnostics: NvidiaRequestDiagnostics,
  turns: readonly ConversationTurn[],
  triggerInfo: ConversationTriggerInfo | null,
): void {
  const incoming = turns.filter(turn => !turn.isAssistant).length;
  const assistant = turns.length - incoming;
  const triggerPresent = triggerInfo?.messageId !== null &&
    triggerInfo?.messageId !== undefined &&
    turns.some(turn => turn.messageId === triggerInfo.messageId);
  console.log(
    `[request] packet=${diagnostics.packetId} type=${diagnostics.packetType} ` +
    `trigger=${triggerInfo?.messageId ?? 'none'} triggerInHistory=${String(triggerPresent)} ` +
    `turns=${String(turns.length)} incoming=${String(incoming)} assistant=${String(assistant)} ` +
    `restoredOutgoing=${diagnostics.restoredOutgoingMessageIds?.join(',') || 'none'} ` +
    `mergedPending=${diagnostics.mergedPendingMessageIds?.join(',') || 'none'}`,
  );
  for (const turn of turns) {
    console.log(
      `[request] role=${turn.role} id=${turn.messageId ?? 'unavailable'} ` +
      `preview=${JSON.stringify(sanitizePreview(turn.content))}`,
    );
  }
}

export interface NvidiaRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface NvidiaRequestDiagnostics {
  packetId: string;
  packetType: string;
  restoredOutgoingMessageIds?: readonly string[];
  mergedPendingMessageIds?: readonly string[];
}

export interface NvidiaReplyRequestOptions extends NvidiaRequestOptions {
  systemInstruction: string;
  identity: BotIdentity;
  roster?: GroupRoster;
  targeting?: MessageTargetingContext;
  trigger?: ConversationMessage | null;
  responseTarget?: ConversationMessage | null;
  requestDiagnostics?: NvidiaRequestDiagnostics;
  onDiagnostic?: ConversationDiagnosticHandler;
  onExistenceDiagnostic?: ExistenceDiagnosticHandler;
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
  replyBatchId?: string;
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
  replyBatchId?: string;
}

function limitAssistantHistory(
  turns: readonly ConversationTurn[],
): ConversationTurn[] {
  let assistantGroups = 0;
  const kept: ConversationTurn[] = [];
  const seenBatches = new Set<string>();
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === 'assistant') {
      const batchId = turn.replyBatchId;
      if (batchId !== undefined) {
        if (seenBatches.has(batchId)) {
          kept.push(turn);
          continue;
        }
        if (assistantGroups >= MAX_ASSISTANT_HISTORY_TURNS) {
          continue;
        }
        seenBatches.add(batchId);
        assistantGroups += 1;
      } else {
        if (assistantGroups >= MAX_ASSISTANT_HISTORY_TURNS) {
          continue;
        }
        assistantGroups += 1;
      }
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

function logExistenceDiagnostic(
  handler: ExistenceDiagnosticHandler | undefined,
  diagnostics: NvidiaRequestDiagnostics | undefined,
  diagnostic: ExistenceDiagnostic,
): void {
  handler?.(diagnostic);
  if (!diagnostics) {
    return;
  }
  const match = diagnostic.match
    ? ` match=${JSON.stringify(sanitizePreview(diagnostic.match, 60))}`
    : '';
  console.log(
    `[existence] packet=${diagnostics.packetId} type=${diagnostics.packetType} ` +
    `stage=${diagnostic.stage} reason=${diagnostic.reason} ` +
    `messageId=${diagnostic.messageId ?? 'unknown'} action=${diagnostic.action}${match}`,
  );
}

function prepareConversationMessages(
  messages: readonly ConversationMessage[],
  identityContext: IdentityValidationContext,
  participantNames: readonly string[],
  options: {
    fiction: boolean;
    onDiagnostic?: ConversationDiagnosticHandler;
    onExistenceDiagnostic?: ExistenceDiagnosticHandler;
    requestDiagnostics?: NvidiaRequestDiagnostics;
  } = { fiction: false },
): PreparedConversationMessage[] {
  const ownNames = identityComparableNames(identityContext);
  const prepared: PreparedConversationMessage[] = [];
  const seenMessageIds = new Set<string>();
  let lastIncomingText: string | null = null;
  for (let rawIndex = 0; rawIndex < messages.length; rawIndex += 1) {
    const raw = messages[rawIndex];
    const content = raw.message.trim();
    if (!content) {
      continue;
    }
    const direction = normalizeConversationDirection(raw.direction);
    if (direction === 'UNKNOWN') {
      continue;
    }
    const messageId = resolveConversationMessageId(raw);
    if (messageId !== null) {
      if (seenMessageIds.has(messageId)) {
        continue;
      }
      seenMessageIds.add(messageId);
    }
    const sender = normalizeConversationSender(raw.sender);
    const senderIsBot = sender !== 'UNKNOWN' &&
      ownNames.has(normalizeIdentityValue(sender));
    const isAssistant = direction === 'OUTGOING' ||
      (direction === 'INCOMING' && senderIsBot);
    const turnContent = isAssistant
      ? stripParticipantSpeakerLabel(content, participantNames)
      : content;
    if (isAssistant) {
      const existenceResult = validateReplyExistence(turnContent, {
        historical: true,
        trigger: lastIncomingText === null ? null : { text: lastIncomingText },
        fiction: options.fiction,
      });
      if (!existenceResult.valid) {
        logExistenceDiagnostic(
          options.onExistenceDiagnostic,
          options.requestDiagnostics,
          {
            messageId,
            reason: existenceResult.reason,
            stage: 'historical',
            action: 'withheld',
            match: existenceResult.match,
          },
        );
        continue;
      }
      const identityResult = validateReplyIdentity(
        turnContent,
        identityContext,
        { historical: true },
      );
      if (!identityResult.valid) {
        options.onDiagnostic?.({
          messageId,
          reason: identityResult.reason,
        });
        continue;
      }
    } else if (direction === 'INCOMING') {
      lastIncomingText = content;
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
      ...(typeof raw.replyBatchId === 'string' && raw.replyBatchId.trim()
        ? { replyBatchId: raw.replyBatchId }
        : {}),
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
  responseTargetTargeting: MessageTargetingContext | undefined,
  responseTarget: ConversationMessage | null,
): ConversationTurn[] {
  const responseTargetId = responseTarget
    ? resolveConversationMessageId(responseTarget)
    : null;
  const ownTargeting = targetingForTrigger(
    responseTargetTargeting,
    responseTargetId,
  );
  const conversationMessages: ConversationTurn[] = [];

  for (const message of prepared) {
    const isResponseTarget = message.raw === responseTarget ||
      (responseTargetId !== null && message.messageId === responseTargetId);
    const prefixAwareness = buildParticipantAwareness({
      bot: identity,
      roster,
      messages: messages.slice(0, message.rawIndex + 1),
    });
    const messageTargeting = isResponseTarget && ownTargeting
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
        isTrigger: isResponseTarget,
      }, message.content);
    conversationMessages.push({
      role: message.isAssistant ? 'assistant' : 'user',
      content,
      messageId: message.messageId,
      direction: message.direction,
      isAssistant: message.isAssistant,
      ...(message.replyBatchId === undefined
        ? {}
        : { replyBatchId: message.replyBatchId }),
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
  const explicitPacketTrigger = options.trigger ?? null;
  const packetTriggerId = explicitPacketTrigger
    ? resolveConversationMessageId(explicitPacketTrigger)
    : null;
  const packetTriggerFromHistory = packetTriggerId === null
    ? undefined
    : messages.find(message => resolveConversationMessageId(message) === packetTriggerId);
  const packetTrigger = packetTriggerFromHistory ?? explicitPacketTrigger;

  const explicitResponseTarget = options.responseTarget ?? null;
  const explicitResponseTargetId = explicitResponseTarget
    ? resolveConversationMessageId(explicitResponseTarget)
    : null;
  const responseTargetFromHistory = explicitResponseTargetId === null
    ? undefined
    : messages.find(
      message => resolveConversationMessageId(message) === explicitResponseTargetId,
    );
  const responseTargetCandidate =
    responseTargetFromHistory ?? explicitResponseTarget;

  const awarenessMessages = [
    ...messages,
    ...(packetTrigger && !messages.includes(packetTrigger) ? [packetTrigger] : []),
    ...(responseTargetCandidate && !messages.includes(responseTargetCandidate) &&
        responseTargetCandidate !== packetTrigger
      ? [responseTargetCandidate]
      : []),
  ];
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
  const existenceFiction = isExplicitFictionContext(
    messages
      .filter(message => normalizeConversationDirection(message.direction) === 'INCOMING')
      .slice(-6)
      .map(message => message.message),
  );
  const prepared = prepareConversationMessages(
    messages,
    identityContext,
    participantNames,
    {
      fiction: existenceFiction,
      onDiagnostic: options.onDiagnostic,
      onExistenceDiagnostic: options.onExistenceDiagnostic,
      requestDiagnostics: options.requestDiagnostics,
    },
  );
  if (!prepared.some(message => message.direction === 'INCOMING')) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }
  const latestIncoming = [...prepared]
    .reverse()
    .find(message => message.direction === 'INCOMING');
  const resolvedResponseTarget =
    responseTargetCandidate ?? packetTrigger ?? latestIncoming?.raw ?? null;
  const resolvedResponseTargetId = resolvedResponseTarget
    ? resolveConversationMessageId(resolvedResponseTarget)
    : null;
  const existenceTrigger: ExistenceTriggerContext | null = resolvedResponseTarget
    ? {
      messageId: resolvedResponseTargetId,
      text: resolvedResponseTarget.message,
      sender: normalizeConversationSender(resolvedResponseTarget.sender),
    }
    : null;
  const resolvedPacketTrigger = packetTrigger ?? resolvedResponseTarget;
  const resolvedPacketTriggerId = resolvedPacketTrigger
    ? resolveConversationMessageId(resolvedPacketTrigger)
    : null;
  const logGeneration = (
    diagnostic: Omit<
      GenerationDiagnosticInput,
      'packetId' | 'packetType' | 'triggerId' | 'targetId'
    >,
  ): void => {
    if (!options.requestDiagnostics) {
      return;
    }
    console.log(formatGenerationDiagnostic({
      ...diagnostic,
      packetId: options.requestDiagnostics.packetId,
      packetType: options.requestDiagnostics.packetType,
      triggerId: resolvedPacketTriggerId,
      targetId: resolvedResponseTargetId,
    }));
  };

  const responseTargetIndex = resolvedResponseTargetId === null
    ? -1
    : messages.findIndex(
      message => resolveConversationMessageId(message) === resolvedResponseTargetId,
    );
  const responseTargetPrefixMessages = responseTargetIndex === -1
    ? []
    : messages.slice(0, responseTargetIndex);
  const responseTargetAwareness = buildParticipantAwareness({
    bot: options.identity,
    roster,
    messages: resolvedResponseTarget
      ? [...responseTargetPrefixMessages, resolvedResponseTarget]
      : responseTargetPrefixMessages,
  });
  const responseTargetTargeting = targetingForTrigger(
    options.targeting,
    resolvedResponseTargetId,
  ) ?? (resolvedResponseTarget
    ? classifyMessageTargeting({
      message: resolvedResponseTarget,
      awareness: responseTargetAwareness,
      recentMessages: responseTargetPrefixMessages,
    })
    : null);

  const packetTriggerIndex = resolvedPacketTriggerId === null
    ? -1
    : messages.findIndex(
      message => resolveConversationMessageId(message) === resolvedPacketTriggerId,
    );
  const packetTriggerPrefixMessages = packetTriggerIndex === -1
    ? []
    : messages.slice(0, packetTriggerIndex);
  const packetTriggerAwareness = buildParticipantAwareness({
    bot: options.identity,
    roster,
    messages: resolvedPacketTrigger
      ? [...packetTriggerPrefixMessages, resolvedPacketTrigger]
      : packetTriggerPrefixMessages,
  });
  const packetTriggerTargeting = targetingForTrigger(
    options.targeting,
    resolvedPacketTriggerId,
  ) ?? (resolvedPacketTrigger
    ? classifyMessageTargeting({
      message: resolvedPacketTrigger,
      awareness: packetTriggerAwareness,
      recentMessages: packetTriggerPrefixMessages,
    })
    : null);

  const triggerSender = resolvedResponseTarget
    ? normalizeConversationSender(resolvedResponseTarget.sender)
    : 'UNKNOWN';
  const triggerDirection = resolvedResponseTarget
    ? normalizeConversationDirection(resolvedResponseTarget.direction)
    : 'UNKNOWN';
  const triggerIsBot = triggerSender !== 'UNKNOWN' &&
    identityComparableNames(identityContext).has(
      normalizeIdentityValue(triggerSender),
    );
  const triggerInfo: ConversationTriggerInfo | null = resolvedResponseTarget
    ? {
      messageId: resolvedResponseTargetId,
      timestamp: resolvedResponseTarget.timestamp ?? null,
      sender: triggerSender,
      participant: participantLabel(
        triggerSender,
        triggerIsBot || triggerDirection === 'OUTGOING',
        responseTargetAwareness,
        options.identity,
      ),
      direction: triggerDirection,
      addressedTo: responseTargetTargeting?.addressedTo ?? null,
      targetKind: responseTargetTargeting?.kind ?? null,
      text: resolvedResponseTarget.message.trim(),
      presentInHistory: false,
      packetTriggerMessageId: resolvedPacketTriggerId,
      newestIncomingMessageId: latestIncoming
        ? resolveConversationMessageId(latestIncoming.raw)
        : null,
    }
    : null;
  const requestMessages = selectRequestTurns(
    buildConversationTurns(
      messages,
      prepared,
      participantAwareness,
      roster,
      options.identity,
      responseTargetTargeting ?? undefined,
      resolvedResponseTarget,
    ),
  );
  if (!requestMessages) {
    throw new Error('No usable Messenger messages are available to generate a reply.');
  }
  if (triggerInfo) {
    triggerInfo.presentInHistory = triggerInfo.messageId !== null &&
      requestMessages.some(message => message.messageId === triggerInfo.messageId);
  }
  if (options.requestDiagnostics) {
    logRequestDiagnostics(options.requestDiagnostics, requestMessages, triggerInfo);
  }

  const requestCompletion = (
    systemInstruction: string,
    retryInstructions: readonly string[] = [],
  ): Promise<string> =>
    requestNvidiaCompletion({
      apiKey,
      systemInstruction: appendRetryInstruction(
        appendTimeAwarenessInstruction(systemInstruction),
        ...retryInstructions,
      ),
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
          ? appendActiveTurnInstruction(awarenessInstruction, triggerInfo)
          : awarenessInstruction,
        packetTriggerTargeting ?? responseTargetTargeting ?? undefined,
      ),
    ),
  );
  const firstReply = await requestCompletion(systemInstruction);
  logGeneration({ stage: 'raw', attempt: 'first', text: firstReply });
  const firstLanguageValid = isEnglishOnlyReply(firstReply);
  const firstEmojiFree = !containsEmoji(firstReply);
  const firstMetadataFree = !extractConversationMessageBody(firstReply).hadEnvelope;
  const firstInternalNarration = firstMetadataFree &&
    isInternalNarrationReply(firstReply);
  const firstIdentityResult = validateReplyIdentity(firstReply, identityContext);
  const firstExistenceResult = validateReplyExistence(firstReply, {
    trigger: existenceTrigger,
    fiction: existenceFiction,
  });
  const firstReasons: string[] = [];
  if (!firstLanguageValid) {
    firstReasons.push('language:non-english');
  }
  if (!firstEmojiFree) {
    firstReasons.push('emoji');
  }
  if (!firstMetadataFree) {
    firstReasons.push('metadata');
  }
  if (firstInternalNarration) {
    firstReasons.push('internal-narration');
  }
  if (!firstIdentityResult.valid) {
    firstReasons.push(`identity:${firstIdentityResult.reason}`);
  }
  if (!firstExistenceResult.valid) {
    firstReasons.push(`existence:${firstExistenceResult.reason}`);
  }
  logGeneration({
    stage: 'validation',
    attempt: 'first',
    text: firstReply,
    outcome: firstReasons.length === 0 ? 'accepted' : 'retry',
    reason: firstReasons.join(','),
  });
  if (!firstExistenceResult.valid) {
    logExistenceDiagnostic(
      options.onExistenceDiagnostic,
      options.requestDiagnostics,
      {
        messageId: resolvedResponseTargetId,
        reason: firstExistenceResult.reason,
        stage: 'first-draft',
        action: 'retry',
        match: firstExistenceResult.match,
      },
    );
  }
  if (firstLanguageValid && firstEmojiFree && firstMetadataFree &&
      !firstInternalNarration && firstIdentityResult.valid &&
      firstExistenceResult.valid) {
    logGeneration({
      stage: 'accepted',
      attempt: 'first',
      text: firstReply,
      outcome: 'accepted',
      reason: 'none',
    });
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
  if (firstInternalNarration) {
    retryInstructions.push(INTERNAL_NARRATION_RETRY_INSTRUCTION);
  }
  if (!firstIdentityResult.valid) {
    retryInstructions.push(IDENTITY_RETRY_INSTRUCTION);
  }
  if (!firstExistenceResult.valid) {
    retryInstructions.push(EXISTENCE_RETRY_INSTRUCTION);
  }
  const retryReply = await requestCompletion(systemInstruction, retryInstructions);
  logGeneration({ stage: 'raw', attempt: 'retry', text: retryReply });
  const retryExistenceResult = validateReplyExistence(retryReply, {
    trigger: existenceTrigger,
    fiction: existenceFiction,
  });
  const retryIdentityResult = validateReplyIdentity(retryReply, identityContext);
  const retryLanguageValid = isEnglishOnlyReply(retryReply);
  const retryEmojiFree = !containsEmoji(retryReply);
  const retryMetadataFree = !extractConversationMessageBody(retryReply).hadEnvelope;
  const retryInternalNarration = retryMetadataFree &&
    isInternalNarrationReply(retryReply);
  const retryReasons: string[] = [];
  if (!retryExistenceResult.valid) {
    retryReasons.push(`existence:${retryExistenceResult.reason}`);
  }
  if (!retryIdentityResult.valid) {
    retryReasons.push(`identity:${retryIdentityResult.reason}`);
  }
  if (!retryLanguageValid) {
    retryReasons.push('language:non-english');
  }
  if (!retryEmojiFree) {
    retryReasons.push('emoji');
  }
  if (!retryMetadataFree) {
    retryReasons.push('metadata');
  }
  if (retryInternalNarration) {
    retryReasons.push('internal-narration');
  }
  logGeneration({
    stage: 'validation',
    attempt: 'retry',
    text: retryReply,
    outcome: retryReasons.length === 0 ? 'accepted' : 'suppressed',
    reason: retryReasons.join(','),
  });
  if (!retryExistenceResult.valid) {
    logExistenceDiagnostic(
      options.onExistenceDiagnostic,
      options.requestDiagnostics,
      {
        messageId: resolvedResponseTargetId,
        reason: retryExistenceResult.reason,
        stage: 'retry',
        action: 'suppressed',
        match: retryExistenceResult.match,
      },
    );
    throw new NvidiaExistenceError(
      retryExistenceResult.reason,
      'NVIDIA repeatedly returned a reply that claimed or accepted physical-world participation. The reply was not sent.',
    );
  }
  if (!firstExistenceResult.valid) {
    logExistenceDiagnostic(
      options.onExistenceDiagnostic,
      options.requestDiagnostics,
      {
        messageId: resolvedResponseTargetId,
        reason: firstExistenceResult.reason,
        stage: 'retry',
        action: 'accepted',
      },
    );
  }
  if (!retryIdentityResult.valid) {
    throw new NvidiaIdentityError(
      retryIdentityResult.reason,
      'NVIDIA repeatedly returned a reply with an invalid identity. The reply was not sent.',
    );
  }
  if (!retryLanguageValid) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a non-English reply. The reply was not sent.',
    );
  }
  if (!retryEmojiFree) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a reply containing an emoji. The reply was not sent.',
    );
  }
  if (!retryMetadataFree) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a reply containing conversation metadata. The reply was not sent.',
    );
  }
  if (retryInternalNarration) {
    throw new NvidiaRequestError(
      'service',
      'NVIDIA repeatedly returned a reply that discussed internal generation details. The reply was not sent.',
    );
  }
  logGeneration({
    stage: 'accepted',
    attempt: 'retry',
    text: retryReply,
    outcome: 'accepted',
    reason: 'none',
  });
  return retryReply;
}
