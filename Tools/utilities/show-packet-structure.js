const { buildPacketTurn } = require('../components/packet-builder');

function describeStructure(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? [describeStructure(value[0])] : [];
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [name, describeStructure(field)]),
    );
  }
  return typeof value;
}

function main() {
  const firstTurn = buildPacketTurn({
    newMessages: [{
      messageId: 'fixture-mention-id',
      message: 'fixture mention text',
      mention: true,
      sender: 'Fixture Sender',
      direction: 'INCOMING',
    }],
    recentContext: [{
      messageId: 'fixture-context-id',
      message: 'fixture context text',
      mention: false,
      sender: 'Fixture Contact',
      direction: 'INCOMING',
    }],
  });
  const secondTurn = buildPacketTurn({
    newMessages: [{
      messageId: 'fixture-follow-up-id',
      message: 'fixture follow-up text',
      mention: false,
      sender: 'You',
      direction: 'OUTGOING',
    }],
    state: firstTurn.state,
  });

  if (!secondTurn.packet) {
    throw new Error('Packet Builder did not produce the representative packet.');
  }

  console.log(JSON.stringify(describeStructure(secondTurn.packet), null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Unable to display packet structure: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
