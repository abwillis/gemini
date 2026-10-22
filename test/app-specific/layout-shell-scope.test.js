'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../../app-specific/layout-css');

test('layout scopes exclude the bare app shell but keep conversation containers', () => {
  for (const scope of [layout.LAYOUT_SCOPE_PSEUDO, layout.LAYOUT_MESSAGE_LIST_PSEUDO]) {
    const members = scope.slice(':is('.length, -1).split(', ');
    assert.equal(members.includes('main'), false, scope);
    assert.equal(members.includes('[role="main"]'), false, scope);
  }
  assert.match(layout.LAYOUT_SCOPE_PSEUDO, /#chat-history/);
  assert.match(layout.LAYOUT_MESSAGE_LIST_PSEUDO, /\.conversation-container/);
});

test('generated layout CSS never targets bare main or [role="main"]', () => {
  for (const options of [{}, { specificMessageId: 'msg-1' }]) {
    const css = layout.buildMaxLayoutCSS(options);
    assert.equal(css.includes('[role="main"]'), false);
    const bareMain = css.split(/[,{]/).map(part => part.trim().split(/\s+/)[0]).filter(token => token === 'main');
    assert.deepEqual(bareMain, []);
    assert.match(css, /\.conversation-container/);
  }
});
