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
  if (!Object.prototype.hasOwnProperty.call(configuration, 'puppetName')) {
    console.log('puppetName is already unset; configuration was not rewritten.');
    return;
  }

  const updatedConfiguration = { ...configuration };
  delete updatedConfiguration.puppetName;
  saveConfiguration(updatedConfiguration);
  console.log('Removed puppetName from the existing configuration.');
}

try {
  main();
} catch (error) {
  console.error(`Unable to remove puppetName: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
