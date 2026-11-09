import test from 'node:test';
import assert from 'node:assert/strict';
import { activityDetail } from '../src/server.mjs';

test('the phone feed line shows what runs, with secrets and typed text hidden', () => {
  assert.equal(activityDetail('bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" x', cwd: 'D:/a' }), 'curl -H "Authorization: [masked] [masked]" x (in D:/a)');
  assert.equal(activityDetail('ui_act', { action: 'type', text: 'my password', window: 'Login' }), 'type (11 chars) @Login');
  assert.equal(activityDetail('ui_act', { steps: [{ action: 'click', target: '提交' }, { action: 'key', keys: 'ctrl+s' }] }), 'click "提交" → key ctrl+s');
  assert.equal(activityDetail('ui_act', { action: 'click', x: 10, y: 20 }), 'click (10,20)');
  assert.equal(activityDetail('read_file', { path: 'C:/x.txt' }), 'C:/x.txt');
  assert.equal(activityDetail('ui_look', {}), 'active window');
  assert.equal(activityDetail('browser', { action: 'open', url: 'https://a.com/p?token=1' }), 'open https://a.com/p');
  assert.equal(activityDetail('type_secret', { secret: 'GitHub', part: 'password' }), 'GitHub (password)');
  assert.equal(activityDetail('list_computers', {}), null);
  assert.equal(activityDetail('bash', { command: 'x'.repeat(1000) }).length, 401);
});
