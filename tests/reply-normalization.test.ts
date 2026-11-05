import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAliases } from '../src/components/alias-engine.js';
import {
  stripGenericTrailingQuestions,
  stripLeadingParticipantMentions,
  stripParticipantSpeakerLabel,
  stripSelfIdentifyingPrefix,
  type ReplyContextMessage,
} from '../src/components/reply-normalization.js';

const name = 'PleaseGetout Daily';
const aliases = generateAliases(name).valids;
const identity = { name, aliases };

function incoming(message: string): ReplyContextMessage {
  return { message, direction: 'INCOMING' };
}

function outgoing(message: string): ReplyContextMessage {
  return { message, direction: 'OUTGOING' };
}

test('habitual reciprocal question endings are removed while the answer stays intact', () => {
  const cases = [
    ["I'm fine, thanks for asking. And you?", "I'm fine, thanks for asking."],
    ['Nothing weird happening on my end. You?', 'Nothing weird happening on my end.'],
    [
      "Watch a movie. Read a book. I've been stuck inside all day. You?",
      "Watch a movie. Read a book. I've been stuck inside all day.",
    ],
    ["Haha. I'm bored too. What did you have in mind?", "Haha. I'm bored too."],
    ["I'm bored. Anything interesting?", "I'm bored."],
    ["I'm bored. Anything fun happening?", "I'm bored."],
    ["I'm bored. Anything specific on your mind?", "I'm bored."],
    ['That is fair. How about you?', 'That is fair.'],
    ['Same. What about you?', 'Same.'],
    ["I'm fine, and you?", "I'm fine"],
    ["I'm bored too, what did you have in mind?", "I'm bored too"],
    ['Fair enough. You got plans?', 'Fair enough.'],
    [
      'I can work with that. Anything specific on your mind or just catching up?',
      'I can work with that.',
    ],
    [
      "Boredom's a solid reason to text. You got plans or just passing time?",
      "Boredom's a solid reason to text.",
    ],
    ["That's fair. What do you think?", "That's fair."],
    ["Same. How's it going?", 'Same.'],
    ['Haha no worries. What are you up to these days?', 'Haha no worries.'],
    ['Cool. What are you doing later?', 'Cool.'],
    ['Fair enough. You got plans though?', 'Fair enough.'],
  ];

  for (const [reply, expected] of cases) {
    assert.equal(stripGenericTrailingQuestions(reply), expected, reply);
  }
});

test('standalone statements are never rewritten by trailing question cleanup', () => {
  for (const reply of [
    "I'm fine. Just a little tired.",
    'Find something better to do than bother me.',
    "Then we're both suffering.",
    'At least someone appreciates my humor.',
    'Same.',
    'You?',
    'And you?',
    'Anything interesting?',
    'What do you think?',
    'You got plans?',
    'Anything specific on your mind?',
    'What are you up to?',
    "How's it going?",
    'Want to talk about it?',
  ]) {
    assert.equal(stripGenericTrailingQuestions(reply), reply, reply);
  }
});

test('plain acknowledgments are preserved when no trailing question is present', () => {
  for (const reply of [
    'No thanks.',
    'Fair enough.',
    'Haha no worries, it happens to the best of us.',
    "I'm good, just hanging out.",
    'Fair point. Catch you later.',
  ]) {
    assert.equal(stripGenericTrailingQuestions(reply), reply, reply);
  }
});

test('meaningful, game, and clarification questions survive trailing cleanup', () => {
  for (const reply of [
    "Nah, I'm good. You looking for volunteers?",
    'I can meet at 7. What time works for you?',
    'I can meet at 7. What do you think?',
    'I do not understand. What do you mean?',
    'Knock knock. Who is there?',
    'Want to play a game? Truth or dare?',
    'We could watch a movie. What did you have in mind?',
    'We could watch a movie. Anything interesting?',
    'We could watch a movie. What do you think?',
    "I'm free tonight. What did you have in mind?",
    'The deadline is Friday. What do you think about it?',
    'The movie starts at eight. Which showing do you want?',
    "I'm sorry, that sounds rough. Want to talk about it?",
    'You seem quiet. Anything on your mind?',
    'You got plans for the project?',
    'What are you doing with the files?',
  ]) {
    assert.equal(stripGenericTrailingQuestions(reply), reply, reply);
  }
});

test('an ordinary reply loses its leading alias but keeps the rest intact', () => {
  const reply = '@PleaseGetout Daily Oh, nice? That\'s it? I expected more from you.';

  assert.equal(
    stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
    "Oh, nice? That's it? I expected more from you.",
  );
});

