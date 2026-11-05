import test from 'node:test';
import assert from 'node:assert/strict';
import { chatIdFromHash, hashFor, chatLink } from '../app/src/ui/links.js';

test('chatIdFromHash reads #chat=<id> and ignores anything that isn\'t an id', () => {
  assert.equal(chatIdFromHash('#chat=s0mw2tfw2x000dzjts'), 's0mw2tfw2x000dzjts');
  assert.equal(chatIdFromHash('#x=1&chat=s1'), 's1');
  assert.equal(chatIdFromHash(''), '');
  assert.equal(chatIdFromHash('#chat='), '');
  assert.equal(chatIdFromHash('#chat=../../etc'), '');
  assert.equal(chatIdFromHash('#chat=<script>'), '');
  assert.equal(chatIdFromHash('#chat=' + 'a'.repeat(65)), '');
});

test('hashFor sets or clears the chat and keeps other keys', () => {
  assert.equal(hashFor('s1'), '#chat=s1');
  assert.equal(hashFor('s2', '#chat=s1'), '#chat=s2');
  assert.equal(hashFor('s2', '#x=1'), '#x=1&chat=s2');
  assert.equal(hashFor('', '#chat=s1'), '');
});

test('chatLink is this site with the chat in the hash', () => {
  assert.equal(chatLink('s1', { origin: 'https://kealjones.com', pathname: '/squiggle/' }), 'https://kealjones.com/squiggle/#chat=s1');
});
