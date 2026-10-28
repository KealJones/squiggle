import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../app/src/calc.js';

const ok = (e, v) => assert.deepEqual(calculate(e), { result: v }, e);
const bad = (e, re) => { const r = calculate(e); assert.ok(r.error && re.test(r.error), `${e} -> ${JSON.stringify(r)}`); };

test('arithmetic, precedence, power and unary minus', () => {
  ok('300 * 25% + (120 - 60)', 135);
  ok('2 + 3 * 4', 14);
  ok('(2 + 3) * 4', 20);
  ok('2^3^2', 512);
  ok('-2^2', -4);
  ok('2 ** 10', 1024);
  ok('10 / 4', 2.5);
  ok('0.1 + 0.2', 0.3);
  ok('1e6 / 1000', 1000);
  ok('.5 * 4', 2);
});

test('the way people write money and percentages', () => {
  ok('15% of 240', 36);
  ok('$3.50 * 3', 10.5);
  ok('1,234,567 + 1', 1234568);
  ok('2 x 3', 6);
  ok('6 × 7 ÷ 2', 21);
  ok('109 * 12 + 29', 1337);
});

test('functions and constants', () => {
  ok('round(10/3, 2)', 3.33);
  ok('round((72 - 32) * 5 / 9, 1)', 22.2);
  ok('max(1, 234, 5)', 234);
  ok('max(1,234,5)', 234);
  ok('sqrt(16) + abs(-2)', 6);
  ok('floor(2.7) + ceil(2.1)', 5);
  ok('pow(2, 8)', 256);
  ok('log(1000)', 3);
  ok('round(pi, 4)', 3.1416);
});

test('clear errors instead of guesses', () => {
  bad('5 / 0', /Division by zero/);
  bad('foo(2)', /Unknown name "foo"/);
  bad('(1 + 2', /Expected "\)"/);
  bad('1 + 2)', /Unexpected "\)"/);
  bad('7 % 3', /Unexpected "3"/);
  bad('sqrt(1, 2)', /sqrt takes 1 argument/);
  bad('2; process.exit()', /Unexpected ";"/);
  bad('', /ends too early|Nothing/);
  bad('9'.repeat(600), /too long/);
});
