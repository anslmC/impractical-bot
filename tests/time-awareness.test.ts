import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateNvidiaReply } from '../src/ai/nvidia.js';
import {
  composeProductionSystemInstruction,
  getDefaultPersonalityInstruction,
} from '../src/components/personality.js';
import {
  TIME_AWARENESS_INSTRUCTION_MARKER,
  appendTimeAwarenessInstruction,
  buildTimeContext,
  classifyDayPeriod,
  type DayPeriod,
} from '../src/components/time-awareness.js';

function successfulCompletion(content = 'Hi.'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200 });
}

function messengerMessage(id: string, sender: string, message: string) {
  return {
    id,
    timestamp: { original: null, normalized: null, resolved: false },
    sender,
    direction: 'INCOMING' as const,
    message,
    ariaLabel: null,
  };
}

test('classifies morning, afternoon, evening, and late night', () => {
  const cases: Array<[string, DayPeriod]> = [
    ['2026-11-05T06:00:00.000Z', 'Morning'],
    ['2026-11-05T12:45:00.000Z', 'Afternoon'],
    ['2026-11-05T18:30:00.000Z', 'Evening'],
    ['2026-11-05T23:30:00.000Z', 'Late night'],
    ['2026-11-06T02:00:00.000Z', 'Late night'],
  ];

  for (const [isoTimestamp, expected] of cases) {
    assert.equal(
      buildTimeContext({ now: new Date(isoTimestamp), timeZone: 'UTC' }).dayPeriod,
      expected,
    );
  }

  assert.equal(classifyDayPeriod(4), 'Late night');
  assert.equal(classifyDayPeriod(5), 'Morning');
  assert.equal(classifyDayPeriod(11), 'Morning');
  assert.equal(classifyDayPeriod(12), 'Afternoon');
  assert.equal(classifyDayPeriod(16), 'Afternoon');
  assert.equal(classifyDayPeriod(17), 'Evening');
  assert.equal(classifyDayPeriod(21), 'Evening');
  assert.equal(classifyDayPeriod(22), 'Late night');
});

test('formats the local date, weekday, time, timezone, offset, and ISO timestamp', () => {
  const context = buildTimeContext({
    now: new Date('2026-11-05T04:45:00.000Z'),
    timeZone: 'Asia/Singapore',
  });

  assert.equal(context.date, 'Thursday, November 5, 2026');
  assert.equal(context.weekday, 'Thursday');
  assert.equal(context.localTime, '12:45 PM');
  assert.equal(context.dayPeriod, 'Afternoon');
  assert.equal(context.timeZone, 'Asia/Singapore');
  assert.equal(context.utcOffset, '+08:00');
  assert.equal(context.isoTimestamp, '2026-11-05T04:45:00.000Z');
});

test('handles midnight rollover and timezone date transitions', () => {
  const beforeMidnight = buildTimeContext({
    now: new Date('2026-11-05T23:59:59.000Z'),
    timeZone: 'UTC',
  });
  assert.equal(beforeMidnight.date, 'Thursday, November 5, 2026');
  assert.equal(beforeMidnight.weekday, 'Thursday');
  assert.equal(beforeMidnight.localTime, '11:59 PM');
  assert.equal(beforeMidnight.dayPeriod, 'Late night');

  const afterMidnight = buildTimeContext({
    now: new Date('2026-11-06T00:00:00.000Z'),
    timeZone: 'UTC',
  });
  assert.equal(afterMidnight.date, 'Friday, November 6, 2026');
  assert.equal(afterMidnight.weekday, 'Friday');
  assert.equal(afterMidnight.localTime, '12:00 AM');
  assert.equal(afterMidnight.dayPeriod, 'Late night');

  const singaporeMidnight = buildTimeContext({
    now: new Date('2026-11-05T16:30:00.000Z'),
    timeZone: 'Asia/Singapore',
  });
  assert.equal(singaporeMidnight.date, 'Friday, November 6, 2026');
  assert.equal(singaporeMidnight.weekday, 'Friday');
  assert.equal(singaporeMidnight.localTime, '12:30 AM');
});

test('handles date and weekday transitions across a year boundary', () => {
  const newYearsEve = buildTimeContext({
    now: new Date('2026-12-31T23:30:00.000Z'),
    timeZone: 'UTC',
  });
  assert.equal(newYearsEve.date, 'Thursday, December 31, 2026');
  assert.equal(newYearsEve.weekday, 'Thursday');

  const newYearsDay = buildTimeContext({
    now: new Date('2027-01-01T00:30:00.000Z'),
    timeZone: 'UTC',
  });
  assert.equal(newYearsDay.date, 'Friday, January 1, 2027');
  assert.equal(newYearsDay.weekday, 'Friday');
  assert.equal(newYearsDay.localTime, '12:30 AM');
});

test('formats timezone names and UTC offsets', () => {
  const instant = new Date('2026-01-15T12:00:00.000Z');

  assert.equal(
    buildTimeContext({ now: instant, timeZone: 'UTC' }).utcOffset,
    '+00:00',
  );
  assert.equal(
    buildTimeContext({ now: instant, timeZone: 'Asia/Kolkata' }).utcOffset,
    '+05:30',
  );
  assert.equal(
    buildTimeContext({ now: instant, timeZone: 'America/New_York' }).utcOffset,
    '-05:00',
  );
  assert.equal(
    buildTimeContext({ now: instant, timeZone: 'Asia/Singapore' }).timeZone,
    'Asia/Singapore',
  );
});

