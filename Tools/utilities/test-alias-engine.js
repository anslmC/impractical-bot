const assert = require('node:assert/strict');
const readline = require('node:readline/promises');
const { generateAliases } = require('../components/alias-engine');

function printBucket(name, variations) {
  console.log(`\n${name} (${variations.length} unique):`);
  for (const variation of variations) {
    console.log(`  - ${variation}`);
  }
}

function runTests() {
  const baseline = generateAliases('PleaseGetout Daily');
  assert.deepEqual(baseline.base, ['@PleaseGetout Daily']);
  assert.ok(baseline.valids.includes('@PleaseGetout Daily'));
  assert.equal(baseline.valids[0], '@PleaseGetout Daily');

  const preservedName = generateAliases('PleaseGetout  daily Name');
  assert.deepEqual(preservedName.base, ['@PleaseGetout  daily Name']);

  const existingBuckets = generateAliases('Alice Bob');
  assert.deepEqual(existingBuckets.nameShuffle, [
    'Alice Bob', 'Bob Alice', 'Alice', 'Bob',
  ]);
  assert.deepEqual(existingBuckets.shortenedForms, [
    'Alice Bob', 'Alice', 'Bob', 'AB', 'A Bob', 'Alice B',
  ]);
  assert.deepEqual(existingBuckets.handleVariations, [
    '@AliceBob', '@Alice_Bob', '@Alice-Bob', '@Alice.Bob',
    '@BobAlice', '@Bob_Alice', '@Bob-Alice', '@Bob.Alice',
    '@Alice', '@Bob',
  ]);

  const overlapping = generateAliases('Ada');
  assert.deepEqual(overlapping.base, ['@Ada']);
  assert.equal(overlapping.handleVariations.includes('@Ada'), true);
  assert.equal(overlapping.valids.filter(alias => alias === '@Ada').length, 1);
  assert.equal(overlapping.valids[0], '@Ada');

  console.log('Alias engine tests passed.');
}

async function main() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  let inputName;
  try {
    inputName = await prompt.question('Enter a base name: ');
  } finally {
    prompt.close();
  }

  const name = inputName.replace(/\s+/g, ' ').trim();
  if (!name) {
    throw new Error('A non-empty base name is required.');
  }

  const { base, nameShuffle, shortenedForms, handleVariations, valids } = generateAliases(name);

  console.log(`\nInput name: ${name}`);
  printBucket('Base', base);
  printBucket('Bucket 1 - Name Shuffle', nameShuffle);
  printBucket('Bucket 2 - Shortened Form', shortenedForms);
  printBucket('Bucket 3 - @ Variation', handleVariations);
  console.log(`\nFinal valids (${valids.length} unique):`);
  console.log(JSON.stringify(valids, null, 2));
}

if (process.argv[2] === '--test') {
  runTests();
} else {
  main().catch(error => {
    console.error(`Alias generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
