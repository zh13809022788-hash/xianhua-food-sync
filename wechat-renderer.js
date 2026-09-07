'use strict';

const { chromium } = require('playwright-core');

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    };
    if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    }
    browserPromise = chromium.launch(launchOptions).catch(error => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function renderOfficialArticle(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await renderOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}

async function renderOnce(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0'
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const result = await page.evaluate(() => {
      const title = document.querySelector('#activity-name')?.textContent
        || document.querySelector('h1')?.textContent
        || document.title;
      const content = document.querySelector('#js_content')?.innerHTML || '';
      const summary = document.querySelector('meta[name="description"]')?.content || '';
      const cover = document.querySelector('meta[property="og:image"]')?.content || '';
      return {
        title: String(title || '').replace(/\s+/g, ' ').trim(),
        content,
        summary: String(summary || '').trim(),
        cover: String(cover || '').trim(),
        pageTitle: document.title,
        bodyText: document.body?.innerText?.slice(0, 1000) || ''
      };
    });
    if (!result.content || !result.title || /微信公众平台|请在微信客户端打开|环境异常|访问过于频繁/i.test(`${result.pageTitle} ${result.bodyText}`)) {
      throw new Error('渲染后未取得有效公众号文章正文，可能触发微信限制页');
    }
    return result;
  } finally {
    await context.close();
  }
}

async function closeRenderer() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close();
}

module.exports = { renderOfficialArticle, closeRenderer };
