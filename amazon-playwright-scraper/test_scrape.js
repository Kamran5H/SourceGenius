const { chromium } = require('playwright');
const fs = require('fs');

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext();
  
  const page = await context.newPage();
  try {
    console.log('Navigating to Amazon Home Page...');
    await page.goto('https://www.amazon.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    console.log('Home Page Title:', await page.title());

    console.log('Searching via search input box...');
    // Try multiple selectors for the search input
    const searchSelector = await Promise.any([
      page.waitForSelector('#twotabsearchtextbox', { timeout: 5000 }).then(() => '#twotabsearchtextbox'),
      page.waitForSelector('input[name="field-keywords"]', { timeout: 5000 }).then(() => 'input[name="field-keywords"]'),
      page.waitForSelector('input[type="text"]', { timeout: 5000 }).then(() => 'input[type="text"]')
    ]).catch(() => null);

    if (!searchSelector) {
      throw new Error('Search input selector not found');
    }

    console.log(`Found selector: ${searchSelector}, typing query...`);
    await page.fill(searchSelector, 'clear under bed storage containers with handles');
    await page.press(searchSelector, 'Enter');
    
    console.log('Waiting for search results to load...');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log('Page Title:', title);

    const bodyText = await page.innerText('body');
    const isBlocked = /captcha|robot check|unusual traffic|automated query|automated request|verify you are human|not a robot|sorry!/i.test(title + ' ' + bodyText);
    console.log('Is Blocked/CAPTCHA?', isBlocked);

    const cardsCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-asin]').length;
    });
    console.log('Number of [data-asin] elements:', cardsCount);

    const sampleAsins = await page.evaluate(() => {
      const asins = [];
      document.querySelectorAll('[data-asin]').forEach(el => {
        const asin = el.getAttribute('data-asin');
        if (asin && asin.length >= 5) {
          asins.push(asin);
        }
      });
      return asins.slice(0, 10);
    });
    console.log('Sample ASINs found:', sampleAsins);

  } catch (err) {
    console.error('Error during execution:', err);
    const html = await page.content();
    fs.writeFileSync('error_page.html', html, 'utf-8');
    console.log('Saved error page HTML to error_page.html');
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
