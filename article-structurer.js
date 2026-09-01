const { buildStoreRecords } = require('../utils/article-import');

function createArticleStructurer(options = {}) {
  const extractor = options.extractor || defaultExtractor;

  async function structure(article, rawItem) {
    const extracted = await extractor({ article, rawItem });
    const candidate = {
      ...article,
      city: extracted.city || article.city,
      area: extracted.area || article.area,
      storeIds: extracted.storeIds || [],
      storeProfiles: extracted.storeProfiles || [],
      videoUrl: extracted.videoUrl || article.videoUrl,
      videoFinderUserName: extracted.videoFinderUserName || article.videoFinderUserName,
      videoFeedId: extracted.videoFeedId || article.videoFeedId
    };
    return buildStoreRecords(candidate);
  }

  return { structure };
}

async function defaultExtractor() {
  return {
    storeIds: [],
    storeProfiles: []
  };
}

module.exports = { createArticleStructurer, defaultExtractor };
