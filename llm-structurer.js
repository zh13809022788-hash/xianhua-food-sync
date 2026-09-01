function createLlmExtractor(options = {}) {
  const endpoint = options.endpoint || process.env.CONTENT_STRUCTURER_URL || '';
  const apiKey = options.apiKey || process.env.CONTENT_STRUCTURER_API_KEY || '';
  const model = options.model || process.env.CONTENT_STRUCTURER_MODEL || '';

  if (!endpoint || !model) return null;

  return async function extract({ article, rawItem }) {
    const prompt = [
      '你是美食内容结构化助手。只从给定公众号文章内容中提取明确出现的门店，不得补写或猜测。',
      '返回严格 JSON，不要 Markdown：',
      '{"city":"","area":"","storeIds":[],"storeProfiles":[{"id":"","name":"","category":"","scenes":[],"price":0,"address":"","recommendation":"","note":"","businessHours":"","latitude":0,"longitude":0}],"videoUrl":"","videoFinderUserName":"","videoFeedId":""}',
      `文章标题：${article.title}`,
      `文章摘要：${article.summary}`,
      `文章正文：${extractBody(rawItem)}`
    ].join('\n');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '只输出合法 JSON。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`内容结构化服务失败：HTTP ${response.status}`);
    const text = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : payload.output || payload.content || payload;
    return parseJson(text);
  };
}

function extractBody(rawItem) {
  if (!rawItem) return '';
  const content = rawItem.content || {};
  const newsItems = content.news_item || rawItem.news_item || [];
  const first = Array.isArray(newsItems) ? newsItems[0] : newsItems;
  return first && (first.content || first.digest || first.title) || '';
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
  return JSON.parse(text);
}

module.exports = { createLlmExtractor, extractBody, parseJson };
