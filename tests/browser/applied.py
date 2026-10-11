"""Browser integration checks. Run with Playwright and Chromium installed.

Serves local files and mocks identity only; guest writes use the actual shared
OneShotAPI/OneShotVisitorData transport. No production records are touched.
"""
import asyncio
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2] / 'web'
ARTIFACTS = Path('/private/tmp/oneshot-tracker-browser')
KEY = 'oneshot.visitor-data.state.v1'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/'):
            payload, code = ({'detail': 'Not signed in'}, 401) if self.path.startswith('/api/auth/me') else ({'jobs': [], 'total': 0}, 200)
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(payload).encode()); return
        if self.path.startswith('/static/'):
            self.path = self.path.removeprefix('/static')
        elif self.path.startswith('/application/'):
            self.path = '/applied/' + self.path.removeprefix('/application/')
        super().do_GET()

    def log_message(self, *args):
        pass


async def idle(page):
    await expect(page.locator('#workspace')).to_have_attribute('aria-busy', 'false')


async def counts(page):
    return [int(await page.locator(f'#count-{key}').inner_text()) for key in ('pipeline', 'sent', 'closed')]


async def undo(page):
    await page.locator('#toast button').click(); await idle(page)


async def stored(page):
    return await page.evaluate('(key) => JSON.parse(localStorage.getItem(key)).applications', KEY)


