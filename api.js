'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createCloudbaseRepository } = require('./cloudbase-repository');
const { createSyncService } = require('./sync-service');
const { normalizeArticleInput, buildStoreRecords } = require('./article-import');
const { renderOfficialArticle } = require('./wechat-renderer');
const crypto = require('node:crypto');
const BUILD_VERSION = 'media-map-admin-20260908-1';

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

function getAdminOpenIds() {
  return String(process.env.SUPER_ADMIN_OPENIDS || process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getRequestOpenId(request) {
  return String(request.headers['x-wx-openid'] || request.headers['x-wx-open-id'] || '').trim();
}

function isAdminRequest(request) {
  const openId = getRequestOpenId(request);
  return Boolean(openId && getAdminOpenIds().includes(openId));
}

function canImportArticles(request) {
  return isAdminRequest(request) || isSyncAuthorized(request);
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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体超过 1MB'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求体必须是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function isArticleUrl(url) {
  return /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/.test(String(url || ''));
}

async function geocodeAddress(address, city) {
  const key = String(process.env.TENCENT_MAP_KEY || 'GA2BZ-4XCEQ-SAU53-2O77L-3GCXH-XFBS4').trim();
  const query = String(address || '').trim();
  if (!key || !query) return null;
  const url = new URL('https://apis.map.qq.com/ws/geocoder/v1/');
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);
  if (city) url.searchParams.set('region', String(city));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`腾讯地图地址解析失败：HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== 0 || !data.result || !data.result.location) {
    throw new Error(`腾讯地图地址解析失败：${data.message || data.status}`);
  }
  return {
    latitude: Number(data.result.location.lat),
    longitude: Number(data.result.location.lng),
    title: data.result.title || '',
    address: data.result.address || query
  };
}

async function enrichStoreProfiles(article) {
  if (!article || !Array.isArray(article.storeProfiles)) return article;
  const profiles = [];
  for (const profile of article.storeProfiles) {
    const next = { ...profile };
    if ((!next.latitude || !next.longitude) && next.address) {
      try {
        const point = await geocodeAddress(next.address, next.city || article.city);
        if (point) {
          next.latitude = point.latitude;
          next.longitude = point.longitude;
          next.mapTitle = point.title;
          if (!next.address && point.address) next.address = point.address;
        }
      } catch (error) {
        console.warn('geocode skipped:', error.message);
      }
    }
    next.cover = next.cover || article.cover || '';
    profiles.push(next);
  }
  return normalizeArticleInput({ ...article, storeProfiles: profiles });
}

async function importArticleFromUrl(payload) {
  const url = String(payload && payload.url || '').trim();
  if (!isArticleUrl(url)) throw new Error('只支持已发布的微信公众号文章链接：https://mp.weixin.qq.com/s/...');
  const rendered = await renderOfficialArticle(url);
  let html = '';
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (response.ok) html = await response.text();
  } catch (error) {
    // Chromium 已经取得正文时，普通 HTTP 请求失败不影响导入。
  }
  const decodeHtml = value => String(value || '')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#x22;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
  const meta = (property, name) => {
    const propertyMatch = property && html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'));
    const nameMatch = name && html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'));
    return decodeHtml((propertyMatch || nameMatch || [])[1]);
  };
  const title = rendered.title
    || meta('og:title')
    || decodeHtml((html.match(/<h1[^>]*>([\\s\\S]*?)<\/h1>/i) || [])[1])
    || decodeHtml((html.match(/<title[^>]*>([\\s\\S]*?)<\/title>/i) || [])[1]);
  const description = rendered.summary || meta('', 'description') || meta('og:description');
  const cover = rendered.cover || meta('og:image');
  const articleId = `link-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
  return normalizeArticleInput({
    id: articleId,
    title: title.replace(/&amp;/g, '&').trim(),
    url,
    summary: description.replace(/&amp;/g, '&').trim(),
    content: rendered.content,
    cover,
    city: payload.city || '',
    area: payload.area || '',
    storeIds: payload.storeIds || [],
    storeProfiles: payload.storeProfiles || []
  });
}

async function importArticleBatch(payload) {
  const urls = Array.isArray(payload && payload.urls) ? payload.urls : [];
  if (!urls.length) throw new Error('请至少提供一条公众号文章链接');
  if (urls.length > 50) throw new Error('单次最多导入 50 条文章链接');
  const results = [];
  for (const url of [...new Set(urls.map(item => String(item || '').trim()).filter(Boolean))]) {
    try {
      const article = await enrichStoreProfiles(await importArticleFromUrl({ ...payload, url }));
      const structured = buildStoreRecords(article);
      results.push(structured.valid
        ? { url, status: 'accepted', title: article.title, article, stores: structured.stores }
        : { url, status: 'pending', title: article.title, article, errors: structured.errors, warnings: structured.warnings });
    } catch (error) {
      results.push({ url, status: 'failed', error: String(error && error.message || error) });
    }
  }
  return results;
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const segments = requestUrl.pathname.split('/').filter(Boolean);
  try {
    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', version: BUILD_VERSION });
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
    if (requestUrl.pathname === '/api/articles/import-batch') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method Not Allowed，请使用 POST 批量导入文章' });
        return;
      }
      if (!canImportArticles(request)) {
        sendJson(response, 403, { error: '仅超级管理员可以导入公众号文章' });
        return;
      }
      const payload = await readRequestBody(request);
      const results = await importArticleBatch(payload);
      const queueRepository = createCloudbaseRepository({ bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '', storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '', documentId: 'article-review-queue', defaultValue: [] });
      const contentRepository = createCloudbaseRepository({ bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '', storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '', documentId: 'content', defaultValue: { articles: [], stores: [], goods: [], generatedAt: null, syncState: null } });
      const queue = await queueRepository.read();
      const content = await contentRepository.read();
      const articles = [...(content.articles || [])];
      const stores = [...(content.stores || [])];
      const nextQueue = [...queue];
      results.forEach(result => {
        if (result.status === 'accepted') {
          articles.push(result.article);
          stores.push(...result.stores);
        } else if (result.status === 'pending') {
          nextQueue.push({ articleId: result.article.id, title: result.title, url: result.url, raw: result.article, errors: result.errors, warnings: result.warnings, status: '待补门店结构化信息' });
        }
      });
      const uniqueArticles = [...new Map(articles.map(item => [item.url || item.id, item])).values()];
      const validArticleIds = new Set(uniqueArticles.map(item => item.id));
      const uniqueStores = [...new Map(stores.map(item => [item.id, item])).values()]
        .filter(item => validArticleIds.has(item.articleId));
      await contentRepository.write({ ...content, articles: uniqueArticles, stores: uniqueStores, generatedAt: new Date().toISOString() });
      await queueRepository.write([...new Map(nextQueue.map(item => [item.articleId, item])).values()]);
      sendJson(response, 200, { imported: true, total: results.length, acceptedCount: results.filter(item => item.status === 'accepted').length, pendingCount: results.filter(item => item.status === 'pending').length, failedCount: results.filter(item => item.status === 'failed').length, results });
      return;
    }
    if (requestUrl.pathname === '/api/articles/import') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method Not Allowed，请使用 POST 导入文章' });
        return;
      }
      if (!canImportArticles(request)) {
        sendJson(response, 403, { error: '仅超级管理员可以导入公众号文章' });
        return;
      }
      const payload = await readRequestBody(request);
      const article = await enrichStoreProfiles(await importArticleFromUrl(payload));
      const structured = buildStoreRecords(article);
      const queueRepository = createCloudbaseRepository({
        bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '',
        storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '',
        documentId: 'article-review-queue',
        defaultValue: []
      });
      const queue = await queueRepository.read();
      if (!structured.valid) {
        const pending = {
          articleId: article.id,
          title: article.title,
          url: article.url,
          raw: article,
          errors: structured.errors,
          warnings: structured.warnings,
          status: '待补门店结构化信息'
        };
        await queueRepository.write([...queue.filter(item => item.articleId !== article.id), pending]);
        sendJson(response, 202, { imported: true, status: 'pending', article, errors: structured.errors, warnings: structured.warnings });
        return;
      }
      const contentRepository = createCloudbaseRepository({
        bucket: process.env.CLOUDBASE_STORAGE_BUCKET || '',
        storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || '',
        documentId: 'content',
        defaultValue: { articles: [], stores: [], goods: [], generatedAt: null, syncState: null }
      });
      const content = await contentRepository.read();
      const articles = [...(content.articles || []).filter(item => item.id !== article.id), article];
      const stores = [...(content.stores || []).filter(item => item.articleId !== article.id), ...structured.stores];
      await contentRepository.write({ ...content, articles, stores, generatedAt: new Date().toISOString() });
      sendJson(response, 200, { imported: true, status: 'accepted', article, stores: structured.stores });
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
    if (requestUrl.pathname === '/api/admin/status') {
      sendJson(response, 200, { isAdmin: isAdminRequest(request) });
      return;
    }
    if (requestUrl.pathname === '/api/content') {
      // 动态补偿缺失的经纬度（过渡期补救方案）
      const mockCoords = {
        "食字路口农家菜(汉中门大街店)": { lat: 32.0390, lng: 118.7490 },
        "一痕月 by Seven Villas(国金中心店)": { lat: 31.9985, lng: 118.7300 },
        "同得利水饺烧麦": { lat: 32.0450, lng: 118.7900 },
        "兰兰家·四川小吃": { lat: 32.0350, lng: 118.7800 },
        "燚淇大肉面": { lat: 32.0500, lng: 118.7700 },
        "高丽人家原味馆": { lat: 32.0200, lng: 118.7500 }
      };
      if (data && data.stores) {
        data.stores.forEach(s => {
          if (s.latitude === 0 && mockCoords[s.name]) {
            s.latitude = mockCoords[s.name].lat;
            s.longitude = mockCoords[s.name].lng;
            s.hasLocation = true;
          }
        });
      }
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
  if (process.env.WECHAT_OFFICIAL_APPID && process.env.WECHAT_OFFICIAL_APPSECRET) {
    console.log('Automatic official-account sync started');
    startBackgroundSync();
  } else {
    console.warn('Automatic sync skipped: missing WeChat credentials');
  }
});
server.on('error', () => {
  process.exitCode = 1;
});
