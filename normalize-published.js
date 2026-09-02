const { normalizeArticleInput } = require('./article-import');

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function toDate(value) {
  if (!value) return '';
  if (typeof value === 'number') return new Date(value * 1000).toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function flattenNewsItems(item) {
  const nested = item && item.content && item.content.news_item;
  const direct = item && item.news_item;
  const items = nested || direct || item;
  return toArray(items).filter(Boolean);
}

function normalizePublishedItem(item, index, childIndex = 0) {
  const news = flattenNewsItems(item)[childIndex] || {};
  const baseId = item.article_id || item.articleId || `wechat-${index}`;
  const articleId = childIndex ? `${baseId}-${childIndex + 1}` : baseId;
  const title = news.title || item.title || '';
  const url = news.url || item.url || '';
  const cover = news.thumb_url || news.thumbUrl || item.thumb_url || '';
  const summary = news.digest || item.digest || '';
  const publishedAt = toDate(item.update_time || item.publish_time || item.publishedAt);

  const normalized = normalizeArticleInput({
    id: articleId,
    title,
    url,
    cover,
    summary,
    publishedAt,
    city: item.city || '',
    area: item.area || '',
    storeIds: item.storeIds || item.storeId || [],
    storeProfiles: item.storeProfiles || item.storeProfile || []
  });
  return { ...normalized, sourceArticleId: baseId };
}

function normalizePublishedList(items) {
  const result = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const newsItems = flattenNewsItems(item);
    const count = Math.max(newsItems.length, 1);
    for (let childIndex = 0; childIndex < count; childIndex += 1) {
      result.push(normalizePublishedItem(item, index, childIndex));
    }
  });
  return result;
}

module.exports = { normalizePublishedItem, normalizePublishedList, flattenNewsItems };
