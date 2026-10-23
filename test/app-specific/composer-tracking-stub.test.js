'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const layout = require('../../app-specific/layout-css');

// This app's layout CSS never reads the composer marker, so attachComposerTracking
// must not call into the renderer or subscribe to navigation events.
function fixture() {
    const wc = new EventEmitter();
    let calls = 0;
    wc.isDestroyed = () => false;
    wc.getURL = () => 'https://example.invalid/';
    wc.mainFrame = { framesInSubtree: [] };
    wc.mainFrame.framesInSubtree.push(wc.mainFrame);
    wc.executeJavaScript = async () => { calls += 1; return { ok: true }; };
    const api = layout.createLayoutCSS({
        rendererApiGlobal: '__test',
        dynamicWidth: { cssVar: '--test-vw', minVw: 70, maxVw: 100, defaultVw: 100 },
        getRuntimeConfig: () => ({ layoutWidthVw: 100 }),
    });
    return { api, wc, win: { webContents: wc, isDestroyed: () => false }, calls: () => calls };
}

test('attachComposerTracking is exported and does not touch the renderer', async () => {
    const f = fixture();
    assert.equal(typeof f.api.attachComposerTracking, 'function');
    await f.api.attachComposerTracking(f.win);
    await f.api.attachComposerTracking(f.win);
    assert.equal(f.calls(), 0);
});

test('attachComposerTracking registers no webContents listeners and logs nothing', async () => {
    const f = fixture();
    const logged = [];
    const originals = { warn: console.warn, error: console.error };
    console.warn = (...args) => logged.push(args.join(' '));
    console.error = (...args) => logged.push(args.join(' '));
    try { await f.api.attachComposerTracking(f.win); } finally { Object.assign(console, originals); }
    assert.equal(f.wc.eventNames().length, 0);
    assert.deepEqual(logged, []);
    assert.equal(f.wc.__composerTrackingAttached, undefined);
});
