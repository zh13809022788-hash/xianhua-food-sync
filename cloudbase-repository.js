'use strict';

// CloudBase 云存储 JSON 文档仓库。未配置环境 ID 时返回 null，供本地 JSON 回退使用。
function createCloudbaseRepository(options = {}) {
  const envId = options.envId || process.env.CLOUDBASE_ENV_ID || '';
  const documentId = options.documentId || 'content';
  const defaultValue = options.defaultValue;
  const bucket = String(options.bucket || process.env.CLOUDBASE_STORAGE_BUCKET || '')
    .trim();
  const prefix = String(options.storagePrefix || process.env.CLOUDBASE_STORAGE_PREFIX || '')
    .replace(/^\/+|\/+$/g, '');

  if (!envId) return null;

  let appPromise = null;

  async function getApp() {
    if (!appPromise) {
      appPromise = Promise.resolve().then(() => {
        let cloudbase;
        try {
          cloudbase = require('@cloudbase/js-sdk');
          require('@cloudbase/js-sdk/storage');
        } catch (error) {
          throw new Error('已配置 CLOUDBASE_ENV_ID，但 backend 未安装 @cloudbase/js-sdk');
        }
        return cloudbase.init({
          env: envId,
          accessKey: process.env.CLOUDBASE_APIKEY || undefined
        });
      });
    }
    return appPromise;
  }

  function cloudPath() {
    return prefix ? `${prefix}/${documentId}.json` : `${documentId}.json`;
  }

  function fileId() {
    const bucketPrefix = bucket ? `${bucket}/` : '';
    return `cloud://${envId}/${bucketPrefix}${cloudPath()}`;
  }

  async function read() {
    const app = await getApp();
    try {
      // PG 云存储使用桶内相对路径，不使用传统 cloud:// fileID。
      const result = await app.storage.from(bucket).download(cloudPath());
      if (result && result.error) throw result.error;
      const data = result && result.data;
      if (!data) return defaultValue;
      const text = typeof data.text === 'function'
        ? await data.text()
        : Buffer.from(data).toString('utf8');
      return JSON.parse(text);
    } catch (error) {
      if (isNotFound(error)) return defaultValue;
      throw error;
    }
  }

  async function write(value) {
    const app = await getApp();
    const fileContent = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    const result = await app.storage.from(bucket).upload(cloudPath(), fileContent, {
      contentType: 'application/json',
      upsert: true
    });
    if (result && result.error) throw result.error;
  }

  return { read, write, filePath: fileId(), cloudPath: cloudPath(), bucket };
}

function isNotFound(error) {
  const message = String(error && (error.message || error.errMsg) || '').toLowerCase();
  return message.includes('not found')
    || message.includes('does not exist')
    || message.includes('不存在')
    || message.includes('nosuchkey')
    || message.includes('no such key');
}

module.exports = { createCloudbaseRepository };
