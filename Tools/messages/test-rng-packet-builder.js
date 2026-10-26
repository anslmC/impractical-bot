const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildRngPacket } = require('../components/rng-packet-builder');

function message(messageId) {
  return {
    messageId,
    message: `Message ${messageId}`,
    sender: 'Alex',
    direction: 'INCOMING',
  };
}

test('builds a self-contained packet from the latest ten messages in order', () => {
  const recentMessages = Array.from({ length: 12 }, (_, index) => message(`m-${index + 1}`));
  const packet = buildRngPacket(recentMessages);

  assert.match(packet.packetId, /^rng-packet-\d{3,}$/);
  assert.deepEqual(packet.contextMessages, recentMessages.slice(-10));
  assert.deepEqual(packet.newMessages, []);
});

test('does not mutate supplied messages and uses distinct packet IDs', () => {
  const recentMessages = [message('m-1')];
  const firstPacket = buildRngPacket(recentMessages);
  const secondPacket = buildRngPacket(recentMessages);

  firstPacket.contextMessages[0].message = 'changed';

  assert.equal(recentMessages[0].message, 'Message m-1');
  assert.notEqual(firstPacket.packetId, secondPacket.packetId);
});

test('rejects invalid snapshots', () => {
  assert.throws(() => buildRngPacket(null), /recentMessages must be an array/);
  assert.throws(() => buildRngPacket([{ messageId: '', message: 'invalid' }]), /messageId/);
});