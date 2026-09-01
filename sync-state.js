const fs = require('node:fs/promises');
const path = require('node:path');

function createSyncStateStore(filePath) {
  const target = filePath || path.join(__dirname, 'data', 'sync-state.json');

  async function read() {
    try {
      const raw = await fs.readFile(target, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { lastOffset: 0, articleIds: [], lastRunAt: null, lastStatus: 'never' };
      }
      throw error;
    }
  }

  async function write(state) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  return { read, write, filePath: target };
}

module.exports = { createSyncStateStore };
