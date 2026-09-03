'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createCloudbaseRepository } = require('./cloudbase-repository');
const { createSyncService } = require('./sync-service');

const dataDir = process.env.WECHAT_SYNC_DATA_DIR
  ? path.resolve(process.env.WECHAT_SYNC_DATA_DIR)
  : path.join(__dirname, 'data');
const host = process.env.CONTENT_API_HOST || '0.0.0.0';
const port = Number(process.env.PORT || process.env.CONTENT_API_PORT || 8787);
const emptyState = {
  lastOffset: 0,
  articleIds: [],
  lastRunAt: null,
  lastStatus: 'never'
};

function readJson(fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, fileName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function createContentRepository() {
  return createCloudbaseRepository({
    bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '',
    storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '',
    documentId: 'content',
    defaultValue: { articles: [], stores: [], goods: [], generatedAt: null, syncState: emptyState }
  }) || {
    read: async () => readJson('content.json', { articles: [], stores: [], goods: [], generatedAt: null, syncState: emptyState })
  };
}

function createStateRepository() {
  return createCloudbaseRepository({
    bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '',
    storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '',
    documentId: 'sync-state',
    defaultValue: emptyState
  }) || {
    read: async () => readJson('sync-state.json', emptyState)
  };
}

async function readData() {
  const [content, syncState] = await Promise.all([
    createContentRepository().read(),
    createStateRepository().read()
  ]);
  return {
    articles: Array.isArray(content && content.articles) ? content.articles : [],
    stores: Array.isArray(content && content.stores) ? content.stores : [],
    goods: Array.isArray(content && content.goods) ? content.goods : [],
    generatedAt: content && content.generatedAt ? content.generatedAt : null,
    syncState: syncState && typeof syncState === 'object' && !Array.isArray(syncState)
      ? syncState
      : emptyState
  };
}

function sanitizeErrorDetail(message) {
  return String(message || '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(apikey|api-key|accessKey|token|secret)["']?\s*[:=]\s*["']?[^,\s}"']+/gi, '$1=[redacted]')
    .slice(0, 300);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

// ---------- 远程同步触发 ----------
let syncRunning = false;
let lastSyncError = null;
let lastSyncResult = null;

function isSyncAuthorized(request) {
  const token = process.env.SYNC_TRIGGER_TOKEN || '';
  if (!token) return false;
  return request.headers['x-sync-token'] === token;
}

function startBackgroundSync() {
  syncRunning = true;
  lastSyncError = null;
  const service = createSyncService({
    credentials: {
      appId: process.env.WECHAT_OFFICIAL_APPID,
      appSecret: process.env.WECHAT_OFFICIAL_APPSECRET
    }
  });
  service.syncOnce({
    pageSize: Number(process.env.WECHAT_SYNC_PAGE_SIZE || 20),
    maxPages: Number(process.env.WECHAT_SYNC_MAX_PAGES || 100)
  }).then(result => {
    lastSyncResult = {
      finishedAt: new Date().toISOString(),
      fetchedCount: result.fetchedCount,
      newCount: result.newCount,
      acceptedCount: result.acceptedCount,
      pendingCount: result.pendingCount
    };
  }).catch(error => {
    lastSyncError = String(error && (error.message || error.errMsg) || error);
    console.error('sync failed:', lastSyncError);
  }).finally(() => {
    syncRunning = false;
  });
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const segments = requestUrl.pathname.split('/').filter(Boolean);
  try {
    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', version: 'ad71fb6' });
      return;
    }
    if (requestUrl.pathname === '/api/debug/storage') {
      const repository = createCloudbaseRepository({
        bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '',
        storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '',
        documentId: 'content',
        defaultValue: null
      });
      try {
        const value = await repository.read();
        sendJson(response, 200, {
          ok: true,
          envConfigured: Boolean(process.env.CLOUDBASE_ENV_ID),
          bucketConfigured: Boolean(process.env.CLOUDBASE_STORAGE_BUCKET),
          apiKeyConfigured: Boolean(process.env.CLOUDBASE_APIKEY),
          cloudPath: repository && repository.cloudPath,
          hasContent: Boolean(value)
        });
      } catch (error) {
        const detail = sanitizeErrorDetail(String(error && (error.message || error.errMsg) || error));
        sendJson(response, 502, {
          ok: false,
          envConfigured: Boolean(process.env.CLOUDBASE_ENV_ID),
          bucketConfigured: Boolean(process.env.CLOUDBASE_STORAGE_BUCKET),
          apiKeyConfigured: Boolean(process.env.CLOUDBASE_APIKEY),
          cloudPath: repository && repository.cloudPath,
          detail
        });
      }
      return;
    }
    if (requestUrl.pathname === '/api/sync') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method Not Allowed，请使用 POST 触发同步' });
        return;
      }
      if (!process.env.SYNC_TRIGGER_TOKEN) {
        sendJson(response, 503, { error: '未配置 SYNC_TRIGGER_TOKEN，无法远程触发同步' });
        return;
      }
      if (!isSyncAuthorized(request)) {
        sendJson(response, 401, { error: '无效的同步触发令牌' });
        return;
      }
      if (syncRunning) {
        sendJson(response, 202, { started: false, message: '同步正在进行中，请稍后通过 /api/sync/status 查询' });
        return;
      }
      if (!process.env.WECHAT_OFFICIAL_APPID || !process.env.WECHAT_OFFICIAL_APPSECRET) {
        sendJson(response, 503, { error: '未配置 WECHAT_OFFICIAL_APPID / WECHAT_OFFICIAL_APPSECRET 环境变量' });
        return;
      }
      startBackgroundSync();
      sendJson(response, 202, { started: true, message: '同步已开始，通过 /api/sync/status 查询进度' });
      return;
    }
    if (requestUrl.pathname === '/api/sync/status') {
      const data = await readData();
      sendJson(response, 200, {
        running: syncRunning,
        lastError: lastSyncError,
        lastResult: lastSyncResult,
        syncState: data.syncState
      });
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method Not Allowed' });
      return;
    }
    const data = await readData();
    if (requestUrl.pathname === '/api/content') {
      sendJson(response, 200, data);
      return;
    }
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'stores') {
      const store = data.stores.find(item => String(item.id) === decodeURIComponent(segments[2]));
      if (!store) {
        sendJson(response, 404, { error: 'Store Not Found' });
        return;
      }
      sendJson(response, 200, store);
      return;
    }
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'articles') {
      const article = data.articles.find(item => String(item.id) === decodeURIComponent(segments[2]));
      if (!article) {
        sendJson(response, 404, { error: 'Article Not Found' });
        return;
      }
      sendJson(response, 200, article);
      return;
    }
    sendJson(response, 404, { error: 'Not Found' });
  } catch (error) {
    const message = String(error && (error.message || error.errMsg) || 'unknown error');
    console.error(message);
    const safeMessage = message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]');
    const isStorageConfigurationError = message.includes('CLOUDBASE_APIKEY')
      || message.includes('getCredential')
      || message.includes('secretId')
      || message.includes('RLS')
      || message.includes('permission');
    sendJson(response, 500, {
      error: isStorageConfigurationError
        ? 'CloudBase 私有桶访问未授权：请配置 CLOUDBASE_APIKEY 并确认其为服务端 API Key'
        : 'Internal Server Error',
      detail: sanitizeErrorDetail(safeMessage)
    });
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(() => sendJson(response, 500, { error: 'Internal Server Error' }));
});
server.listen(port, host, () => {
  console.log(`Content API listening on http://${host}:${port}`);
});
server.on('error', () => {
  process.exitCode = 1;
});
