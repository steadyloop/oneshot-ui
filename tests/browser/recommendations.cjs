/* Isolated browser storage and intercepted APIs; never writes real applications. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/chris/Documents/GitHub/portfolio/node_modules/playwright');
const origin = process.env.ONESHOT_URL || 'http://127.0.0.1:8766';
const makeJob = n => ({ id:n,rank:n,aliases:n===1 ? [1001] : [],company:`Test Company ${n}`,title:'Backend Software Intern',category:'Backend',term:n===2 ? 'Winter / Spring 2027' : 'Summer 2027',location:'San Diego, CA',fit:1,view:'ready',reason:'Python and PostgreSQL backend ingestion matches OneShot.',evidence:'Undergraduate CS students with a term after the internship.',date_basis:'employer',posted_day:'2026-10-05',link_state:'verified',apply_url:`https://example.com/jobs/${n}`,skills:['python','postgresql'],conditions:[] });
const data = {metrics:{recent_universe:14866,ready:65,conditional:1,excluded:1},methodology:['A reviewed 20-day snapshot.'],jobs:[...Array.from({length:65},(_,i)=>makeJob(i+1)),{...makeJob(66),view:'conditional',conditions:['Extend graduation to May 2028']},{...makeJob(67),view:'unverified',date_basis:'discovery'},{...makeJob(68),view:'excluded',reason:'Requires a PhD'}]};

(async()=>{
  const browser = await chromium.launch({headless:true});
  const errors=[];
  const guest = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await guest.newPage();page.on('pageerror',error=>errors.push(error.message));
  const guestRequests=[];
  await page.route('**/recommendations/data.json',route=>route.fulfill({json:data}));
  await page.route('**/api/**',route=>{guestRequests.push(route.request().method()+' '+new URL(route.request().url()).pathname);return route.fulfill({status:401,json:{detail:'Guest'}})});
  await page.goto(`${origin}/static/recommendations/index.html`);
  await page.locator('[data-add="1"]:enabled').waitFor();
  assert.equal(await page.locator('article.job').count(),50);
  await page.getByRole('button',{name:'Show next 15 jobs'}).click();assert.equal(await page.locator('article.job').count(),65);
  await page.locator('[data-add="1"]').click();
  await page.locator('#toast').getByRole('button',{name:'Undo',exact:true}).waitFor();
  assert.equal(await page.locator('#job-1').count(),0);
  let apps=await page.evaluate(()=>JSON.parse(localStorage.getItem('oneshot.visitor-data.state.v1')).applications);
  assert.equal(apps.length,1);assert.equal(apps[0].job_id,1);assert.equal(apps[0].stage,'applied');
  assert.deepEqual(guestRequests,['GET /api/auth/me']);
  await page.locator('#toast').getByRole('button',{name:'Undo',exact:true}).click();
  await page.locator('[data-add="1"]:enabled').waitFor();
  apps=await page.evaluate(()=>JSON.parse(localStorage.getItem('oneshot.visitor-data.state.v1')).applications);assert.equal(apps.length,0);
  await page.locator('#term').selectOption('winter');assert.equal(await page.locator('article.job').count(),1);
  await page.locator('#term').selectOption('');
  await page.locator('#search').fill('postgresql');assert.match(await page.locator('#result-count').innerText(),/^65 /);
  await page.locator('[data-view="conditional"]').click();assert.match(await page.locator('#job-66').innerText(),/Extend graduation/);
  assert.equal(new URL(page.url()).searchParams.get('view'),'conditional');
  await page.locator('[data-view="unverified"]').click();assert.equal(await page.locator('[data-add]').count(),0);
  await page.locator('[data-view="excluded"]').click();assert.equal(await page.locator('[data-add]').count(),0);
  await page.locator('[data-view="ready"]').click();
  const downloadPromise=page.waitForEvent('download');await page.locator('#download').click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/ready.csv$/);
  const dir=path.resolve(__dirname,'../../build/recommendations-qa');await fs.mkdir(dir,{recursive:true});
  await page.screenshot({path:path.join(dir,'desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(dir,'mobile.png')});
  await guest.close();

  const signed = await browser.newContext();const accountPage=await signed.newPage();accountPage.on('pageerror',error=>errors.push(error.message));
  const requests=[];let currentApps=[{id:900,job_id:1001}];let failWrite=true;
  await accountPage.route('**/recommendations/data.json',route=>route.fulfill({json:data}));
  await accountPage.route('**/api/**',route=>{
    const req=route.request(),p=new URL(req.url()).pathname;requests.push([req.method(),p,req.postDataJSON()]);
    if(p==='/api/auth/me')return route.fulfill({json:{name:'Test User'}});
    if(p==='/api/applications')return route.fulfill({json:{applications:currentApps}});
    if(p==='/api/jobs/2/applications') {
      if(failWrite)return route.fulfill({status:503,json:{detail:'Temporary failure'}});
      const app={id:901,job_id:2,stage:'applied'};currentApps.push(app);return route.fulfill({json:app});
    }
    if(p==='/api/applications/901'&&req.method()==='DELETE'){currentApps=currentApps.filter(a=>a.id!==901);return route.fulfill({status:204});}
    throw Error('Unexpected API '+p);
  });
  await accountPage.goto(`${origin}/static/recommendations/index.html`);await accountPage.locator('[data-add="2"]:enabled').waitFor();
  assert.equal(await accountPage.locator('#job-1').count(),0,'aliases already applied are hidden');
  await accountPage.locator('[data-add="2"]').click();await accountPage.getByText('Could not save: Temporary failure').waitFor();
  await accountPage.locator('[data-add="2"]:enabled').waitFor();assert.equal(currentApps.length,1);
  failWrite=false;await accountPage.locator('[data-add="2"]').click();await accountPage.locator('#toast').getByRole('button',{name:'Undo',exact:true}).waitFor();
  assert.equal(await accountPage.locator('#job-2').count(),0);
  const post=requests.find(r=>r[0]==='POST');assert.equal(post[1],'/api/jobs/2/applications');assert.match(post[2].submitted_at,/^\d{4}-\d{2}-\d{2}$/);
  await accountPage.locator('#toast').getByRole('button',{name:'Undo',exact:true}).click();await accountPage.locator('[data-add="2"]:enabled').waitFor();assert.equal(currentApps.length,1);
  assert.deepEqual(errors,[]);await signed.close();await browser.close();
  console.log('PASS: ranked pagination, guest persistence, signed-in transport, duplicate tracking, failed save recovery, Undo, filters, CSV, and mobile overflow. No real application writes.');
})().catch(error=>{console.error(error);process.exit(1)});
