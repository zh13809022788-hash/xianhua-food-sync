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

  const apiKey = String(process.env.CLOUDBASE_APIKEY || '').trim();
  const gatewayBase = String(
    process.env.CLOUDBASE_STORAGE_API_BASE
      || `https://${envId}.api.tcloudbasegateway.com`
  ).replace(/\/+$/, '');

  function objectUrl() {
    const encodedBucket = encodeURIComponent(bucket);
    const encodedPath = cloudPath().split('/').map(encodeURIComponent).join('/');
    return `${gatewayBase}/v1/storages/object/${encodedBucket}/${encodedPath}`;
  }

  async function requestObject(method, body, contentType) {
    if (!bucket) throw new Error('未配置 CLOUDBASE_STORAGE_BUCKET');
    if (!apiKey) throw new Error('未配置 CLOUDBASE_APIKEY');
    const headers = {
      authorization: `Bearer ${apiKey}`
    };
    if (body) {
      headers['content-type'] = contentType || 'application/octet-stream';
      headers['content-length'] = String(body.length);
    }
    const result = await fetch(objectUrl(), { method, headers, body });
    const buffer = Buffer.from(await result.arrayBuffer());
    if (!result.ok) {
      const detail = buffer.toString('utf8').slice(0, 500);
      throw new Error(`CloudBase storage ${method} ${result.status}: ${detail}`);
    }
    return buffer;
  }

  function cloudPath() {
    return prefix ? `${prefix}/${documentId}.json` : `${documentId}.json`;
  }

  function fileId() {
    const bucketPrefix = bucket ? `${bucket}/` : '';
    return `cloud://${envId}/${bucketPrefix}${cloudPath()}`;
  }

  async function read() {
    try {
      const buffer = await requestObject('GET');
      return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      if (isNotFound(error)) return defaultValue;
      throw error;
    }
  }

  async function write(value) {
    const fileContent = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    await requestObject('PUT', fileContent, 'application/json');
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