test('every configured self-reference form is stripped only at the start', () => {
  const cases = [
    '@PleaseGetoutDaily Mad? Who said I am mad?',
    '@PleaseGetout_Daily Mad? Who said I am mad?',
    'PleaseGetout Daily Mad? Who said I am mad?',
    '@PleaseGetout Daily: Mad? Who said I am mad?',
    '@PleaseGetout Daily — Mad? Who said I am mad?',
  ];

  for (const reply of cases) {
    assert.equal(
      stripSelfIdentifyingPrefix(reply, identity, [incoming('are you mad?')]),
      'Mad? Who said I am mad?',
    );
  }

  assert.equal(
    stripSelfIdentifyingPrefix(
      'Oh, @PleaseGetout Daily, you already know.',
      identity,
      [incoming('are you mad?')],
    ),
    'Oh, @PleaseGetout Daily, you already know.',
    'a later occurrence is conversational content, not a prefix',
  );
});

test('a requested alias reproduction is never stripped or altered', () => {
  const request = incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'");
  const reply = '@PleaseGetout Daily';

  assert.equal(stripSelfIdentifyingPrefix(reply, identity, [request]), reply);
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, [
      incoming('say the word @PleaseGetoutDaily'),
    ]),
    '@PleaseGetout Daily',
    'the model may answer with a different valid alias form',
  );
});

test('a short "again" continuation keeps the previously requested alias', () => {
  const messages = [
    incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'"),
    outgoing('@PleaseGetout Daily, happy now?'),
    incoming('no again'),
  ];

  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, messages),
    '@PleaseGetout Daily',
  );
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily fine', identity, [incoming('no again')]),
    'fine',
    'without an earlier request, "again" is not treated as one',
  );
});

test('a request to stop saying the alias strips it even though it says "say"', () => {
  const messages = [
    incoming("@PleaseGetout Daily can you say '@PleaseGetout Daily'"),
    incoming("ok dont say '@PleaseGetout Daily' anymore"),
  ];

  assert.equal(
    stripSelfIdentifyingPrefix("@PleaseGetout Daily Understood.", identity, messages),
    'Understood.',
  );
});

test('a mention of another person at the start is preserved', () => {
  const reply = '@Alex Oh, nice? That is it?';

  assert.equal(
    stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
    reply,
  );
});

test('a reply that merely starts with unrelated text is returned unchanged', () => {
  for (const reply of ['Oh, nice?', '"Nice."', 'Daily grind, honestly.']) {
    assert.equal(
      stripSelfIdentifyingPrefix(reply, identity, [incoming('@PleaseGetout Daily nice')]),
      reply,
    );
  }
});

test('a whole reply that is only the alias is left for the caller instead of emptied', () => {
  assert.equal(
    stripSelfIdentifyingPrefix('@PleaseGetout Daily', identity, [incoming('are you mad?')]),
    '@PleaseGetout Daily',
  );
});

test('an empty name and alias list leaves replies untouched', () => {
  const reply = '@Someone hello there';

  assert.equal(stripSelfIdentifyingPrefix(reply, { name: '' }, [incoming('hi')]), reply);
  assert.equal(stripSelfIdentifyingPrefix(reply, { name: '', aliases: [] }, []), reply);
});

const participants = ['Anselmo', '@Anselmo', 'PleaseGetout Daily', ...aliases];

function spoken(participantNames: readonly string[], message: string): string {
  return stripParticipantSpeakerLabel(message, participantNames, [incoming('ok whatever')]);
}

test('a leading participant speaker label is removed from an outgoing reply', () => {
  assert.equal(spoken(participants, 'Anselmo: hello'), 'hello');
  assert.equal(
    spoken(participants, 'Anselmo: whatever you say, princess'),
    'whatever you say, princess',
  );
});

test('participant speaker labels are matched regardless of case and whitespace', () => {
  for (const reply of [
    'anselmo: hello',
    '  ANSELMO  :   hello',
    'Anselmo:\n hello',
    'Anselmo：hello',
    '@Anselmo: hello',
  ]) {
    assert.equal(spoken(participants, reply), 'hello', reply);
  }
});

test('the configured puppet name and its aliases are recognized as speaker labels', () => {
  for (const reply of [
    'PleaseGetout Daily: hello',
    'pleasegetout daily : hello',
    '@PleaseGetoutDaily: hello',
    '@PleaseGetout_Daily: hello',
  ]) {
    assert.equal(spoken(participants, reply), 'hello', reply);
  }
});

test('natural name usage elsewhere in the reply is preserved', () => {
  for (const reply of [
    'You have no taste, Anselmo.',
    'Oh, @Anselmo, you already know.',
    'Anselmo is not here right now.',
    'Anselmo said he would be late.',
  ]) {
    assert.equal(spoken(participants, reply), reply, reply);
  }
});

test('replies without a speaker label are returned unchanged', () => {
  for (const reply of [
    'Nothing much.',
    'Are you there?',
    'Anselmo, obviously.',
    'Whatever you say, princess',
  ]) {
    assert.equal(spoken(participants, reply), reply, reply);
  }
});