test('respects daylight-saving transitions through the system timezone data', () => {
  const springBefore = buildTimeContext({
    now: new Date('2026-03-08T06:59:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(springBefore.localTime, '1:59 AM');
  assert.equal(springBefore.utcOffset, '-05:00');

  const springAfter = buildTimeContext({
    now: new Date('2026-03-08T07:00:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(springAfter.localTime, '3:00 AM');
  assert.equal(springAfter.utcOffset, '-04:00');

  const fallBefore = buildTimeContext({
    now: new Date('2026-11-01T05:30:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(fallBefore.localTime, '1:30 AM');
  assert.equal(fallBefore.utcOffset, '-04:00');

  const fallAfter = buildTimeContext({
    now: new Date('2026-11-01T06:30:00.000Z'),
    timeZone: 'America/New_York',
  });
  assert.equal(fallAfter.localTime, '1:30 AM');
  assert.equal(fallAfter.utcOffset, '-05:00');
});

test('appends and replaces a single temporal context section', () => {
  const initial = appendTimeAwarenessInstruction('Base instruction.', {
    now: new Date('2026-11-05T04:45:00.000Z'),
    timeZone: 'Asia/Singapore',
  });

  assert.ok(initial.startsWith('Base instruction.'));
  assert.match(initial, new RegExp(TIME_AWARENESS_INSTRUCTION_MARKER));
  assert.match(initial, /- Date: Thursday, November 5, 2026/u);
  assert.match(initial, /- Local time: 12:45 PM/u);
  assert.match(initial, /- Day period: Afternoon/u);
  assert.match(initial, /- Timezone: Asia\/Singapore/u);
  assert.match(initial, /- UTC offset: \+08:00/u);
  assert.match(initial, /- ISO timestamp: 2026-11-05T04:45:00\.000Z/u);

  const replaced = appendTimeAwarenessInstruction(initial, {
    now: new Date('2026-11-06T00:15:00.000Z'),
    timeZone: 'UTC',
  });

  assert.equal(replaced.match(/CURRENT TEMPORAL CONTEXT:/gu)?.length, 1);
  assert.match(replaced, /- Date: Friday, November 6, 2026/u);
  assert.match(replaced, /- Timezone: UTC/u);
  assert.doesNotMatch(replaced, /Asia\/Singapore/u);
  assert.ok(replaced.startsWith('Base instruction.'));
});

test('each NVIDIA generation request receives a fresh temporal context', async t => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-11-05T04:45:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const instructions: string[] = [];
  const generate = (): Promise<string> => generateNvidiaReply(
    'nvapi-test-key',
    [messengerMessage('in-1', 'Alex', 'Hello.')],
    {
      systemInstruction: 'Base instruction.',
      identity: { name: 'TestBot' },
      fetch: async (_input, init) => {
        instructions.push(JSON.parse(String(init?.body)).messages[0].content);
        return successfulCompletion('Hi.');
      },
    },
  );

  await generate();
  t.mock.timers.setTime(new Date('2026-11-06T00:15:00.000Z').getTime());
  await generate();

  assert.equal(instructions.length, 2);
  assert.match(instructions[0], /- ISO timestamp: 2026-11-05T04:45:00\.000Z/u);
  assert.match(instructions[1], /- ISO timestamp: 2026-11-06T00:15:00\.000Z/u);
  assert.equal(instructions[0].match(/CURRENT TEMPORAL CONTEXT:/gu)?.length, 1);
  assert.equal(instructions[1].match(/CURRENT TEMPORAL CONTEXT:/gu)?.length, 1);
  assert.ok(instructions[0].startsWith('Base instruction.'));
  assert.ok(instructions[1].startsWith('Base instruction.'));
});

test('temporal context preserves default and custom personality instructions', () => {
  const customInstruction = 'Deadpan and dry.';
  const custom = composeProductionSystemInstruction({
    identity: { name: 'TestBot' },
    personalityMode: 'custom',
    customPersonalityInstruction: customInstruction,
  });
  const injectedCustom = appendTimeAwarenessInstruction(custom, {
    now: new Date('2026-11-05T04:45:00.000Z'),
    timeZone: 'UTC',
  });
  assert.ok(injectedCustom.startsWith(custom));
  assert.match(injectedCustom, /Deadpan and dry\./u);

  const defaultComposed = composeProductionSystemInstruction({
    identity: { name: 'TestBot' },
    personalityMode: 'default',
  });
  assert.ok(defaultComposed.includes(getDefaultPersonalityInstruction()));
  assert.equal(defaultComposed.includes(TIME_AWARENESS_INSTRUCTION_MARKER), false);
  const injectedDefault = appendTimeAwarenessInstruction(defaultComposed, {
    now: new Date('2026-11-05T04:45:00.000Z'),
    timeZone: 'UTC',
  });
  assert.ok(injectedDefault.includes(getDefaultPersonalityInstruction()));
  assert.match(injectedDefault, new RegExp(TIME_AWARENESS_INSTRUCTION_MARKER));
});
