const ARTICLE_URL_PATTERN = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/;
const PLACEHOLDER_PATTERN = /example|placeholder|待补|示例/i;

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeStoreProfile(profile, article, storeId) {
  const item = profile || {};
  return {
    id: item.id || storeId,
    storeId: item.storeId || storeId,
    city: item.city || article.city || '',
    area: item.area || article.area || '',
    name: item.name || '',
    category: item.category || '待分类',
    scenes: toArray(item.scenes),
    price: Number(item.price) || 0,
    address: item.address || '',
    recommendation: item.recommendation || article.summary || '',
    note: item.note || article.summary || '',
    businessHours: item.businessHours || '',
    latitude: Number(item.latitude) || 0,
    longitude: Number(item.longitude) || 0
  };
}

function normalizeArticleInput(input) {
  const source = input || {};
  const profiles = toArray(source.storeProfiles || source.storeProfile);
  const profileIds = profiles.map(item => item && (item.id || item.storeId));
  const storeIds = toArray(source.storeIds || source.storeId || profileIds);
  const normalized = {
    id: source.id || '',
    title: String(source.title || '').trim(),
    city: String(source.city || '').trim(),
    area: String(source.area || '').trim(),
    cover: source.cover || '',
    url: String(source.url || '').trim(),
    publishedAt: source.publishedAt || '',
    summary: String(source.summary || '').trim(),
    videoUrl: String(source.videoUrl || '').trim(),
    videoFinderUserName: String(source.videoFinderUserName || '').trim(),
    videoFeedId: String(source.videoFeedId || '').trim(),
    storeIds: [...new Set(storeIds.map(String).filter(Boolean))]
  };
  normalized.storeId = normalized.storeIds[0] || '';
  normalized.storeProfiles = normalized.storeIds.map((storeId, index) => {
    const profile = profiles.find(item => item && (item.id === storeId || item.storeId === storeId)) || profiles[index] || {};
    return normalizeStoreProfile(profile, normalized, storeId);
  });
  normalized.storeProfile = normalized.storeProfiles[0] || null;
  normalized.storeCount = normalized.storeIds.length;
  return normalized;
}

function validateArticleInput(input) {
  const article = normalizeArticleInput(input);
  const errors = [];
  const warnings = [];
  if (!article.id) errors.push('缺少文章 id');
  if (!article.title) errors.push('缺少文章标题');
  if (!article.city) errors.push('缺少城市');
  if (!ARTICLE_URL_PATTERN.test(article.url) || PLACEHOLDER_PATTERN.test(article.url)) errors.push('文章链接不是已发布的真实公众号文章链接');
  if (!article.storeIds.length) errors.push('文章没有关联门店');
  if (article.storeProfiles.some(item => !item.name)) errors.push('至少有一家门店缺少名称');
  if (article.storeProfiles.some(item => !item.address)) warnings.push('部分门店缺少地址');
  return { valid: errors.length === 0, errors, warnings, article };
}

function buildStoreRecords(articleInput) {
  const result = validateArticleInput(articleInput);
  if (!result.valid) return { ...result, stores: [] };
  const article = result.article;
  const stores = article.storeProfiles.map(profile => ({
    ...profile,
    articleId: article.id,
    articleTitle: article.title,
    articleUrl: article.url,
    videoTitle: article.videoUrl ? `视频号：${article.title}` : '',
    videoUrl: article.videoUrl,
    videoFinderUserName: article.videoFinderUserName,
    videoFeedId: article.videoFeedId,
    status: '已收录'
  }));
  return { ...result, stores };
}

module.exports = { normalizeArticleInput, buildStoreRecords };
