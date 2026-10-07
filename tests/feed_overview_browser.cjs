const assert = require('node:assert/strict');
// Run with Playwright installed: ONESHOT_TEST_ORIGIN=http://127.0.0.1:8766 node tests/feed_overview_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ONESHOT_TEST_ORIGIN || 'http://127.0.0.1:8766';
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport:{width:1440,height:1000}, timezoneId:'America/Los_Angeles'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Buffer the real response here: the large board map can exceed Chromium's inspector cache.
  let payload;
  await page.route('**/api/source-coverage/boards', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    payload = await response.json();
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/source-coverage/`);
  await page.locator('#coverage-content canvas').first().waitFor();
  await page.locator('.classification-summary:not([hidden])').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const detail = payload.today_breakdown;
  assert(detail && payload.classification);
  const eligibleProviders = payload.providers.filter(p => p.boards.length)
    .sort((a, b) => b.discover_jobs - a.discover_jobs || a.source.localeCompare(b.source));
  assert(eligibleProviders.every(p => Number.isInteger(p.discover_jobs)));
  const expectedProviders = eligibleProviders.slice(0, 6).map(p => p.source);
  assert.deepEqual(await page.locator('.wall > .band[data-band]').evaluateAll(bands => bands.map(b => b.dataset.band)), expectedProviders);
  assert.equal(await page.locator('.tail-toggle strong').evaluate(el => el.firstChild.textContent.trim()), "Other");
  assert.equal(await page.locator('.provider-count').innerText(), String(eligibleProviders.length - 6));
  assert.equal(await page.locator('.tail-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.provider-row').count(), 0);
  const fmt = n => new Intl.NumberFormat('en-US').format(n);
  assert.equal(payload.totals.active_postings, payload.classification.total);
  assert.equal(await page.locator('#fleet-stats strong').nth(2).innerText(), fmt(payload.classification.total));
  assert.equal(await page.locator('.classification-total').innerText(), fmt(payload.classification.total));
  assert.match(await page.locator('.classification-summary').innerText(), /active job postings/);
  assert.equal((await page.locator('#today-line').innerText()).replace(/\s+/g, ' '), `${fmt(detail.total)} jobs posted, ${fmt(detail.disappeared.total)} jobs closed today`);
  const categories = [['internships','intern'],['co-ops','coop'],['student jobs','student'],['new grad','new_grad'],['research','research'],['unclassified','unclassified']];
  const signed = (value, sign) => value == null ? '—' : `${value === 0 ? '' : sign}${fmt(value)}`;
  assert.deepEqual(await page.locator('.today-table tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => ({value:cell.querySelector('.activity-number').textContent,category:cell.querySelector('.activity-category').textContent})))),
    categories.map(([label,key]) => [{value:signed(detail.types[key],'+'),category:label},{value:signed(detail.disappeared.types[key],'−'),category:label}]));
  const layouts = [];
  for (const width of [320,390,768,1024,1440,2208]) {
    await page.setViewportSize({width,height:1000});
    await page.waitForTimeout(150);
    await page.locator('.ticker-toggle').hover();
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.workspace');
      const footer = document.querySelector('.classification-footer');
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,bottom:r.bottom,right:r.right}; };
      const card=document.querySelector('#ticker-card');
      const line=document.querySelector('#today-line');
      const posted=line.querySelector('.activity-added').getBoundingClientRect();
      const closed=line.querySelector('.activity-disappeared').getBoundingClientRect();
      const measure=document.createElement('canvas').getContext('2d');
      const lineFont=getComputedStyle(line);
      measure.font=`${lineFont.fontWeight} ${lineFont.fontSize} ${lineFont.fontFamily}`;
      return {width:innerWidth,docWidth:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight,
        main:rect(main),rail:rect(document.querySelector('.sidebar')),footer:rect(footer),tail:rect(document.querySelector('.tail-toggle')),card:rect(card),
        paddingLeft:getComputedStyle(main).paddingLeft,paddingBottom:getComputedStyle(main).paddingBottom,
        trigger:rect(document.querySelector('.ticker-toggle')),table:rect(document.querySelector('.today-table')),
        naturalSentence:Math.abs((closed.left-posted.right)-measure.measureText(' jobs posted, ').width)<1,
        headerHeight:document.querySelector('.today-table thead').getBoundingClientRect().height,
        noteFont:getComputedStyle(document.querySelector('.dedup-note')).fontFamily,
        countFont:getComputedStyle(document.querySelector('.activity-number')).fontFamily,
        categoryFont:getComputedStyle(document.querySelector('.activity-category')).fontFamily,
        headlineFont:lineFont.fontFamily,
        paneTypography:[...document.querySelectorAll('.today-table tbody td')].every(cell=>{
          const value=cell.querySelector('.activity-number'),label=cell.querySelector('.activity-category'),font=getComputedStyle(label);
          return font.fontWeight==='600' && font.fontSize==='11px' && label.getBoundingClientRect().left-value.getBoundingClientRect().right>=7.9;
        }),
        textFits:[...document.querySelectorAll('.today-table tbody td, .activity-category')].every(c=>c.scrollWidth<=c.clientWidth),
        aligned:[...document.querySelectorAll('.today-table tbody tr')].every(row=>[...row.querySelectorAll('.activity-number')].every((value,index)=>Math.abs(value.getBoundingClientRect().right-document.querySelectorAll('#today-line .activity-total')[index].getBoundingClientRect().right)<1)),
        weights:[...document.querySelectorAll('.activity-number')].map(c=>getComputedStyle(c).fontWeight),
        tickerColor:getComputedStyle(document.querySelector('.ticker-toggle')).color,
        unitColor:getComputedStyle(document.querySelector('.today-table .activity-category')).color,
        numberColor:getComputedStyle(document.querySelector('.activity-added .activity-number')).color,
      };
    });
    assert.equal(layout.docWidth,width,`page fits: ${JSON.stringify(layout)}`);
    assert(layout.card.x>=0 && layout.card.right<=width,`card fits ${width}`);
    assert(layout.textFits,`table text fits ${width}: ${JSON.stringify(layout)}`);
    assert(layout.aligned,`Breakdown values align under headline totals at ${width}`);
    assert(layout.headerHeight <= 1, 'Header row is hidden');
    assert(layout.table.right <= layout.card.right - 10, 'Table fits inside pane');
    assert.equal(layout.noteFont, layout.countFont);
    assert.equal(layout.categoryFont, layout.headlineFont, 'Category labels match the headline font');
    assert.equal(layout.countFont, layout.headlineFont, 'Pane numbers match the headline font');
    assert(layout.paneTypography,'Pane uses smaller bold text with space after each number');
    assert(layout.naturalSentence,'Headline uses normal text spacing');
    assert(layout.card.y>=layout.trigger.bottom+7,'Pane sits below the compact sentence');
    assert(layout.footer.y-layout.tail.bottom>=64,`footer separation ${width}`);
    assert(Math.abs(layout.footer.bottom-(layout.docHeight-parseFloat(layout.paddingBottom)))<2,`footer at bottom: ${JSON.stringify(layout)}`);
    if(width>760) assert.equal(layout.main.x,layout.rail.right,'main starts immediately beside rail');
    assert(layout.weights.every(w=>w==='600'));
    assert.notEqual(layout.numberColor,layout.unitColor);
    assert.equal(layout.tickerColor,layout.unitColor);
    layouts.push({width,footerBottom:layout.footer.bottom,pageHeight:layout.docHeight,paddingLeft:layout.paddingLeft});
    await page.locator('h1').hover();
  }
  await page.setViewportSize({width:2208,height:1800});
  await page.waitForTimeout(150);
  const footer = await page.locator('.classification-footer').boundingBox();
  assert(Math.abs(footer.y + footer.height - 1776) < 2, 'Footer stays at the viewport bottom with spare space');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.ticker-toggle').focus(); await page.keyboard.press('Enter');
  assert(await page.locator('#ticker-card').isVisible());
  await page.keyboard.press('Escape'); assert(!(await page.locator('#ticker-card').isVisible()));
  await page.locator('.ticker-toggle').hover();
  const ticker=await page.locator('#ticker').boundingBox(); const card=await page.locator('#ticker-card').boundingBox();
  await page.mouse.move(card.x+40,ticker.y+ticker.height+4);
  assert(await page.locator('#ticker-card').isVisible());
  await page.locator('#ticker-card').hover(); assert(await page.locator('#ticker-card').isVisible());
  await page.locator('h1').click(); assert(!(await page.locator('#ticker-card').isVisible()));
  await page.locator('.tail-toggle').click(); assert.equal(await page.locator('.tail-toggle').getAttribute('aria-expanded'),'true');
  await page.locator('.classification-footer').scrollIntoViewIfNeeded();
  assert(await page.locator('.classification-footer').isVisible());
  const phone=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await phone.goto(`${origin}/source-coverage/`);
  await phone.locator('#coverage-content canvas').first().waitFor();
  await phone.locator('.ticker-toggle').tap(); assert(await phone.locator('#ticker-card').isVisible());
  await phone.locator('h1').tap(); assert(!(await phone.locator('#ticker-card').isVisible()));
  const fallback=await browser.newPage({viewport:{width:320,height:844}});
  const fixture={...payload,providers:[{source:'demo',discover_jobs:1,boards:[{key:'demo',state:'ok',coverage:1}]}],
    totals:{boards:1,providers:1,added_today:1234567},
    today_breakdown:{types:{intern:1234567,coop:0}}};
  await fallback.route('**/api/source-coverage/boards',route=>route.fulfill({json:fixture}));
  await fallback.goto(`${origin}/source-coverage/`);
  await fallback.locator('#coverage-content canvas').first().waitFor();
  await fallback.locator('.ticker-toggle').hover();
  assert.equal(await fallback.locator('.today-table .activity-added .activity-number').nth(1).innerText(),'0','Measured zero has no sign');
  assert((await fallback.locator('.today-table .activity-disappeared .activity-number').allTextContents()).every(value=>value==='—'),'Unknown closures stay unknown');
  assert.equal(await fallback.locator('.today-table .activity-added .activity-number').first().innerText(),'+1,234,567');
  assert(await fallback.evaluate(()=>{
    const headline=document.querySelector('#today-line .activity-total').getBoundingClientRect().right;
    return document.documentElement.scrollWidth===innerWidth && [...document.querySelectorAll('.today-table .activity-added .activity-number')].every(value=>Math.abs(value.getBoundingClientRect().right-headline)<1);
  }),'Large counts still fit and align on mobile');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',layouts,interactions:['hover bridge','keyboard','Escape','outside click','touch','expand providers'],classification:payload.classification,topProviders:expectedProviders},null,2));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
