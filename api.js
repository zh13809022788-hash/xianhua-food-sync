'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createCloudbaseRepository } = require('./cloudbase-repository');

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
    collectionName: process.env.CLOUDBASE_DATA_COLLECTION || 'xianhua_content',
    documentId: 'content',
    defaultValue: { articles: [], stores: [], goods: [], generatedAt: null, syncState: emptyState }
  }) || {
    read: async () => readJson('content.json', { articles: [], stores: [], goods: [], generatedAt: null, syncState: emptyState })
  };
}

function createStateRepository() {
  return createCloudbaseRepository({
    collectionName: process.env.CLOUDBASE_DATA_COLLECTION || 'xianhua_content',
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

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function handleRequest(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method Not Allowed' });
    return;
  }
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const segments = requestUrl.pathname.split('/').filter(Boolean);
  try {
    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
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
    console.error(error.message);
    sendJson(response, 500, { error: 'Internal Server Error' });
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
