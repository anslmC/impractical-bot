const { readFileSync } = require('node:fs');
const { win32 } = require('node:path');

function getConfigurationPath() {
  if (process.platform !== 'win32') {
    throw new Error(`Configuration storage is not supported on '${process.platform}'.`);
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !win32.isAbsolute(localAppData) ||
      win32.parse(localAppData).root === '\\' || localAppData.includes('\0')) {
    throw new Error('LOCALAPPDATA must contain an absolute Windows path.');
  }

  return win32.join(localAppData, 'Impractical Bot', 'config.json');
}

function main() {
  const configurationPath = getConfigurationPath();
  let source;
  try {
    source = readFileSync(configurationPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration file was not found: ${configurationPath}`);
    }
    throw new Error(`Unable to read configuration file '${configurationPath}': ${error.message}`);
  }

  let configuration;
  try {
    configuration = JSON.parse(source);
  } catch {
    throw new Error(`Configuration file is not valid JSON: ${configurationPath}`);
  }
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Configuration must be a JSON object.');
  }

  const mode = configuration.botPersonality === undefined
    ? 'default'
    : configuration.botPersonality;
  if (mode !== 'default' && mode !== 'custom') {
    throw new Error("botPersonality must be either 'default' or 'custom'.");
  }

  const instruction = configuration.customPersonalityInstruction;
  if (instruction !== undefined && typeof instruction !== 'string') {
    throw new Error('customPersonalityInstruction must be a string when present.');
  }

  console.log(`botPersonality: ${mode}`);
  console.log('customPersonalityInstruction:');
  if (instruction === undefined) {
    console.log('[missing]');
  } else {
    if (instruction.length === 0) {
      console.log('[empty]');
    } else if (instruction.trim().length === 0) {
      console.log('[empty or whitespace only]');
    }
    process.stdout.write(instruction);
  }
}

try {
  main();
} catch (error) {
  console.error(
    `Unable to inspect personality configuration: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}