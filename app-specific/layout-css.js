// lib/layout-css.js  — Gemini-specific layout CSS injection
// This module is NOT shared between apps; each app has its own layout-css.js
// that exports the same shape of API but with app-specific CSS rules.
'use strict';

const {
    CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_PSEUDO,
    messageContentById,
} = require('./chat-dom');
const { callRendererMethodInAllFrames } = require('../lib/renderer-api');

// --- Dynamic width constants -----------------------------------------------
const MAX_CHARS = 2048;
const VW_SIZE   = 100;
const MIN_VW    = 70;
const MAX_VW    = 100;

// --- Selector groups -------------------------------------------------------
const SELECTORS = Object.freeze({
    chatScope: CHAT_SCOPE_PSEUDO,
    messageList: CHAT_MESSAGE_LIST_PSEUDO,
});

const IGNORE_SELECTORS = [];
const IGNORE_JOINED = '';

// --- CSS caching & injection bookkeeping -----------------------------------
const maxLayoutCssCache       = new Map();
const injectedFrameIdsByWC    = new WeakMap();
const insertedMainCssKeyByWC  = new WeakMap();
const cssApplyDebounceByWC    = new WeakMap();

// --- buildMaxLayoutCSS -----------------------------------------------------
function buildMaxLayoutCSS({ specificMessageId } = {}) {
    const CONTENT = [
        specificMessageId ? messageContentById(specificMessageId) : null,
        '.conversation-container [role="article"]',
        '.conversation-container article',
        '.conversation-container [class*="response-content"]',
        '.conversation-container [class*="markdown"]',
        '[class="response-container"]',
        '[class="model-response-text"]'
    ].filter(Boolean).join(',\n');

    const TABLE_WRAPPERS = [
        '.conversation-container [role="article"]:has(table)',
        '.conversation-container article:has(table)',
        '.conversation-container div:has(> table)',
        `${CHAT_SCOPE_PSEUDO} [role="article"]:has(table)`,
        `${CHAT_SCOPE_PSEUDO} article:has(table)`,
        `${CHAT_SCOPE_PSEUDO} div:has(> table)`
    ].join(',\n');

    return String.raw`
html { --gemini-vw: ${VW_SIZE}vw; }
html, body {
    height: 100vh !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    word-break: break-word !important;
}
@supports (overflow: clip) {
    html, body { overflow-x: clip !important; }
}
${CHAT_SCOPE_PSEUDO},
${CHAT_SCOPE_PSEUDO} * {
    box-sizing: border-box !important;
    max-width: 100% !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
}
${CHAT_SCOPE_PSEUDO} {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    scrollbar-gutter: stable both-edges !important;
}
${CHAT_MESSAGE_LIST_PSEUDO},
.conversation-container,
[class="response-container"] {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    overflow-x: hidden !important;
    overflow-y: visible !important;
}
${CONTENT} {
    max-width: min(min(var(--gemini-vw, ${VW_SIZE}vw), 92vw), ${MAX_CHARS}ch) !important;
    width: 100% !important;
    margin-left: 0 !important;
    margin-right: auto !important;
    padding-left: 20px !important;
    padding-right: 20px !important;
}
.input-area-container,
.bottom-container,
form,
[class*="input-area" i],
[class*="composer" i],
[class*="prompt-box" i],
[class*="text-input" i],
${CHAT_SCOPE_PSEUDO} textarea,
${CHAT_SCOPE_PSEUDO} [contenteditable="true"],
${CHAT_SCOPE_PSEUDO} div[role="textbox"] {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    overflow: visible !important;
    visibility: visible !important;
    opacity: 1 !important;
    flex: 1 1 auto !important;
}
[class*="user-query"] {
    max-width: none !important;
    width: auto !important;
    margin-left: initial !important;
    margin-right: initial !important;
    display: block !important;
}
${TABLE_WRAPPERS} {
    width: 100% !important;
    max-width: min(min(var(--gemini-vw, ${VW_SIZE}vw), 92vw), ${MAX_CHARS}ch) !important;
    margin-left: 0 !important;
    margin-right: auto !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
}
.conversation-container table,
${CHAT_SCOPE_PSEUDO} table {
    table-layout: fixed !important;
    width: 100% !important;
    min-width: 100% !important;
    max-width: min(min(var(--gemini-vw, ${VW_SIZE}vw), 92vw), ${MAX_CHARS}ch) !important;
    border-collapse: collapse !important;
    display: table !important;
}
.conversation-container th,
.conversation-container td,
${CHAT_SCOPE_PSEUDO} th,
${CHAT_SCOPE_PSEUDO} td {
    white-space: normal !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    vertical-align: top !important;
    max-width: none !important;
}
.conversation-container pre,
.conversation-container code,
${CHAT_SCOPE_PSEUDO} pre,
${CHAT_SCOPE_PSEUDO} code {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    max-width: 92vw !important;
}
.conversation-container pre,
${CHAT_SCOPE_PSEUDO} pre {
    width: 100% !important;
    overflow-x: hidden !important;
    box-sizing: border-box !important;
}
`;
}

