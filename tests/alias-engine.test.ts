import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAliases } from '../src/components/alias-engine.js';

test('always puts the configured name first as the @-prefixed default alias', () => {
  const aliases = generateAliases('PleaseGetout Daily');

  assert.deepEqual(aliases.base, ['@PleaseGetout Daily']);
  assert.equal(aliases.valids[0], '@PleaseGetout Daily');
  assert.ok(aliases.valids.includes('@PleaseGetout Daily'));
});

test('generates only a few deliberate combinations of the full configured name', () => {
  const aliases = generateAliases('PleaseGetout Daily');

  assert.deepEqual(aliases.valids, [
    '@PleaseGetout Daily',
    '@PleaseGetoutDaily',
    '@PleaseGetout_Daily',
  ]);
  assert.ok(aliases.valids.length >= 3 && aliases.valids.length <= 5);
  assert.equal(aliases.valids.length, new Set(aliases.valids).size);
  assert.ok(aliases.valids.every(alias => alias.startsWith('@')));
});

test('never generates generic words or shortened name fragments', () => {
  const { valids } = generateAliases('PleaseGetout Daily');

  for (const unwanted of ['Daily', 'Please', 'Getout', '@Daily', '@Please', '@Getout']) {
    assert.equal(valids.includes(unwanted), false);
  }
  for (const alias of valids) {
    const name = alias.slice(1).toLowerCase();
    assert.ok(name.includes('pleasegetout'));
    assert.ok(name.includes('daily'));
  }
});

test('keeps the raw configured name while normalizing whitespace for variations', () => {
  const aliases = generateAliases('PleaseGetout  daily Name');

  assert.deepEqual(aliases.base, ['@PleaseGetout  daily Name']);
  assert.equal(aliases.valids[0], '@PleaseGetout  daily Name');
  assert.deepEqual(aliases.valids, [
    '@PleaseGetout  daily Name',
    '@PleaseGetoutdailyName',
    '@PleaseGetout_daily_Name',
  ]);
});

test('deduplicates combinations for a single-token configured name', () => {
  const aliases = generateAliases('Ada');

  assert.deepEqual(aliases.base, ['@Ada']);
  assert.deepEqual(aliases.handleVariations, ['@Ada']);
  assert.deepEqual(aliases.valids, ['@Ada']);
});

test('caps the alias list at five unique @-prefixed combinations', () => {
  const aliases = generateAliases('Alpha Beta Gamma Delta Epsilon');

  assert.ok(aliases.valids.length <= 5);
  assert.equal(aliases.valids.length, new Set(aliases.valids).size);
  assert.ok(aliases.valids.every(alias => alias.startsWith('@')));
});
