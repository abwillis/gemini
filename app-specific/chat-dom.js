// lib/chat-dom.js  — Gemini-specific DOM selector constants
// This module is NOT shared between apps; each app has its own chat-dom.js
// that exports the same shape of API but with app-specific selectors.
'use strict';

// === Selector constants (Gemini UI 2024/2025) ==============================

const CHAT_ROOT_SELECTORS = [
    '#mainChat',
    '#chat-history',
    'infinite-scroller',
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

// Renderer-agent configuration.  These values remain Gemini-specific while
// renderer/agent.js and the main-process consumers remain project-neutral.
const DOM_PRESERVE_CONTENT_SELECTORS = [
    '[data-preserve]',
    ...PRESERVE_SELECTORS,
    'img',
    'picture',
    'svg',
    'canvas',
    'video',
    'iframe'
];

const VIRTUALIZER_SELECTORS = [
    'infinite-scroller',
    '#chat-history',
    '.conversation-container',
    '[data-test-id="chat-app"]'
];

const DOM_SCORE_RULES = [
    { selector: 'message-content', weight: 80 },
    { selector: 'model-response', weight: 70 },
    { selector: 'user-query', weight: 45 },
    { selector: '[role="article"]', weight: 25 },
    { selector: '.conversation-container', weight: 50 }
];

const DOM_COLLECTION_SELECTORS = [
    'user-query',
    'model-response',
    'message-content',
    '[id^="model-response-message-content"]',
    '.response-container',
    '[role="article"]'
];

// Which collection selectors identify a user turn and which an assistant turn.
// The shared renderer agent classifies rows with these lists instead of
// guessing from keywords in the selector text.
const DOM_ROLE_SELECTORS = Object.freeze({
    user: Object.freeze([
        'user-query'
    ]),
    assistant: Object.freeze([
        'model-response',
        '[id^="model-response-message-content"]',
        '.response-container'
    ])
});

// Gemini has no verified answer label in its DOM text, so none is searched
// for. Set these (see Copilot's chat-dom.js) only after confirming the label.
const ANSWER_MARKER = '';
const ANSWER_LEADING_LABELS = Object.freeze([]);

const DOM_COLLECTION_ROW_SELECTORS = [
    'infinite-scroller',
    '.conversation-container',
    '[class*="conversation" i]'
];

const DOM_COLLECTION_EXCLUDE_SELECTORS = [
    'message-actions',
    '.response-footer',
    '.response-container-footer',
    'sources-list',
    'tts-control',
    'bard-avatar',
    '.avatar-gutter'
];

const DOM_COLLECTION_KEY_ATTRIBUTES = [
    'data-message-id',
    'data-test-id',
    'id',
    'aria-label'
];

const CHAT_INPUT_SELECTORS = [
    'rich-textarea textarea',
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]'
];

// === Reasoning / chain-of-thought expand controls ==========================
// Intentionally EMPTY (explicit no-op). The shared main.js imports this and
// passes it to renderer/agent.js as reasoningExpandSelectors; agent.js only
// acts when the array is non-empty, so an empty list disables reasoning-panel
// expansion for Gemini rather than leaving the value accidentally undefined.
// Gemini's reasoning DOM ("Show thinking") has not been mapped yet -- populate
// with app-correct [aria-expanded="false"] selectors to enable the feature.
const REASONING_EXPAND_SELECTORS = [];

// ============================================================================
// Formal capability contract consumed by renderer/agent.js. Selectors remain
// provider-specific evidence sources; no selector is treated as authoritative
// without structural and behavioral validation in the shared agent.
const DOM_ADAPTER_CONTRACT = Object.freeze({
    version: 1,
    thresholds: Object.freeze({ read: 55, interact: 70, destructive: 85 }),
    negativeRegionSelectors: Object.freeze([
        'nav', 'header', 'aside', '[role="navigation"]', '[role="toolbar"]',
        '[role="dialog"]', '[role="search"]', '[role="menu"]'
    ]),
    capabilities: Object.freeze({
        chatRoot: Object.freeze({
            selectors: CHAT_ROOT_SELECTORS,
            semanticSelectors: Object.freeze(['[role="feed"]', '[role="log"]', 'main', '[role="main"]']),
            repeatedDescendants: DOM_COLLECTION_SELECTORS,
            stableAttributeHints: Object.freeze(['chat', 'message', 'feed', 'conversation'])
        }),
        messageRow: Object.freeze({
            selectors: DOM_COLLECTION_ROW_SELECTORS,
            semanticSelectors: Object.freeze(['article', '[role="article"]', '[aria-posinset]']),
            stableAttributeHints: Object.freeze(['message', 'turn', 'response', 'request'])
        }),
        composer: Object.freeze({
            selectors: CHAT_INPUT_SELECTORS,
            semanticSelectors: Object.freeze(['textarea', '[contenteditable="true"]', '[role="textbox"]']),
            stableAttributeHints: Object.freeze(['composer', 'prompt', 'chat-input', 'message-input'])
        }),
        disclosureControl: Object.freeze({
            selectors: REASONING_EXPAND_SELECTORS.concat([
                'button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'
            ]),
            semanticSelectors: Object.freeze([
                'button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'
            ]),
            stableAttributeHints: Object.freeze(['expand', 'collapse', 'disclosure', 'reasoning', 'show-more'])
        }),
        virtualizer: Object.freeze({
            selectors: VIRTUALIZER_SELECTORS,
            stableAttributeHints: Object.freeze(['virtual', 'scroll', 'message-list'])
        })
    })
});

const DOM_CLEANUP_POLICY = Object.freeze({
    // Broad selectors nominate candidates only. The shared agent removes or
    // unwraps a candidate only after interactive and content-preservation checks.
    candidateSelectors: Object.freeze(DOM_CLEANUP_SELECTORS.concat([
        'button', '[role="button"]', '[role="toolbar"]', '[role="menu"]',
        '[role="menuitem"]', '[aria-haspopup]'
    ])),
    interactiveSelectors: Object.freeze([
        'button', '[role="button"]', '[role="toolbar"]', '[role="menu"]',
        '[role="menuitem"]', '[aria-haspopup]'
    ]),
    preserveSelectors: Object.freeze(Array.from(new Set(
        DOM_PRESERVE_CONTENT_SELECTORS.concat([
            'a[href]', '[data-preserve]', '[data-testid*="citation" i]',
            '[data-testid*="reference" i]', '[data-file-name]',
            '[data-attachment]', '[class*="attachment" i]'
        ])
    )))
});

module.exports = {
    CHAT_ROOT_SELECTORS,
    CHAT_MESSAGE_LIST_SELECTORS,
    CHAT_SCOPE_SELECTOR,
    CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_SELECTOR,
    CHAT_MESSAGE_LIST_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    CODE_PREVIEW_IFRAME_SELECTOR,
    DOM_CLEANUP_SELECTORS,
    DOM_CLEANUP_POLICY,
    DOM_ADAPTER_CONTRACT,
    DOM_PRESERVE_CONTENT_SELECTORS,
    VIRTUALIZER_SELECTORS,
    DOM_SCORE_RULES,
    DOM_COLLECTION_SELECTORS,
    DOM_ROLE_SELECTORS,
    ANSWER_MARKER,
    ANSWER_LEADING_LABELS,
    DOM_COLLECTION_ROW_SELECTORS,
    DOM_COLLECTION_EXCLUDE_SELECTORS,
    DOM_COLLECTION_KEY_ATTRIBUTES,
    CHAT_INPUT_SELECTORS,
    REASONING_EXPAND_SELECTORS,
    messageContentById,
};
