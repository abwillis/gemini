// lib/chat-dom.js  — Gemini-specific DOM selector constants & detection scripts
// This module is NOT shared with Copilot; each app has its own chat-dom.js
// that exports the same shape of API but with app-specific selectors.
'use strict';

// === Selector constants (Gemini UI 2024/2025) ==============================
const CHAT_SELECTOR = '#mainChat';  // Legacy/fallback root selector

const CHAT_ROOT_SELECTORS = [
    '#mainChat',
    'main.chat-app',
    '[data-test-id="chat-app"]',
    '[role="main"]',
    'main'
];

const CHAT_MESSAGE_LIST_SELECTORS = [
    '#mainChat div[id*="messagelist" i]',
    '.conversation-container',
    '[class="response-container"]',
    '[role="article"]',
    'main.chat-app',
    '[data-test-id="chat-app"]',
    '[role="main"]'
];

const CHAT_SCOPE_SELECTOR   = CHAT_ROOT_SELECTORS.join(', ');
const CHAT_SCOPE_PSEUDO     = `:is(${CHAT_SCOPE_SELECTOR})`;
const CHAT_MESSAGE_LIST_SELECTOR = CHAT_MESSAGE_LIST_SELECTORS.join(', ');
const CHAT_MESSAGE_LIST_PSEUDO   = `:is(${CHAT_MESSAGE_LIST_SELECTOR})`;

const EXPORT_ROOT_CLASS    = 'gemini-export-root';
const EXPORT_ROOT_SELECTOR = `.${EXPORT_ROOT_CLASS}`;

// Parameterized single-message selector
function messageContentById(id) {
    return `${CHAT_SCOPE_PSEUDO} #${id}, ${CHAT_MESSAGE_LIST_PSEUDO} #${id}, [id="${id}"]`;
}

// Code-preview iframe selector (Gemini uses iframes for rendered code)
const CODE_PREVIEW_IFRAME_SELECTOR = 'iframe[src*="immersive"]';

// === Transcript child selectors (Gemini-specific) ==========================
const TRANSCRIPT_SELECTORS = [
    'message-content',
    '.markdown.markdown-main-panel',
    '[id^="model-response-message-content"]',
    'structured-content-container',
    '.model-response-text',
    '.response-content',
    '.response-container-content',
    '.presented-response-container',
    '.conversation-container',
    '[class="response-container"]',
    '[role="article"]',
    'article',
    'section',
    'main'
];

// === DOM cleanup ("junk") selectors ========================================
const DOM_CLEANUP_SELECTORS = [
    '[role="button"]',
    '[class*="button" i]',
    '[class*="logo" i]',
    '[class*="label" i]',
    '[class*="input" i]',
    'label',
    'input',
    'textarea',
    '[role="textbox"]'
];

// === Chrome/UI penalty selectors ===========================================
const CHROME_PENALTY_SELECTOR =
    'user-query,' +
    'user-query-content,' +
    '.user-query-container,' +
    '.query-content,' +
    '.response-footer,' +
    '.response-container-footer,' +
    'message-actions,' +
    'sources-list,' +
    'tts-control,' +
    'bard-avatar,' +
    '.avatar-gutter';

const CHROME_PENALTY_REGEX =
    /(user-query|prompt|action|button|toolbar|footer|sources-list|message-actions|thumb-|tts-|avatar-gutter)/i;

// === User-prompt detection selectors =======================================
const USER_PROMPT_SELECTOR =
    'user-query,' +
    'user-query-content,' +
    '.user-query-container,' +
    '.query-content';

const USER_PROMPT_REGEX = /(user-query|query-content)/i;

// === Semantic table selectors ==============================================
const TABLE_SIGNAL_SELECTORS = [
    'table',
    '[role="table"]',
    '[role="grid"]',
    'table-block',
    '.table-block',
    '.table-block-component',
    '.table-content',
    '.horizontal-scroll-wrapper'
];

const TABLE_SIGNAL_SELECTOR_JOINED = TABLE_SIGNAL_SELECTORS.join(', ');