// --- applyMaxLayoutCSS -----------------------------------------------------
function applyMaxLayoutCSS(win, { specificMessageId } = {}) {
    if (!win) return;
    const cacheKey = specificMessageId || 'default';
    let css = maxLayoutCssCache.get(cacheKey);
    if (!css) {
        css = buildMaxLayoutCSS({ specificMessageId });
        maxLayoutCssCache.set(cacheKey, css);
    }
    if (win.__appRole === 'quick' || win.__geminiRole === 'quick') {
        injectCSSIntoAllFrames(win, css);
        return;
    }
    if (!win.__maxLayoutKeyHolder) {
        win.__maxLayoutKeyHolder = { key: null, css: '', __wired: false };
    }
    injectCSSOnLoad(win, css, win.__maxLayoutKeyHolder);
}

// --- injectCSSOnLoad -------------------------------------------------------
function injectCSSOnLoad(win, css, keyHolder) {
    if (!win || !win.webContents) return;
    const wc = win.webContents;
    if (!keyHolder) return;
    keyHolder.css = String(css ?? keyHolder.css ?? '');
    const inject = () => {
        try {
            const currentCss = String(keyHolder.css ?? '');
            if (!currentCss) return;
            if (keyHolder.key) {
                try { wc.removeInsertedCSS(keyHolder.key); } catch {}
                keyHolder.key = null;
            }
            wc.insertCSS(currentCss)
                .then(k => { keyHolder.key = k; })
                .catch(() => {});
        } catch (err) {
            console.error('insertCSS failed:', err);
        }
    };
    if (!keyHolder.__wired) {
        keyHolder.__wired = true;
        wc.on('dom-ready', inject);
        wc.on('did-finish-load', inject);
        wc.on('did-start-navigation', inject);
    }
    inject();
}

// --- injectCSSIntoAllFrames ------------------------------------------------
function injectCSSIntoAllFrames(win, css) {
    if (!win || !win.webContents) return;
    const wc = win.webContents;
    const apply = () => {
        try {
            const prev = cssApplyDebounceByWC.get(wc);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
                try {
                    let injected = injectedFrameIdsByWC.get(wc);
                    if (!injected) {
                        injected = new Set();
                        injectedFrameIdsByWC.set(wc, injected);
                    }
                    const frames = wc.mainFrame?.framesInSubtree ?? wc.mainFrame?.frames ?? [];
                    for (const f of frames) {
                        try {
                            const rid = (typeof f?.routingId === 'number') ? f.routingId : null;
                            if (rid !== null && injected.has(rid)) continue;
                            f.insertCSS(css).then(() => { if (rid !== null) injected.add(rid); }).catch(() => {});
                        } catch {}
                    }
                    const prevKey = insertedMainCssKeyByWC.get(wc);
                    if (prevKey) { try { wc.removeInsertedCSS(prevKey); } catch {} }
                    try {
                        wc.insertCSS(css).then((k) => { insertedMainCssKeyByWC.set(wc, k); }).catch(() => {});
                    } catch {}
                } catch {}
            }, 150);
            cssApplyDebounceByWC.set(wc, t);
        } catch {}
    };
    wc.on('dom-ready', apply);
    wc.on('did-frame-finish-load', apply);
    wc.on('did-navigate-in-page', apply);
    wc.on('did-frame-navigate', apply);
    apply();
}

// -----------------------------------------------------------------------------
// Find-in-page content-visibility on-demand override
// -----------------------------------------------------------------------------
// Hosted chat apps can apply content-visibility:auto to off-screen rows; Chromium's
// findInPage() skips unrendered subtrees. This CSS layer is inserted only while
// the Find modal is open and removed on close, so the lazy-render optimisation
// survives normal browsing.
// -----------------------------------------------------------------------------
let findCVKey = null;
let findCVWebContents = null;
let findCVFrameKeys = [];

