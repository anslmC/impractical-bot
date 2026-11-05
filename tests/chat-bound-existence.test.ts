import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateNvidiaReply } from '../src/ai/nvidia.js';
import {
  CHAT_BOUND_EXISTENCE_INSTRUCTION,
  composeProductionSystemInstruction,
  getConversationPolicyInstruction,
} from '../src/components/personality.js';

const testIdentity = { name: 'TestBot', aliases: ['@TestBot'] };

function productionPrompt(
  personalityMode: 'default' | 'custom' = 'default',
  customPersonalityInstruction?: string,
): string {
  return composeProductionSystemInstruction({
    identity: testIdentity,
    personalityMode,
    customPersonalityInstruction,
  });
}

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

function incomingMessage(message: string) {
  return {
    id: 'incoming-1',
    timestamp: { original: null, normalized: null, resolved: false },
    sender: 'Alex',
    direction: 'INCOMING' as const,
    message,
    ariaLabel: null,
  };
}

async function captureSystemInstruction(
  message: string,
  personalityMode: 'default' | 'custom' = 'default',
  customPersonalityInstruction?: string,
): Promise<string> {
  let systemContent = '';
  await generateNvidiaReply(
    'nvapi-test-key',
    [incomingMessage(message)],
    {
      systemInstruction: productionPrompt(personalityMode, customPersonalityInstruction),
      identity: testIdentity,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        systemContent = body.messages[0]?.content ?? '';
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Good luck out there.' } }],
        }), { status: 200 });
      },
    },
  );
  return systemContent;
}

const physicalScenarios = [
  'Come over to my place.',
  "Let's go outside.",
  'Are you heading out?',
  'Where were you last night?',
  'What time will you arrive?',
  "I'll meet you there.",
  "Come over, lol, I'm just teasing.",
];

test('the policy establishes an absolute boundary for ordinary conversation', () => {
  const policy = getConversationPolicyInstruction();
  const prompt = productionPrompt();

  for (const instruction of [policy, prompt]) {
    assert.match(instruction, /You exist exclusively within this group conversation/);
    assert.match(
      instruction,
      /no physical body, no external location, no home, no offline routine, and no personal whereabouts/,
    );
    assert.match(instruction, /no ability to perform physical-world actions/);
    assert.match(
      instruction,
      /cannot travel, leave, arrive, visit someone, meet someone in person, accompany someone, attend an event, or arrange a physical-world appointment/,
    );
    assert.match(
      instruction,
      /must never claim to be doing, planning, or having done any of those things/,
    );
    assert.match(
      instruction,
      /discuss real-world plans and places, react to invitations, joke, tease, and participate socially/,
    );
    assert.match(
      instruction,
      /without claiming that you personally will be or have been physically present/,
    );
  }
});

test('ordinary invitations, jokes, teasing, and hypotheticals do not establish roleplay', () => {
  const policy = getConversationPolicyInstruction();

  assert.match(
    policy,
    /Ordinary invitations, jokes, teasing, hypotheticals, and casual social exchanges do not establish roleplay/,
  );
  assert.match(policy, /or make physical actions real/);
  assert.match(
    policy,
    /Do not treat ordinary conversation as fiction merely because someone invites you somewhere/,
  );
});

test('figurative movement language never authorizes a physical-world claim', () => {
  const policy = getConversationPolicyInstruction();

  assert.match(
    policy,
    /Figurative language may be used only when it is unmistakably non-literal/,
  );
  assert.match(
    policy,
    /phrases such as "I'm coming" or "I'll go" never justify a claim/,
  );
  assert.match(
    policy,
    /on the way, arriving, waiting somewhere, or meeting someone outside this chat/,
  );
  assert.doesNotMatch(policy, /Figurative language such as .* is fine/);
});

test('explicit fiction remains possible without redefining actual existence', () => {
  const policy = getConversationPolicyInstruction();

  assert.match(
    policy,
    /Explicitly established fictional scenarios, storytelling, and roleplay may include physical actions only within that fiction/,
  );
  assert.match(
    policy,
    /must never redefine your actual existence, location, history, or capabilities/,
  );
  assert.match(
    policy,
    /do not interrupt legitimate fiction with repeated existence disclaimers/,
  );
  assert.doesNotMatch(
    policy,
    /Clearly fictional, hypothetical, quoted, and roleplay scenarios/,
  );
});

test('the policy preserves natural in-character responses to invitations', () => {
  const policy = getConversationPolicyInstruction();

  assert.match(policy, /respond naturally and in character within the chat/);
  assert.match(policy, /a refusal, joke, tease, or dry remark can be a complete answer/);
  assert.match(policy, /do not need to explain that you are an AI/);
  assert.doesNotMatch(policy, /I could just walk out of this chat, idiot/);
});

test('the chat-bound section is its own paragraph before the personality policy', () => {
  const policy = getConversationPolicyInstruction();

  assert.ok(policy.startsWith(CHAT_BOUND_EXISTENCE_INSTRUCTION));
  assert.ok(policy.includes(`${CHAT_BOUND_EXISTENCE_INSTRUCTION}\n\n`));
  assert.ok(
    policy.indexOf(CHAT_BOUND_EXISTENCE_INSTRUCTION) <
      policy.indexOf('Your configured personality is the primary source of your voice'),
  );
});

test('default and custom prompts each include the policy once and keep their voice', () => {
  const custom = 'Deadpan, observant, and quietly mischievous.';
  const defaultComposed = productionPrompt();
  const customComposed = productionPrompt('custom', custom);

  for (const composed of [defaultComposed, customComposed]) {
    assert.equal(
      occurrences(composed, CHAT_BOUND_EXISTENCE_INSTRUCTION),
      1,
      'the chat-bound policy appears exactly once',
    );
  }
  assert.match(defaultComposed, /You're a laid-back, witty friend/);
  assert.match(customComposed, /Deadpan, observant, and quietly mischievous\./);
  assert.ok(
    customComposed.indexOf(CHAT_BOUND_EXISTENCE_INSTRUCTION) <
      customComposed.indexOf(custom),
    'the chat-bound policy precedes the custom personality voice',
  );
  assert.equal(occurrences(customComposed, custom), 1);
});

test('actual generation requests carry the policy for ordinary physical scenarios', async () => {
  const custom = 'Warm, playful, and fond of teasing.';
  const cases: Array<{ mode: 'default' | 'custom'; custom?: string }> = [
    { mode: 'default' },
    { mode: 'custom', custom },
  ];

  for (const { mode, custom: customInstruction } of cases) {
    for (const message of physicalScenarios) {
      const systemContent = await captureSystemInstruction(
        message,
        mode,
        customInstruction,
      );

      assert.equal(
        occurrences(systemContent, CHAT_BOUND_EXISTENCE_INSTRUCTION),
        1,
        'the live request contains the policy exactly once',
      );
      assert.match(systemContent, /You exist exclusively within this group conversation/);
      assert.match(systemContent, /Ordinary invitations, jokes, teasing, hypotheticals/);
      if (customInstruction) {
        assert.ok(systemContent.includes(customInstruction));
      }
    }
  }
});
