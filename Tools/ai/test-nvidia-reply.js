const {
  generateNvidiaReply,
  loadNvidiaApiKey,
  resolveNvidiaEnvironmentPath,
} = require('../../dist/src/ai/nvidia.js');
const { launchConfiguredBrowser } = require('../../dist/src/browser/launch.js');
const {
  loadConfiguration,
  resolveConfigurationPaths,
} = require('../../dist/src/config/configuration.js');
const { readMessengerMessages } = require('../../dist/src/messages/backread.js');

async function main() {
  const configurationFilePath = process.argv[2] ?? resolveConfigurationPaths().filePath;
  if (process.argv.length > 3) {
    throw new Error('Usage: node Tools/ai/test-nvidia-reply.js [configuration-file-path]');
  }

  const configurationResult = loadConfiguration(configurationFilePath);
  if (configurationResult.status !== 'valid') {
    throw new Error(`Configuration is not ready: ${configurationResult.status}.`);
  }
  if (!configurationResult.configuration.messageDestination) {
    throw new Error('Configuration is missing its Messenger destination.');
  }

  const apiKey = loadNvidiaApiKey(resolveNvidiaEnvironmentPath(configurationFilePath));
  if (!apiKey) {
    throw new Error('The application NVIDIA API key is missing. Run `impbot init` or `impbot updatekey` first.');
  }

  let session;
  try {
    session = await launchConfiguredBrowser(configurationResult.configuration);
    const page = await session.prepare();
    const backread = await readMessengerMessages(page);

    for (const diagnostic of backread.diagnostics) {
      console.log(diagnostic);
    }
    if (backread.messages.length === 0) {
      throw new Error('No Messenger messages were retrieved; no NVIDIA request was made.');
    }

    console.log(`Retrieved ${backread.messages.length} messages from the configured conversation.`);
    const reply = await generateNvidiaReply(apiKey, backread.messages);
    console.log('\nGenerated reply:\n' + reply);
  } finally {
    if (session) {
      await session.disconnect();
    }
  }
}

main().catch(error => {
  console.error(`NVIDIA reply smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});