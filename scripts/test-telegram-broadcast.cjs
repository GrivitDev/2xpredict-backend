const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
});

async function findFile(directory, filename) {
  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const found = await findFile(fullPath, filename);
      if (found) return found;
    }

    if (entry.isFile() && entry.name === filename) {
      return fullPath;
    }
  }

  return null;
}

async function main() {
  console.log('\n======================================');
  console.log('   2XPREDICT TELEGRAM INTEGRATION TEST');
  console.log('======================================\n');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_INFO_GROUP_ID;

  if (!token || !channelId) {
    throw new Error('Telegram configuration is missing.');
  }

  console.log('Bot token: CONFIGURED');
  console.log('Public destination:', channelId);

  const distDirectory = path.resolve(__dirname, '..', 'dist');

  const serviceFile = await findFile(
    distDirectory,
    'telegram.service.js',
  );

  if (!serviceFile) {
    throw new Error('Compiled TelegramService not found. Run npm run build.');
  }

  const imported = await import(
    pathToFileURL(serviceFile).href
  );

  const TelegramService =
    imported.TelegramService ||
    imported.default?.TelegramService;

  if (!TelegramService) {
    throw new Error('TelegramService could not be loaded.');
  }

  const config = {
    get(key) {
      return process.env[key];
    },
  };

  const telegram = new TelegramService(config);

  const timestamp = new Date().toISOString();

  const results = {
    photo: 'NOT RUN',
    text: 'NOT RUN',
  };

  // ======================================
  // TEST 1: NATIVE FETCH PHOTO DELIVERY
  // ======================================

  console.log('\n--------------------------------------');
  console.log('TEST 1: PHOTO DELIVERY');
  console.log('--------------------------------------');

  try {
    const result = await telegram.sendPublicChannelPhoto(
      'https://www.2xpredict.com/banner.png',
      `2xPredict Node.js Photo Integration Test\nTime: ${timestamp}`,
      [
        [
          {
            text: 'Visit 2xPredict',
            url: 'https://www.2xpredict.com',
          },
        ],
      ],
    );

    if (result.success) {
      results.photo = 'SUCCESS';
      console.log('PHOTO DELIVERED SUCCESSFULLY');
      console.log('Message ID:', result.messageId);
    } else {
      results.photo = 'FAILED';
      console.log('PHOTO DELIVERY FAILED');
      console.log('Delivery outcome unknown:', result.deliveryUnknown);
    }
  } catch (error) {
    results.photo = 'FAILED';
    console.error('PHOTO ERROR:', error.message);
  }

  // ======================================
  // TEST 2: TELEGRAF TEXT DELIVERY
  // ======================================

  console.log('\n--------------------------------------');
  console.log('TEST 2: TEXT DELIVERY');
  console.log('--------------------------------------');

  try {
    const result = await telegram.sendPublicChannelMessage(
      `2xPredict Node.js Text Integration Test\nTime: ${timestamp}`,
    );

    if (result.success) {
      results.text = 'SUCCESS';
      console.log('TEXT DELIVERED SUCCESSFULLY');
      console.log('Message ID:', result.messageId);
    } else {
      results.text = 'FAILED';
      console.log('TEXT DELIVERY FAILED');
      console.log('Delivery outcome unknown:', result.deliveryUnknown);
    }
  } catch (error) {
    results.text = 'FAILED';
    console.error('TEXT ERROR:', error.message);
  }

  // ======================================
  // FINAL SUMMARY
  // ======================================

  console.log('\n======================================');
  console.log('         TEST SUMMARY');
  console.log('======================================');

  console.log('Photo delivery:', results.photo);
  console.log('Text delivery:', results.text);
  console.log('Destination:', channelId);

  console.log('======================================\n');

  // Photo is the main change being evaluated.
  if (results.photo !== 'SUCCESS') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nINTEGRATION TEST ERROR:', error.message);
  process.exitCode = 1;
});