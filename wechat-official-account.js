const API_BASE = 'https://api.weixin.qq.com';

class WechatApiError extends Error {
  constructor(message, payload, status) {
    super(message);
    this.name = 'WechatApiError';
    this.payload = payload;
    this.status = status || 0;
    this.code = payload && payload.errcode ? payload.errcode : 'WECHAT_API_ERROR';
  }
}

class OfficialAccountClient {
  constructor(options = {}) {
    this.appId = options.appId || process.env.WECHAT_OFFICIAL_APPID || '';
    this.appSecret = options.appSecret || process.env.WECHAT_OFFICIAL_APPSECRET || '';
    this.apiBase = options.apiBase || API_BASE;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  assertCredentials() {
    if (!this.appId || !this.appSecret) {
      throw new Error('缺少 WECHAT_OFFICIAL_APPID 或 WECHAT_OFFICIAL_APPSECRET');
    }
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.errcode) {
      throw new WechatApiError(
        payload.errmsg || `微信接口请求失败：HTTP ${response.status}`,
        payload,
        response.status
      );
    }
    return payload;
  }

  async getAccessToken() {
    this.assertCredentials();
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const query = new URLSearchParams({
      grant_type: 'client_credential',
      appid: this.appId,
      secret: this.appSecret
    });
    const payload = await this.request(`/cgi-bin/token?${query.toString()}`);
    this.token = payload.access_token;
    this.tokenExpiresAt = now + Math.max(60, Number(payload.expires_in || 7200) - 300) * 1000;
    return this.token;
  }

  async listPublishedMessages(options = {}) {
    const accessToken = await this.getAccessToken();
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    const count = Math.min(20, Math.max(1, Number(options.count || 20)));
    const noContent = options.noContent ? 1 : 0;
    return this.request(`/cgi-bin/freepublish/batchget?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      body: { offset, count, no_content: noContent }
    });
  }

  async getPublishedArticle(articleId) {
    if (!articleId) throw new Error('缺少 article_id');
    const accessToken = await this.getAccessToken();
    return this.request(`/cgi-bin/freepublish/get?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      body: { article_id: articleId }
    });
  }

  async listAllPublished(options = {}) {
    const pageSize = Math.min(20, Math.max(1, Number(options.pageSize || 20)));
    const maxPages = Math.max(1, Number(options.maxPages || 100));
    const all = [];
    let offset = Number.isInteger(options.offset) ? options.offset : 0;

    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.listPublishedMessages({
        offset,
        count: pageSize,
        noContent: Boolean(options.noContent)
      });
      const items = Array.isArray(payload.item) ? payload.item : [];
      all.push(...items);
      if (items.length < pageSize) break;
      offset += items.length;
    }

    return all;
  }
}

module.exports = {
  API_BASE,
  WechatApiError,
  OfficialAccountClient
};