const TABLE_SIGNAL_HTML_REGEX =
    /<table\b|role="table"|role="grid"|<table-block\b|class="[^"]*(?:table-block-component|table-block|table-content|horizontal-scroll-wrapper)[^"]*"/gi;

// === Promotion-candidate selectors =========================================
const PROMOTION_STOP_SELECTOR = '#chat-history, main, [role="main"], body, html';

const PROMOTION_CANDIDATE_SELECTOR =
    'message-content,' +
    'structured-content-container,' +
    '.response-content,' +
    '.response-container-content,' +
    '.presented-response-container,' +
    '.response-container,' +
    '.conversation-container,' +
    '.table-block-component,' +
    '.horizontal-scroll-wrapper,' +
    'table-block,' +
    'infinite-scroller';

const PROMOTION_CANDIDATE_REGEX =
    /(response|conversation|table-block|horizontal-scroll-wrapper|chat-history)/i;

// === Preserve selectors (used during cleanup) ==============================
const PRESERVE_SELECTORS = [
    'pre', 'code', 'table',
    '[role="table"]', '[role="grid"]',
    'ul', 'ol',
    '.horizontal-scroll-wrapper',
    '.table-block-component',
    'table-block',
    '.table-block',
    '.table-content'
];

const PRESERVE_SELECTOR_JOINED = PRESERVE_SELECTORS.join(', ');

// === buildLocateChatRootScript =============================================
// Returns a JS string that, when executed in the renderer, locates the
// best chat root element and optionally returns its outerHTML.
function buildLocateChatRootScript({ includeHtml = true } = {}) {
    const selectorsJson = JSON.stringify(CHAT_ROOT_SELECTORS);
    const transcriptJson = JSON.stringify(TRANSCRIPT_SELECTORS);
    const includeHtmlLiteral = includeHtml ? 'true' : 'false';
    return `
(function () {
    const candidates = ${selectorsJson};
    const transcriptSelectors = ${transcriptJson};
    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect?.();
        return !!r && r.width > 0 && r.height > 0;
    }
    function textOf(el) {
        try { return String(el?.innerText || el?.textContent || ''); } catch { return ''; }
    }
    function count(el, sel) {
        try { return el?.querySelectorAll?.(sel)?.length || 0; } catch { return 0; }
    }
    function semanticBonus(el) {
        try {
            let bonus = 0;
            if (el.matches?.('message-content, .markdown.markdown-main-panel, [id^="model-response-message-content"]')) bonus += 1400;
            if (el.matches?.('structured-content-container, .model-response-text')) bonus += 1000;
            if (el.matches?.('.response-content, .response-container-content, .presented-response-container')) bonus += 700;
            if (count(el, 'table, .horizontal-scroll-wrapper, .table-block-component, table-block') > 0) bonus += 180;
            return bonus;
        } catch { return 0; }
    }
    function chromePenalty(el) {
        try {
            let penalty = 0;
            if (el.matches?.('${CHROME_PENALTY_SELECTOR}')) penalty += 2200;
            const cls = String(el.className || '');
            if (${CHROME_PENALTY_REGEX}.test(cls)) penalty += 1200;
            return penalty;
        } catch { return 0; }
    }
    function editablePenalty(el) {
        const selfEditable = !!el?.matches?.('textarea, input, [contenteditable="true"], div[role="textbox"]');
        if (selfEditable) return 2000;
        return (count(el, 'textarea, input, [contenteditable="true"], div[role="textbox"]') * 900)
            + (count(el, 'form') * 300)
            + (count(el, '[role="button"], button') * 8);
    }
    function score(el) {
        if (!el || !visible(el)) return -1;
        const text = textOf(el).trim();
        const len = Math.min(text.length, 5000);
        const articleCount = count(el, '[role="article"], article');
        const responseCount = count(el, 'message-content, .markdown, [id^="model-response-message-content"], structured-content-container, .model-response-text, .response-content, .response-container-content, .presented-response-container, .conversation-container, [class="response-container"]');
        const richCount = count(el, 'table, pre, code, ul, ol, blockquote');
        const scrollable = (() => {
            try {
                const cs = getComputedStyle(el);
                return (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) ? 1 : 0;
            } catch { return 0; }
        })();
        return 1000
            + Math.min(len, 1600)
            + (articleCount * 90)
            + (responseCount * 60)
            + (richCount * 25)
            + (scrollable * 50)
            + semanticBonus(el)
            - chromePenalty(el)
            - editablePenalty(el);
    }
    const found = [];
    for (const sel of candidates) {
        try {
            document.querySelectorAll(sel).forEach((root) => {
                found.push({ sel, el: root });
                transcriptSelectors.forEach((childSel) => {
                    try { root.querySelectorAll(childSel).forEach((el) => found.push({ sel: childSel, el })); } catch {}
                });
            });
        } catch {}
    }
    if (!found.length) return null;
    const scored = found
        .map(({ sel, el }) => ({ sel, el, score: score(el), textLength: textOf(el).trim().length }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.textLength - a.textLength;
        });
    const best = scored[0];
    if (!best || !best.el) return null;
    return {
        selector: best.sel,
        html: ${includeHtmlLiteral} ? best.el.outerHTML : '',
        textLength: Number(best.textLength || 0),
        score: Number(best.score || 0)
    };
})();
`;
}

// === cleanupDOMFragmentScript ==============================================
// Returns renderer-side JS that cleans a cloned DOM fragment.
function cleanupDOMFragmentScript() {
    const junkJson = JSON.stringify(DOM_CLEANUP_SELECTORS);
    const preserveJson = JSON.stringify(PRESERVE_SELECTORS);
    return `
(function(clone) {
    const JUNK = ${junkJson};
    const PRESERVE = ${preserveJson};
    const PRESERVE_JOINED = PRESERVE.join(', ');
    clone.querySelectorAll(JUNK.join(',')).forEach(el => {
        try { el.remove(); } catch {}
    });
    clone.querySelectorAll(PRESERVE_JOINED).forEach(el => {
        try { el.setAttribute('data-preserve', 'true'); } catch {}
    });
    clone.querySelectorAll('[data-preserve]').forEach(el => {
        try {
            el.querySelectorAll('*').forEach(child => child.setAttribute('data-preserve-descendant', 'true'));
        } catch {}
    });
    return clone;
})
`;
}

// === buildChatPaneDetectionScript ==========================================
// Returns JS that detects and selects the chat pane for
// operations like "Select Chat Pane".
function buildChatPaneDetectionScript({ selectContent = false, scrollIntoView = false } = {}) {
    const rootJson = JSON.stringify(CHAT_ROOT_SELECTORS);
    const transcriptJson = JSON.stringify(TRANSCRIPT_SELECTORS);
    return `
(function () {
    const candidates = ${rootJson};
    const transcriptSelectors = ${transcriptJson};
    ${buildLocateChatRootScript.__scoringBody || '/* scoring inlined */'}
    // (scoring functions are inlined from buildLocateChatRootScript)
    // This is a simplified version that returns { ok, selectedTextLength }
    ${selectContent ? `
    const sel = window.getSelection?.();
    if (!sel) return { ok: false, selectedTextLength: 0 };
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(best);
    sel.addRange(range);
    const txt = String(sel.toString() || '');
    return { ok: !!txt.length, selectedTextLength: txt.length };
    ` : `
    return { ok: true, textLength: best ? textOf(best).trim().length : 0 };
    `}
})();
`;
}

// ============================================================================
module.exports = {
    CHAT_SELECTOR,
    CHAT_ROOT_SELECTORS,
    CHAT_MESSAGE_LIST_SELECTORS,
    CHAT_SCOPE_SELECTOR,
    CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_SELECTOR,
    CHAT_MESSAGE_LIST_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    CODE_PREVIEW_IFRAME_SELECTOR,
    TRANSCRIPT_SELECTORS,
    DOM_CLEANUP_SELECTORS,
    CHROME_PENALTY_SELECTOR,
    CHROME_PENALTY_REGEX,
    USER_PROMPT_SELECTOR,
    USER_PROMPT_REGEX,
    TABLE_SIGNAL_SELECTORS,
    TABLE_SIGNAL_SELECTOR_JOINED,
    TABLE_SIGNAL_HTML_REGEX,
    PROMOTION_STOP_SELECTOR,
    PROMOTION_CANDIDATE_SELECTOR,
    PROMOTION_CANDIDATE_REGEX,
    PRESERVE_SELECTORS,
    PRESERVE_SELECTOR_JOINED,
    messageContentById,
    buildLocateChatRootScript,
    cleanupDOMFragmentScript,
    buildChatPaneDetectionScript,
};
