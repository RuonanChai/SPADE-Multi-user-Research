import { chromium } from 'playwright';
console.log('chromium executable:', chromium.executablePath());
const b = await chromium.launch({ headless: true });
console.log('browser launched ok');
await b.close();
console.log('TEST PASS');