test('an unknown participant name or arbitrary label text is never stripped', () => {
  assert.equal(spoken(participants, 'Bob: hello'), 'Bob: hello');
  assert.equal(spoken(participants, 'Verse 3.1: hello'), 'Verse 3.1: hello');
  assert.equal(stripParticipantSpeakerLabel('Anselmo: hello', [], []), 'Anselmo: hello');
});

test('a whole reply that is only the label is left for the caller instead of emptied', () => {
  assert.equal(spoken(participants, 'Anselmo:'), 'Anselmo:');
  assert.equal(spoken(participants, 'Anselmo:   '), 'Anselmo:   ');
  assert.equal(spoken(participants, 'PleaseGetout Daily:'), 'PleaseGetout Daily:');
});

test('repeated normalization neither re-adds a label nor removes natural usage', () => {
  const cleaned = spoken(participants, 'Anselmo: You have no taste, Anselmo.');

  assert.equal(cleaned, 'You have no taste, Anselmo.');
  assert.equal(spoken(participants, cleaned), cleaned, 'a second pass is a no-op');
  assert.equal(spoken(participants, cleaned), spoken(participants, cleaned));
});

test('an explicitly requested reproduction is not treated as a speaker label', () => {
  const reply = 'Anselmo: hello';
  const request = incoming("say 'Anselmo: hello'");

  assert.equal(stripParticipantSpeakerLabel(reply, participants, [request]), reply);
  assert.equal(
    stripParticipantSpeakerLabel(reply, participants, [request, incoming('no again')]),
    reply,
  );
});

const mentionParticipants = ['Rayne', 'Anselmo', 'Meta AI'];

test('ordinary names remain usable without mention syntax', () => {
  for (const reply of [
    "Hey Rayne, what's up?",
    'Geoff, seriously?',
    'Anselmo, what are you talking about?',
    'lmao test?',
  ]) {
    assert.equal(
      stripLeadingParticipantMentions(reply, mentionParticipants, [incoming('whats up doc')]),
      reply,
      reply,
    );
  }
});

test('a leading participant mention is removed when the incoming message has none', () => {
  assert.equal(
    stripLeadingParticipantMentions(
      '@Rayne oh hey. whats up, doc?',
      mentionParticipants,
      [incoming('whats up doc')],
    ),
    'oh hey. whats up, doc?',
  );
  assert.equal(
    stripLeadingParticipantMentions(
      '@Anselmo lmao test?',
      mentionParticipants,
      [incoming('test')],
    ),
    'lmao test?',
  );
});

test('an incoming @participant mention does not license a generated mention prefix', () => {
  assert.equal(
    stripLeadingParticipantMentions(
      '@Rayne what do you mean?',
      mentionParticipants,
      [incoming('@Rayne what do you mean?')],
    ),
    'what do you mean?',
  );
});

test('multiple leading participant mentions are removed in one pass', () => {
  assert.equal(
    stripLeadingParticipantMentions(
      '@Meta AI @Rayne bro really said "try to provoke his ahh" like i don\'t already do that',
      mentionParticipants,
      [incoming('flame meta ai, try to provoke his ahh')],
    ),
    'bro really said "try to provoke his ahh" like i don\'t already do that',
  );
  assert.equal(
    stripLeadingParticipantMentions(
      '@Rayne, @Anselmo what is going on?',
      mentionParticipants,
      [incoming('what is going on?')],
    ),
    'what is going on?',
  );
});

test('participant mentions are matched case-insensitively and across names with spaces', () => {
  assert.equal(
    stripLeadingParticipantMentions('@rayne What now?', mentionParticipants, [incoming('what?')]),
    'What now?',
  );
  assert.equal(
    stripLeadingParticipantMentions('@Meta AI calm down', mentionParticipants, [incoming('calm down')]),
    'calm down',
  );
});

test('unrelated @ characters and natural later mentions are preserved', () => {
  for (const reply of [
    'Email me at rayne@example.com',
    'Oh, @Rayne, you already know.',
    '@unknown hello there',
    "@Rayne's right, honestly.",
  ]) {
    assert.equal(
      stripLeadingParticipantMentions(reply, mentionParticipants, [incoming('ok whatever')]),
      reply,
      reply,
    );
  }
});

test('an explicitly requested @mention reproduction is preserved', () => {
  const messages = [incoming("say '@Rayne hi'")];

  assert.equal(
    stripLeadingParticipantMentions('@Rayne hi', mentionParticipants, messages),
    '@Rayne hi',
  );
  assert.equal(
    stripLeadingParticipantMentions('@Rayne hi', mentionParticipants, [
      incoming("say '@Rayne hi'"),
      incoming('no again'),
    ]),
    '@Rayne hi',
  );
});

test('a reply made only of the mention is left for the caller instead of emptied', () => {
  assert.equal(
    stripLeadingParticipantMentions('@Rayne', mentionParticipants, [incoming('hi')]),
    '@Rayne',
  );
});