function buildFindContentVisibilityCSS() {
    // :not(#_cv) chains give (0,N,0) specificity — beats any class-based
    // !important rule the web app may use.
    const BOOST = ':not(#_cv):not(#_cv):not(#_cv):not(#_cv):not(#_cv)';
    return `
    [data-app-find-root="1"]${BOOST},
    [data-app-find-root="1"]${BOOST} *,
    [data-app-find-ancestor="1"]${BOOST} {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
        contain: none !important;
    }
    [data-app-find-root="1"] [style*="content-visibility"],
    [data-app-find-root="1"] [style*="contain"] {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
        contain: none !important;
    }
    `;
}

// -----------------------------------------------------------------------------
// Factory: createLayoutCSS(deps)
// -----------------------------------------------------------------------------
// deps.rendererApiGlobal  window-side global used by renderer/agent.js
// deps.dynamicWidth       app.config.js dynamicWidth block ({ cssVar, ... })
// deps.getRuntimeConfig   current config snapshot (layoutWidthVw is user-settable)
//
// main.js consumes this shared factory shape across all app variants.
// -----------------------------------------------------------------------------
function createLayoutCSS(deps = {}) {
    const { rendererApiGlobal, dynamicWidth, getRuntimeConfig } = deps;
    const RENDERER_API_OPTIONS = rendererApiGlobal
        ? { __rendererApiOptions: { rendererApiGlobal } }
        : null;

    if (!rendererApiGlobal) {
        try {
            console.warn('[layout-css] createLayoutCSS: rendererApiGlobal not provided; '
                + 'renderer-agent calls will fall back to the shared default '
                + "'__appRenderer'. Pass rendererApiGlobal from app.config.js.");
        } catch {}
    }

    function withRendererApiOptions(args) {
        return RENDERER_API_OPTIONS ? args.concat(RENDERER_API_OPTIONS) : args;
    }

    function callRAFrames(win, method, ...args) {
        return callRendererMethodInAllFrames(
            win,
            method,
            ...withRendererApiOptions(args)
        );
    }

    async function removeFindCSS() {
        const wc = findCVWebContents;
        const key = findCVKey;
        const frameKeys = findCVFrameKeys;
        findCVKey = null;
        findCVWebContents = null;
        findCVFrameKeys = [];

        if (wc && key) {
            try { await wc.removeInsertedCSS(key).catch(() => {}); } catch {}
        }
        for (const entry of frameKeys) {
            try {
                if (entry?.frame && entry.key) {
                    await entry.frame.removeInsertedCSS(entry.key).catch(() => {});
                }
            } catch {}
        }
    }

    async function enableFindContentVisibility(win) {
        if (!win?.webContents) return { ok: false, reason: 'no-web-contents' };
        const wc = win.webContents;

        try {
            if (findCVWebContents !== wc || !findCVKey) {
                if (findCVWebContents) await removeFindCSS();
                const css = buildFindContentVisibilityCSS();
                findCVKey = await wc.insertCSS(css);
                findCVWebContents = wc;

                try {
                    const frames = wc.mainFrame?.framesInSubtree ?? [];
                    for (const frame of frames) {
                        if (frame === wc.mainFrame) continue;
                        try {
                            const key = await frame.insertCSS(css);
                            if (key) findCVFrameKeys.push({ frame, key });
                        } catch {}
                    }
                } catch {}
            }
        } catch (err) {
            console.error('enableFindContentVisibility CSS failed:', err);
        }

        try {
            const results = await callRAFrames({ webContents: wc }, 'enableFindContentVisibility');
            try {
                const missing = (results || []).filter(r => r?.value?.missing);
                if (missing.length) {
                    console.warn('[find-visibility] enable renderer-agent MISSING method on some frames:', missing);
                }
            } catch {}
            const values = (results || []).map(r => r?.value).filter(Boolean);
            return {
                ok: values.some(value => value.ok),
                rootFound: values.some(value => value.rootFound),
                needsScrollWalk: values.some(value => value.needsScrollWalk),
                frames: results || [],
            };
        } catch (err) {
            console.error('enableFindContentVisibility renderer-agent failed:', err);
            return { ok: false, error: String(err?.message || err) };
        }
    }

    async function indexFindConversation(win) {
        if (!win?.webContents) return { ok: false, reason: 'no-web-contents' };
        try {
            const results = await callRAFrames(
                { webContents: win.webContents },
                'indexFindConversation'
            );
            const values = (results || []).map(r => r?.value).filter(Boolean);
            return {
                ok: values.some(value => value.ok),
                cancelled: values.some(value => value.cancelled),
                walked: values.some(value => Number(value.steps || 0) > 0),
                frames: results || [],
            };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }

    async function cancelFindContentVisibilityIndexing(win) {
        const wc = win?.webContents || findCVWebContents;
        if (!wc) return { ok: true, cancelled: false };
        try {
            const results = await callRAFrames(
                { webContents: wc },
                'cancelFindContentVisibilityIndexing'
            );
            return { ok: true, cancelled: true, frames: results || [] };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }

    async function disableFindContentVisibility() {
        const wc = findCVWebContents;

        if (!wc) return;
        try {
            await cancelFindContentVisibilityIndexing({ webContents: wc });
            await callRAFrames({ webContents: wc }, 'disableFindContentVisibility');
        } catch {}
        await removeFindCSS();
    }

    async function applyDynamicWidth(win) {
        if (!win?.webContents) return;
        if (!dynamicWidth || !dynamicWidth.cssVar) {
            try { console.warn('[layout-css] applyDynamicWidth: dynamicWidth config missing; skipping.'); } catch {}
            return;
        }
        try {
            const runtimeWidth = Number(getRuntimeConfig?.()?.layoutWidthVw);
            await callRAFrames(
                { webContents: win.webContents },
                'setTargetVW',
                { vw: Number.isFinite(runtimeWidth) ? runtimeWidth : Number(dynamicWidth.defaultVw) || VW_SIZE }
            );
        } catch (err) {
            console.error('applyDynamicWidth failed:', err);
        }
    }

    async function attachVWResize(win) {
        if (!win?.webContents) return;
        const wc = win.webContents;
        if (wc.__vwResizeAttached) return;
        wc.__vwResizeAttached = true;

        if (!dynamicWidth || !dynamicWidth.cssVar) {
            try { console.warn('[layout-css] attachVWResize: dynamicWidth config missing; skipping.'); } catch {}
            return;
        }

        const install = async () => {
            try {
                const runtimeWidth = Number(getRuntimeConfig?.()?.layoutWidthVw);
                await callRAFrames(
                    { webContents: wc },
                    'startVWResize',
                    { screenPercent: Number.isFinite(runtimeWidth)
                        ? runtimeWidth
                        : Number(dynamicWidth.screenPercent) || dynamicWidth.maxVw || MAX_VW }
                );
            } catch (err) {
                console.error('attachVWResize failed:', err);
            }
        };

        wc.once('dom-ready', install);
    }

    async function attachComposerTracking(win) {
        if (!win?.webContents) return;
        const wc = win.webContents;

        const install = async () => {
            try {
                const results = await callRAFrames(
                    { webContents: wc },
                    'startComposerTracking',
                    {}
                );
                const missing = (results || []).filter(r => r?.value?.missing);
                if (missing.length) {
                    console.warn(
                        '[layout-css] startComposerTracking MISSING on renderer agent '
                        + 'in some frames; composer will keep its default width:',
                        missing
                    );
                }
            } catch (err) {
                console.error('attachComposerTracking failed:', err);
            }
        };

        if (wc.__composerTrackingAttached) {
            await install();
            return;
        }
        wc.__composerTrackingAttached = true;

        wc.on('did-finish-load', install);
        wc.on('did-navigate-in-page', install);
        await install();
    }

    return {
        applyMaxLayoutCSS,
        requestExpandedLayout,
        buildFindContentVisibilityCSS,
        applyDynamicWidth,
        attachVWResize,
        attachComposerTracking,
        enableFindContentVisibility,
        indexFindConversation,
        cancelFindContentVisibilityIndexing,
        disableFindContentVisibility,
    };
}

// --- requestExpandedLayout -------------------------------------------------
function requestExpandedLayout(win) {
    if (!win) return;
    const script = `
(function() {
    try {
        window.postMessage({
            type: 'host:setLayoutMode',
            payload: { mode: 'expanded' }
        }, '*');
    } catch (e) {
        console.error('PostMessage layout request failed:', e);
    }
})();
`;
    const run = () => {
        try { win.webContents.executeJavaScript(script).catch(() => {}); }
        catch (err) { console.error('requestExpandedLayout failed:', err); }
    };
    win.webContents.on('did-finish-load', run);
    win.webContents.on('did-navigate-in-page', run);
}


// ============================================================================
module.exports = {
    SELECTORS, IGNORE_SELECTORS, IGNORE_JOINED,
    messageContentById,
    MAX_CHARS, VW_SIZE, MIN_VW, MAX_VW,
    buildMaxLayoutCSS,
    maxLayoutCssCache, injectedFrameIdsByWC, insertedMainCssKeyByWC, cssApplyDebounceByWC,
    injectCSSOnLoad, injectCSSIntoAllFrames, applyMaxLayoutCSS, requestExpandedLayout,
    buildFindContentVisibilityCSS,
    createLayoutCSS,
};
