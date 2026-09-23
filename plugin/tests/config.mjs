import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Config.js is a QML library script; run it as a plain script and read its globals.
const source = readFileSync(new URL('../Config.js', import.meta.url), 'utf8').replace(/^\.pragma library/m, '');
const Config = {};
vm.runInNewContext(source, Config);

const file = `// Desktop Habitats
{
  // Which tank.
  "environment": "riverscape",
  "fps": 60,
  "monitors": {
    // Main monitor: leave it alone.
    "DP-1": { "enabled": false }
    // "DP-2": { "environment": "reefscape" },
  }
}
`;

// Reading and resolving.
assert.equal(Config.parse('{ "a": 1, // x\n }').a, 1);
assert.equal(Config.parse('{ nope'), null);
const config = Config.parse(file);
assert.equal(Config.resolve(config, '').fps, 60);
assert.equal(Config.resolve(config, 'DP-1').enabled, false);
assert.equal(Config.resolve(config, 'DP-2').enabled, true);
assert.equal(Config.resolve(config, 'DP-2').fish.reefscape.chromis, 9);
assert.equal(Config.overrides(config, 'DP-1', 'enabled'), true);
assert.equal(Config.overrides(config, 'DP-1', 'fps'), false);

// Round-tripped so objects from the script's realm compare equal.
// Sweep speed is a whole setting from 1 to 10; 9 is a thirty-second round trip.
assert.equal(Config.resolve({}, '').panSpeed, 5);
assert.equal(Config.resolve({ panSpeed: 9 }, '').panSpeed, 9);
assert.equal(Config.resolve({ panSpeed: 11 }, '').panSpeed, 5);
assert.equal(Config.resolve({ panSpeed: 2.5 }, '').panSpeed, 5);
assert.equal(Config.resolve({ panSpeed: 3, monitors: { 'DP-2': { panSpeed: 8 } } }, 'DP-2').panSpeed, 8);
assert.equal(Math.round(Config.sweepSeconds(9)), 30);
assert.equal(Math.round(Config.sweepSeconds(5)), 120);

const same = (text) => JSON.parse(JSON.stringify(Config.parse(text)));

// Replacing a value keeps every comment.
let text = Config.setValue(file, ['environment'], 'reefscape');
assert.equal(same(text).environment, 'reefscape');
assert.ok(text.includes('// Which tank.') && text.includes('// Main monitor: leave it alone.'));
assert.equal(text.replace('"reefscape"', '"riverscape"'), file);

// A new top-level key goes after the last member, in the file's indentation.
text = Config.setValue(file, ['pan'], 0.4);
assert.equal(same(text).pan, 0.4);
assert.ok(text.includes('  "monitors": {'));
assert.ok(/\}\,\n  "pan": 0.4\n\}/.test(text), text);

// A new monitor lands after DP-1 and ahead of the commented example.
text = Config.setValue(file, ['monitors', 'DP-2', 'pan'], -1);
assert.deepEqual(same(text).monitors['DP-2'], { pan: -1 });
assert.ok(text.indexOf('"DP-2": { "pan": -1 }') < text.indexOf('// "DP-2"'), text);
// ... and further keys join its inline object.
text = Config.setValue(text, ['monitors', 'DP-2', 'environment'], 'reefscape');
assert.ok(text.includes('"DP-2": { "pan": -1, "environment": "reefscape" }'), text);
text = Config.setValue(text, ['monitors', 'DP-2', 'fish', 'reefscape', 'chromis'], 14);
assert.equal(same(text).monitors['DP-2'].fish.reefscape.chromis, 14);
assert.equal(Config.resolve(same(text), 'DP-2').fish.reefscape.clownfish, 3);
text = Config.setValue(text, ['monitors', 'DP-2', 'fish', 'reefscape', 'clownfish'], 4);
assert.deepEqual(same(text).monitors['DP-2'].fish.reefscape, { chromis: 14, clownfish: 4 });

// Removing an override: a middle one, the last one, and an inline object's only one.
let removed = Config.removeValue(text, ['monitors', 'DP-2', 'pan']);
assert.deepEqual(Object.keys(same(removed).monitors['DP-2']), ['environment', 'fish']);
removed = Config.removeValue(removed, ['monitors', 'DP-2', 'fish']);
assert.deepEqual(same(removed).monitors['DP-2'], { environment: 'reefscape' });
removed = Config.removeValue(removed, ['monitors', 'DP-2', 'environment']);
assert.ok(removed.includes('"DP-2": {}'), removed);
assert.equal(Config.removeValue(file, ['nothing', 'here']), file);

// A multi-line object's last and only members.
const block = '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n';
assert.equal(Config.removeValue(block, ['b']), '{\n  "a": 1\n}\n');
assert.equal(Config.removeValue(block, ['b', 'c']), '{\n  "a": 1,\n  "b": {\n  }\n}\n');
assert.deepEqual(same(Config.removeValue(block, ['a'])), { b: { c: 2 } });

// An empty file and an empty object get a first member.
assert.deepEqual(same(Config.setValue('', ['fps'], 30)), { fps: 30 });
assert.deepEqual(same(Config.setValue('{\n}\n', ['fps'], 30)), { fps: 30 });
// A trailing comma after the last member is kept valid.
assert.deepEqual(same(Config.setValue('{\n  "a": 1,\n}\n', ['b'], 2)), { a: 1, b: 2 });
// A scalar where an object is wanted is replaced.
assert.deepEqual(same(Config.setValue('{ "fish": 3 }', ['fish', 'reefscape', 'chromis'], 5)), { fish: { reefscape: { chromis: 5 } } });
// Broken files are refused rather than mangled.
assert.throws(() => Config.setValue('{ "a": ', ['a'], 1));

// The real file, when there is one.
try {
  const real = readFileSync(`${process.env.HOME}/.config/desktop-habitats/config.jsonc`, 'utf8');
  const edited = Config.setValue(Config.setValue(real, ['monitors', 'DP-2', 'pan'], 0.5), ['fish', 'reefscape', 'chromis'], 12);
  assert.equal(same(edited).monitors['DP-2'].pan, 0.5);
  assert.equal(same(edited).fish.reefscape.chromis, 12);
  assert.equal((edited.match(/\/\//g) || []).length, (real.match(/\/\//g) || []).length, 'every comment survives');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log('PASS: config parsing, resolving, and comment-preserving edits');
