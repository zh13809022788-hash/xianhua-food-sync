'use strict';

function createCloudbaseRepository(options = {}) {
  const envId = options.envId || process.env.CLOUDBASE_ENV_ID || '';
  const collectionName = options.collectionName || process.env.CLOUDBASE_DATA_COLLECTION || 'xianhua_content';
  const documentId = options.documentId || 'content';
  const defaultValue = options.defaultValue;

  if (!envId) return null;

  let collectionPromise = null;

  async function getCollection() {
    if (!collectionPromise) {
      collectionPromise = Promise.resolve().then(() => {
        let cloudbase;
        try {
          cloudbase = require('@cloudbase/node-sdk');
        } catch (error) {
          throw new Error('已配置 CLOUDBASE_ENV_ID，但 backend 未安装 @cloudbase/node-sdk');
        }
        const app = cloudbase.init({ env: envId });
        return app.database().collection(collectionName);
      });
    }
    return collectionPromise;
  }

  async function read() {
    const collection = await getCollection();
    try {
      const result = await collection.doc(documentId).get();
      const record = Array.isArray(result.data) ? result.data[0] : result.data;
      return record && Object.prototype.hasOwnProperty.call(record, 'value')
        ? record.value
        : (record || defaultValue);
    } catch (error) {
      if (isNotFound(error)) return defaultValue;
      throw error;
    }
  }

  async function write(value) {
    const collection = await getCollection();
    await collection.doc(documentId).set({
      value,
      updatedAt: new Date().toISOString()
    });
  }

  return { read, write, filePath: `cloudbase://${collectionName}/${documentId}` };
}

function isNotFound(error) {
  const message = String(error && (error.message || error.errMsg) || '').toLowerCase();
  return message.includes('not found') || message.includes('does not exist') || message.includes('不存在');
}

module.exports = { createCloudbaseRepository };
