'use strict';

// PostgreSQL 环境不提供文档型数据库，因此用 CloudBase 云存储保存 JSON 文档。
function createCloudbaseRepository(options = {}) {
  const envId = options.envId || process.env.CLOUDBASE_ENV_ID || '';
  const documentId = options.documentId || 'content';
  const defaultValue = options.defaultValue;
  const prefix = String(options.storagePrefix || process.env.CLOUDBASE_STORAGE_PREFIX || 'xianhua-content')
    .replace(/^\/+|\/+$/g, '');

  if (!envId) return null;

  let appPromise = null;

  async function getApp() {
    if (!appPromise) {
      appPromise = Promise.resolve().then(() => {
        let cloudbase;
        try {
          cloudbase = require('@cloudbase/node-sdk');
        } catch (error) {
          throw new Error('已配置 CLOUDBASE_ENV_ID，但 backend 未安装 @cloudbase/node-sdk');
        }
        return cloudbase.init({ env: envId });
      });
    }
    return appPromise;
  }

  function cloudPath() {
    return `${prefix}/${documentId}.json`;
  }

  function fileId() {
    return `cloud://${envId}/${cloudPath()}`;
  }

  async function read() {
    const app = await getApp();
    try {
      const result = await app.downloadFile({ fileID: fileId() });
      const buffer = result && (result.fileContent || result.fileData || result.data);
      if (!buffer) return defaultValue;
      return JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer));
    } catch (error) {
      if (isNotFound(error)) return defaultValue;
      throw error;
    }
  }

  async function write(value) {
    const app = await getApp();
    const fileContent = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    await app.uploadFile({
      cloudPath: cloudPath(),
      fileContent
    });
  }

  return { read, write, filePath: fileId(), cloudPath: cloudPath() };
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
