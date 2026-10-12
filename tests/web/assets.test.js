const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const web = path.resolve(__dirname, '../../web');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('every frontend import and literal static asset resolves inside web/', () => {
  for (const file of files(web).filter(file => /\.(js|css|html)$/.test(file))) {
    const text = fs.readFileSync(file, 'utf8');
    const references = [...text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(match => path.resolve(path.dirname(file), match[1]));
    for (const match of text.matchAll(/\/static\/([^\s"'`()<>]+)/g)) {
      if (match[1].includes('${')) continue;
      references.push(path.resolve(web, match[1].split(/[?#]/)[0]));
    }
    for (const reference of references) {
      assert.ok(reference.startsWith(web + path.sep), `${file} references a path outside web/`);
      assert.ok(fs.existsSync(reference) && fs.statSync(reference).isFile(), `${file} references missing ${reference}`);
    }
  }
});