async def main():
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context(viewport={'width': 1600, 'height': 1000}, timezone_id='America/Los_Angeles')
        page = await context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(origin + '/application/'); await idle(page)
        assert await counts(page) == [0, 0, 0]
        assert await page.locator('.column').count() == 4
        assert await page.locator('.column-head h2').all_text_contents() == ['Replied', 'Assessment', 'Interview', 'Offer']
        assert await page.locator('.column-head .count').all_text_contents() == ['0'] * 4
        assert await page.locator('#panel .empty-state, .column-empty').count() == 0
        # Seed canonical records directly; design archives are not test fixtures.
        await page.evaluate('''key => {
          const oldDate = new Date();
          oldDate.setDate(oldDate.getDate() - 60);
          const submittedAt = oldDate.toISOString().slice(0, 10);
          const stages = ['replied', 'assessment', 'interview', 'offer'];
          const rows = (count, prefix, stageFor) => Array.from({ length: count }, (_, i) => {
            const stage = stageFor(i);
            const active = stages.includes(stage);
            return { id: `${prefix}-${i}`, external: true, company: `Test Company ${prefix} ${i}`,
              title: `Engineering Intern ${i}`, stage, submitted_at: submittedAt,
              last_open_stage: stage === 'closed' ? 'applied' : stage,
              closed_reason: stage === 'closed' ? 'withdrawn' : null,
              task_state: active ? 'action' : 'waiting', waiting_for: '',
              next_action: active ? 'Prepare for next step' : null, next_due_at: null, events: [] };
          });
          const applications = [
            ...rows(12, 'pipeline', i => stages[i % stages.length]),
            ...rows(320, 'submitted', () => 'applied'),
            ...rows(18, 'closed', () => 'closed'),
          ];
          localStorage.setItem(key, JSON.stringify({ applications, jobs: [], nextApplicationId: 1, applicationIdPrefix: 'visitor-app', feedback: [] }));
        }''', KEY)
        await page.reload(); await idle(page)
        assert await counts(page) == [12, 320, 18]
        await page.locator('#search').fill('no-such-reply')
        assert await page.locator('.column').count() == 4
        assert await page.locator('.column-head .count').all_text_contents() == ['0'] * 4
        assert await page.locator('#panel .empty-state').count() == 0
        assert await counts(page) == [12, 320, 18]
        await page.locator('#search').fill('')
        # Adding, optional URL, response and Undo persist through the shared transport.
        await page.get_by_role('button', name='Add application', exact=True).click()
        await page.locator('#log-form [name=company]').fill('Browser Test Co')
        await page.locator('#log-form [name=role]').fill('Software Engineering Intern')
        await page.locator('#log-form button[type=submit]').click(); await idle(page)
        assert await counts(page) == [12, 321, 18]
        new_id = next(a['id'] for a in await stored(page) if a['company'] == 'Browser Test Co')
        await page.locator(f'[data-response="{new_id}"]').click()
        await page.locator('#response-form [value=assessment]').check()
        await page.locator('#response-form [name=nextAction]').fill('Finish test challenge')
        await page.locator('#response-form [name=nextDue]').fill('2026-10-05')
        await page.locator('#response-submit').click(); await idle(page)
        assert await counts(page) == [13, 320, 18]
        await undo(page); assert await counts(page) == [12, 321, 18]
        restored = next(a for a in await stored(page) if a['id'] == new_id)
        assert restored['next_action'] is None and restored['next_due_at'] is None
        await page.locator('#tab-sent').click()
        await page.locator(f'[data-response="{new_id}"]').click()
        await page.locator('#response-form [name=nextAction]').fill('Send availability')
        await page.locator('#response-submit').click(); await idle(page)
        await page.locator(f'[data-open="{new_id}"]').click(); await idle(page)
        await expect(page.locator('#drawer')).to_be_visible()
        await page.locator('#detail-stage').select_option('offer')
        await page.locator('#detail-form button[type=submit]').click(); await idle(page)
        await expect(page.locator(f'[data-drop=offer] [data-open="{new_id}"]')).to_be_visible()
        # Drop highlight covers only the column body; native drop persists a stage change.
        card = page.locator(f'[data-open="{new_id}"]')
        transfer = await page.evaluate_handle('new DataTransfer()')
        await card.dispatch_event('dragstart', {'dataTransfer': transfer})
        await page.locator('[data-drop=interview] .column-stack').dispatch_event('dragover', {'dataTransfer': transfer})
        colors = await page.locator('[data-drop=interview]').evaluate('(c) => [getComputedStyle(c.querySelector(".column-head")).backgroundColor, getComputedStyle(c.querySelector(".column-stack")).backgroundColor]')
        assert colors == ['rgba(0, 0, 0, 0)', 'rgb(237, 244, 239)']
        await page.locator('[data-drop=interview] .column-stack').dispatch_event('drop', {'dataTransfer': transfer}); await idle(page)
        await expect(page.locator(f'[data-drop=interview] [data-open="{new_id}"]')).to_be_visible()
        await undo(page)
        await page.locator(f'[data-open="{new_id}"]').click(); await idle(page)
        await page.locator('#drawer [data-complete]').click()
        await page.locator('#complete-form [name=waitingFor]').fill('Recruiter confirmation')
        await page.locator('#complete-form button[type=submit]').click(); await idle(page)
        app = next(a for a in await stored(page) if a['id'] == new_id)
        assert app['task_state'] == 'waiting' and app['stage'] == 'offer' and app['next_action'] is None
        assert any(e['note'] == 'Completed: Send availability' for e in app['events'])
        await undo(page)
        # Explicit closure, restore and their Undo preserve the previous open stage.
        await page.locator(f'[data-open="{new_id}"]').click(); await idle(page)
        await page.locator('#drawer [data-action=close-application]').click()
        await expect(page.locator('#close-dialog')).to_be_visible()
        await page.locator('#close-dialog [data-close=close-dialog]').last.click()
        assert await counts(page) == [13, 320, 18]
        await page.locator('#drawer [data-action=close-application]').click()
        await page.locator('#close-form button[type=submit]').click()
        await expect(page.locator('#close-dialog')).to_be_visible()
        assert await counts(page) == [13, 320, 18]
        await page.locator('#close-form [name=closedReason]').select_option('withdrawn')
        await page.locator('#close-form button[type=submit]').click(); await idle(page)
        assert await counts(page) == [12, 320, 19]
        await expect(page.locator('#drawer')).not_to_be_visible()
        await expect(page.locator('#tab-pipeline')).to_have_attribute('aria-selected', 'true')
        await page.locator('#tab-closed').click()
        await page.locator(f'#panel [data-restore="{new_id}"]').click(); await idle(page)
        await expect(page.locator(f'[data-drop=offer] [data-open="{new_id}"]')).to_be_visible()
        await undo(page); assert await counts(page) == [12, 320, 19]
        await page.locator('#tab-sent').click()
        first = page.locator('[data-response]').first
        rejection_id = await first.get_attribute('data-response'); await first.click()
        await page.locator('#response-form [value=rejected]').check()
        await page.locator('#response-submit').click(); await idle(page)
        assert await counts(page) == [12, 319, 20]
        await undo(page); assert await counts(page) == [12, 320, 19]
        # Bulk closure remains explicit even for very old submitted applications.
        await page.locator('#age-filter').select_option('30')
        await page.locator('#select-page').check()
        await page.locator('[data-action=bulk-close]').click(); await idle(page)
        assert await counts(page) == [12, 270, 69]
        await undo(page); assert await counts(page) == [12, 320, 19]
        await page.reload(); await idle(page); assert await counts(page) == [12, 320, 19]
        # Keyboard opening and closing preserves focus on the originating card.
        await page.locator('.card-open').first.focus()
        await page.keyboard.press('Enter'); await idle(page)
        await expect(page.locator('#drawer [data-close=drawer]')).to_be_focused()
        await page.keyboard.press('Escape')
        await expect(page.locator('.card-open').first).to_be_focused()
        # 1,000 records, long titles, unknown dates, pagination and independent counts.
        await page.evaluate('''key => {
          const store = JSON.parse(localStorage.getItem(key));
          store.applications = Array.from({length: 1000}, (_, i) => ({ id: `bulk-${i}`, external: true, company: `Company ${i}`, title: i === 0 ? 'A very long engineering role '.repeat(20) : `Intern ${i}`, stage: 'applied', closed_reason: null, last_open_stage: 'applied', task_state: 'waiting', waiting_for: '', submitted_at: i === 0 ? null : '2026-09-01', events: [] }));
          localStorage.setItem(key, JSON.stringify(store));
        }''', KEY)
        await page.reload(); await idle(page); await page.locator('#tab-sent').click()
        assert await counts(page) == [0, 1000, 0]
        assert await page.locator('tbody tr').count() == 50
        await page.locator('[data-page=next]').click(); await expect(page.locator('.pagination')).to_contain_text('51–100')
        await page.locator('#search').fill('Company 999'); assert await page.locator('tbody tr').count() == 1
        assert await counts(page) == [0, 1000, 0]
        await page.locator('#search').fill('no-such-company')
        await expect(page.locator('tbody')).to_contain_text('No matching applications.')
        assert await counts(page) == [0, 1000, 0]
        await page.locator('#search').fill('Company 0')
        assert '—' in await page.locator('tbody').inner_text() and 'NaN' not in await page.locator('tbody').inner_text()
        # A single canonical record exercises the phone screens (phone/applied.js).
        await page.evaluate('''key => localStorage.setItem(key, JSON.stringify({ applications: [{ id: 'mobile-1', external: true, company: 'Mobile Co', title: 'Long engineering title '.repeat(20), stage: 'interview', last_open_stage: 'interview', task_state: 'action', next_action: 'Prepare for interview', next_due_at: '2026-10-14', events: [] }], jobs: [], nextApplicationId: 2 }))''', KEY)
        await page.set_viewport_size({'width': 390, 'height': 844}); await page.emulate_media(reduced_motion='reduce')
        await page.goto(origin + '/application/')
        phone = page.locator('#phone')
        async def phone_counts():
            return [int(await phone.locator(f'[data-view={key}] small').inner_text()) for key in ('progress', 'submitted', 'closed')]
        await expect(phone.locator('.stage-card')).to_have_count(1)
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await phone.locator('.stage-card').click()
        await expect(phone.locator('#push.open')).to_be_visible()
        box = await phone.locator('#push').bounding_box(); assert box['width'] == 390 and box['height'] == 844
        await page.screenshot(path=str(ARTIFACTS/'mobile-drawer.png'))
        await phone.locator('[data-act=close-app]').click()
        await phone.locator('[data-close-reason=no_reply]').click()
        await phone.locator('[data-act=commit-close]').click()
        await expect(phone.locator('#toast')).to_contain_text('closed as no reply')
        assert await phone_counts() == [0, 0, 1]
        await phone.locator('#toast button').click()
        await expect(phone.locator('#toast')).to_contain_text('Change undone.')
        assert await phone_counts() == [1, 0, 0]
        assert not errors, errors
        await context.close()
        # Signed-in transport failures preserve edits and counts; success uses canonical API data.
        signed = await browser.new_context(viewport={'width': 1400, 'height': 900})
        row = {'id': 100, 'external': False, 'company': 'Account Co', 'title': 'Intern', 'stage': 'interview', 'task_state': 'action', 'next_action': 'Prepare', 'last_open_stage': 'interview', 'note': 'Original', 'events': []}
        writes = []; fail = True
        async def route_api(route):
            nonlocal row
            url = route.request.url
            if url.endswith('/api/auth/me'):
                payload, status = {'name': 'Chris Kim', 'email': 'test@example.test'}, 200
            elif route.request.method == 'PATCH':
                writes.append(route.request.post_data_json)
                if fail: payload, status = {'detail': 'Save unavailable'}, 503
                else:
                    row = {**row, **route.request.post_data_json}; payload, status = row, 200
            elif url.endswith('/api/applications'):
                payload, status = {'applications': [row]}, 200
            else: payload, status = row, 200
            await route.fulfill(status=status, json=payload)
        await signed.route('**/api/**', route_api)
        p = await signed.new_page(); await p.goto(origin+'/application/'); await idle(p)
        await p.locator('.card-open').click(); await idle(p)
        await expect(p.locator('#detail-form [name=company]')).to_be_disabled()
        await p.locator('#detail-form [name=notes]').fill('Preserve my edits')
        await p.locator('#detail-form button[type=submit]').click(); await idle(p)
        await expect(p.locator('#drawer')).to_be_visible()
        await expect(p.locator('#detail-form [name=notes]')).to_have_value('Preserve my edits')
        await expect(p.locator('[data-save-error]')).to_contain_text('Save unavailable')
        assert await counts(p) == [1, 0, 0]
        assert 'company' not in writes[-1] and 'title' not in writes[-1]
        fail = False
        await p.locator('#detail-form button[type=submit]').click(); await idle(p)
        await expect(p.locator('#drawer')).not_to_be_visible(); assert row['note'] == 'Preserve my edits'
        await p.locator('.card-open').click(); await idle(p)
        await p.locator('#drawer [data-action=close-application]').click()
        await p.locator('#close-form [name=closedReason]').select_option('rejected')
        fail = True
        await p.locator('#close-form button[type=submit]').click(); await idle(p)
        await expect(p.locator('#close-dialog')).to_be_visible()
        await expect(p.locator('#close-form [data-save-error]')).to_contain_text('Save unavailable')
        assert row['stage'] == 'interview' and await counts(p) == [1, 0, 0]
        fail = False
        await p.locator('#close-form button[type=submit]').click(); await idle(p)
        assert row['stage'] == 'closed' and row['closed_reason'] == 'rejected'
        assert await counts(p) == [0, 0, 1]
        assert await p.locator('.column').count() == 4
        assert await p.locator('#panel .empty-state').count() == 0
        await undo(p)
        assert row['stage'] == 'interview' and await counts(p) == [1, 0, 0]
        await signed.close(); await browser.close()
    server.shutdown()
    print('Browser checks passed: guest persistence, workflow, Undo, bulk processing, 1,000 records, keyboard, mobile, and signed-in save failures.')


if __name__ == '__main__':
    asyncio.run(main())
