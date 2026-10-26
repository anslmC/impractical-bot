import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAliases } from '../src/components/alias-engine.js';

test('preserves the raw Base candidate and puts it first in valids', () => {
  const aliases = generateAliases('PleaseGetout  daily Name');

  assert.deepEqual(aliases.base, ['@PleaseGetout  daily Name']);
  assert.equal(aliases.valids[0], '@PleaseGetout  daily Name');
  assert.ok(aliases.valids.includes('@PleaseGetout  daily Name'));
});

test('preserves established outputs for the existing alias buckets', () => {
  const aliases = generateAliases('Alice Bob');

  assert.deepEqual(aliases.nameShuffle, [
    'Alice Bob', 'Bob Alice', 'Alice', 'Bob',
  ]);
  assert.deepEqual(aliases.shortenedForms, [
    'Alice Bob', 'Alice', 'Bob', 'AB', 'A Bob', 'Alice B',
  ]);
  assert.deepEqual(aliases.handleVariations, [
    '@AliceBob', '@Alice_Bob', '@Alice-Bob', '@Alice.Bob',
    '@BobAlice', '@Bob_Alice', '@Bob-Alice', '@Bob.Alice',
    '@Alice', '@Bob',
  ]);
});

test('deduplicates Base candidates that overlap existing aliases', () => {
  const aliases = generateAliases('Ada');

  assert.deepEqual(aliases.base, ['@Ada']);
  assert.ok(aliases.handleVariations.includes('@Ada'));
  assert.equal(aliases.valids.filter(alias => alias === '@Ada').length, 1);
  assert.equal(aliases.valids[0], '@Ada');
});

test('retains the per-bucket candidate limits and unique valids', () => {
  const aliases = generateAliases('Alpha Beta Gamma Delta Epsilon');

  assert.equal(aliases.base.length, 1);
  assert.ok(aliases.nameShuffle.length <= 30);
  assert.ok(aliases.shortenedForms.length <= 30);
  assert.ok(aliases.handleVariations.length <= 30);
  assert.equal(aliases.valids.length, new Set(aliases.valids).size);
});