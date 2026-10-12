const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
for (const script of [
  'browser/discover_layout.cjs', 'browser/discover_infinite_scroll.cjs',
  'application_records_browser.cjs', 'company_editor_browser.cjs',
  'feed_overview_browser.cjs', 'feed_other_browser.cjs',
  'resume_workspace_browser.cjs', 'resume_import_browser.cjs',
]) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', script)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
