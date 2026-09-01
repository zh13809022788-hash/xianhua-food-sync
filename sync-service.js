const fs = require('node:fs/promises');
const path = require('node:path');
const { OfficialAccountClient } = require('./wechat-official-account');
const { createSyncStateStore } = require('./sync-state');
const { normalizePublishedList } = require('./normalize-published');
const { createArticleStructurer } = require('./article-structurer');
const { createLlmExtractor } = require('./llm-structurer');
const { createCloudbaseRepository } = require('./cloudbase-repository');

function createJsonRepository(filePath) {
  async function read() {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function write(value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temp, filePath);
  }

  return { read, write, filePath };
}

function createSyncService(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const client = options.client || new OfficialAccountClient(options.credentials);
  const cloudOptions = {
    storagePrefix: process.env.CLOUDBASE_STORAGE_PREFIX || ''
  };
  const localStateStore = createSyncStateStore(path.join(dataDir, 'sync-state.json'));
  const stateStore = options.stateStore || createCloudbaseRepository({
    ...cloudOptions,
    documentId: 'sync-state',
    defaultValue: { lastOffset: 0, articleIds: [], lastRunAt: null, lastStatus: 'never' }
  }) || localStateStore;
  const rawRepository = options.rawRepository || createCloudbaseRepository({
    ...cloudOptions,
    documentId: 'published-articles',
    defaultValue: []
  }) || createJsonRepository(path.join(dataDir, 'published-articles.json'));
  const queueRepository = options.queueRepository || createCloudbaseRepository({
    ...cloudOptions,
    documentId: 'article-review-queue',
    defaultValue: []
  }) || createJsonRepository(path.join(dataDir, 'article-review-queue.json'));
  const contentRepository = options.contentRepository || createCloudbaseRepository({
    ...cloudOptions,
    documentId: 'content',
    defaultValue: { articles: [], stores: [], goods: [], generatedAt: null, syncState: null }
  }) || createJsonRepository(path.join(dataDir, 'content.json'));
  const llmExtractor = options.extractor || createLlmExtractor(options.llmOptions);
  const structurer = options.structurer || createArticleStructurer({
    extractor: llmExtractor || undefined
  });

  async function syncOnce(syncOptions = {}) {
    const state = await stateStore.read();
    const rawArticles = await rawRepository.read();
    const reviewQueue = await queueRepository.read();
    const knownIds = new Set(rawArticles.map(item => item.article_id || item.id));
    // 每次从列表起点扫描并按文章 ID 去重，避免新文章插入列表顶部后被偏移量跳过。
    const startOffset = 0;
    const fetched = await client.listAllPublished({
      pageSize: syncOptions.pageSize || 20,
      maxPages: syncOptions.maxPages || 100,
      noContent: false,
      offset: startOffset
    });

    const newArticles = fetched.filter(item => {
      const id = item.article_id || item.id;
      return id && !knownIds.has(id);
    });
    const normalized = normalizePublishedList(newArticles);
    const accepted = [];
    const pending = [];

    for (let index = 0; index < normalized.length; index += 1) {
      const article = normalized[index];
      const raw = newArticles.find(item => {
        const id = item.article_id || item.id;
        return id === article.sourceArticleId || id === article.id;
      }) || null;
      const result = await structurer.structure(article, raw);
      if (result.valid) {
        accepted.push({ article: result.article, stores: result.stores, source: 'wechat-official-account' });
      } else {
        pending.push({
          articleId: article.id,
          title: article.title,
          url: article.url,
          raw,
          errors: result.errors,
          warnings: result.warnings,
          status: '待补门店结构化信息'
        });
      }
    }

    const mergedRaw = [...rawArticles, ...newArticles];
    const mergedQueue = mergeById([...reviewQueue, ...pending], 'articleId');
    const nextState = {
      lastOffset: startOffset + fetched.length,
      articleIds: mergedRaw.map(item => item.article_id || item.id).filter(Boolean),
      normalizedArticleIds: [...new Set([...rawArticles, ...normalized].map(item => item.article_id || item.id).filter(Boolean))],
      lastRunAt: new Date().toISOString(),
      lastStatus: 'success',
      lastFetchedCount: fetched.length,
      lastNewCount: newArticles.length,
      lastAcceptedCount: accepted.length,
      lastPendingCount: pending.length
    };
    await rawRepository.write(mergedRaw);
    await queueRepository.write(mergedQueue);
    await stateStore.write(nextState);
    const previousContent = await contentRepository.read();
    const content = mergeAcceptedContent(previousContent, accepted, nextState);
    await contentRepository.write(content);

    return {
      fetchedCount: fetched.length,
      newCount: newArticles.length,
      acceptedCount: accepted.length,
      pendingCount: pending.length,
      accepted,
      pending,
      dataFiles: {
        raw: rawRepository.filePath,
        reviewQueue: queueRepository.filePath,
        state: stateStore.filePath
      }
    };
  }

  return { syncOnce };
}

function mergeById(items, idField) {
  const map = new Map();
  items.forEach(item => {
    const id = item && item[idField];
    if (id) map.set(id, item);
  });
  return [...map.values()];
}

function mergeAcceptedContent(previousContent, accepted, syncState) {
  const previous = previousContent && typeof previousContent === 'object' && !Array.isArray(previousContent)
    ? previousContent
    : {};
  const acceptedItems = (Array.isArray(accepted) ? accepted : [])
    .filter(item => item && item.article && Array.isArray(item.stores));
  const articles = mergeById([
    ...(Array.isArray(previous.articles) ? previous.articles : []),
    ...acceptedItems.map(item => item.article)
  ], 'id');
  const stores = mergeById([
    ...(Array.isArray(previous.stores) ? previous.stores : []),
    ...acceptedItems.flatMap(item => item.stores)
  ], 'id');

  return {
    articles,
    stores,
    goods: Array.isArray(previous.goods) ? previous.goods : [],
    generatedAt: new Date().toISOString(),
    syncState
  };
}

module.exports = { createJsonRepository, createSyncService, mergeAcceptedContent };
