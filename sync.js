const path = require('node:path');
const { createSyncService } = require('./sync-service');

async function main() {
  const service = createSyncService({
    credentials: {
      appId: process.env.WECHAT_OFFICIAL_APPID,
      appSecret: process.env.WECHAT_OFFICIAL_APPSECRET
    },
    dataDir: process.env.WECHAT_SYNC_DATA_DIR || path.join(__dirname, 'data')
  });
  const result = await service.syncOnce({
    full: process.argv.includes('--full'),
    pageSize: Number(process.env.WECHAT_SYNC_PAGE_SIZE || 20),
    maxPages: Number(process.env.WECHAT_SYNC_MAX_PAGES || 100)
  });
  console.log(JSON.stringify({
    fetchedCount: result.fetchedCount,
    newCount: result.newCount,
    acceptedCount: result.acceptedCount,
    pendingCount: result.pendingCount,
    dataFiles: result.dataFiles
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code,
    payload: error.payload
  }, null, 2));
  process.exitCode = 1;
});
