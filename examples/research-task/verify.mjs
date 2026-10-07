import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const input = await readFile('data.csv', 'utf8');
assert.equal(input.replaceAll('\r\n', '\n'), 'group,value\nA,2\nB,5\nA,4\nB,7\nC,-1\nC,3\n');
const output = JSON.parse(await readFile('summary.json', 'utf8'));
assert.deepEqual(output.groups, [
  { group: 'A', count: 2, sum: 6, mean: 3 },
  { group: 'B', count: 2, sum: 12, mean: 6 },
  { group: 'C', count: 2, sum: 2, mean: 1 },
]);
console.log('PASS: sample outputs independently checked; not a benchmark score.');
