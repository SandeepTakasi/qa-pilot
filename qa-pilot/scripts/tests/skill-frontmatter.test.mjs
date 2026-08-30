import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parse } from '../lib/yaml.mjs';

// Regression: an unquoted `description:` containing ": " parses as a nested mapping and
// the frontmatter blows up. `claude plugin validate` did not catch it, so this does.

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');
const names = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

test('there are skills to check', () => {
  assert.ok(names.length >= 6, `expected the six entry points, found ${names.length}`);
});

for (const name of names) {
  test(`${name}: frontmatter is valid YAML with the keys a skill needs`, () => {
    const raw = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    assert.ok(m, 'no YAML frontmatter block');

    let meta;
    assert.doesNotThrow(() => { meta = parse(m[1]); },
      'frontmatter is not valid YAML (an unquoted ": " in a value is the usual cause)');

    assert.equal(meta.name, name, 'frontmatter name must match the directory');
    assert.equal(typeof meta.description, 'string',
      'description must parse as a string, not a nested mapping');
    assert.ok(meta.description.length > 40, 'description is too short to route on');
    assert.ok(!meta.description.includes('\n'), 'description must stay on one line');
  });
}

test('no user-facing dash typography anywhere in the skills', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.md')) {
        const s = readFileSync(p, 'utf8');
        if (s.includes('—') || s.includes('–')) offenders.push(p);
      }
    }
  };
  walk(SKILLS);
  assert.deepEqual(offenders, [], 'em or en dashes found; house style is plain ASCII dashes');
});
