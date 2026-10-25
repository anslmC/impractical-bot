const { loadConfiguration } = require('../../dist/src/config/configuration.js');
const { generateAliases } = require('../../dist/src/messages/alias-engine.js');

function printBucket(name, aliases) {
  console.log(`\n${name} (${aliases.length} unique):`);
  for (const alias of aliases) {
    console.log(`  - ${alias}`);
  }
}

function main() {
  const result = loadConfiguration();
  if (result.status === 'missing') {
    throw new Error('Configuration file was not found.');
  }
  if (result.status === 'malformed') {
    throw new Error(`Configuration is malformed: ${result.message}`);
  }
  if (result.status === 'unsupported-version') {
    throw new Error(`Configuration schema version ${result.version} is not supported.`);
  }
  if (result.status === 'pin-required') {
    throw new Error('Configuration requires PIN reconfiguration before it can be used.');
  }

  const puppetName = result.configuration.puppetName;
  if (typeof puppetName !== 'string' || !puppetName.trim()) {
    throw new Error('The configured puppetName is missing or empty.');
  }

  const aliases = generateAliases(puppetName);
  console.log(`Configured puppet name: ${JSON.stringify(puppetName)}`);
  printBucket('Base', aliases.base);
  printBucket('Name Shuffle', aliases.nameShuffle);
  printBucket('Shortened Form', aliases.shortenedForms);
  printBucket('@ Variation', aliases.handleVariations);
  console.log(`\nFinal valids (${aliases.valids.length} unique):`);
  console.log(JSON.stringify(aliases.valids, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Unable to display aliases: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}