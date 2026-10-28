const { loadConfiguration, saveConfiguration } = require('../../dist/src/config/configuration.js');

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
    throw new Error('Configuration requires PIN reconfiguration before it can be safely saved.');
  }

  const { configuration } = result;
  const hasCustomInstruction = Object.prototype.hasOwnProperty.call(
    configuration,
    'customPersonalityInstruction',
  );
  const isAlreadyDefault = configuration.botPersonality === 'default' && !hasCustomInstruction;
  if (isAlreadyDefault) {
    console.log("Saved personality is already 'default'; configuration was not rewritten.");
    return;
  }

  // Clearing the instruction removes the key, matching how the CLI persists the
  // default personality; the configuration validator rejects an empty string.
  const updatedConfiguration = { ...configuration, botPersonality: 'default' };
  delete updatedConfiguration.customPersonalityInstruction;
  saveConfiguration(updatedConfiguration);
  console.log("Reset the saved personality to 'default' and removed the custom instructions.");
}

try {
  main();
} catch (error) {
  console.error(
    `Unable to reset personality configuration: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
