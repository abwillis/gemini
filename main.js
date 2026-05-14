// main.js — Gemini for Linux (refactored orchestrator)
'use strict';

const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { createIPC } = require('./lib/ipc');
// === App-specific modules ===
const {
    CHAT_ROOT_SELECTORS, CHAT_MESSAGE_LIST_SELECTORS,
    CHAT_SCOPE_SELECTOR, CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_SELECTOR, CHAT_MESSAGE_LIST_PSEUDO,
    EXPORT_ROOT_CLASS, EXPORT_ROOT_SELECTOR,
    CODE_PREVIEW_IFRAME_SELECTOR, DOM_CLEANUP_SELECTORS,
    cleanupDOMFragmentScript, buildChatPaneDetectionScript,
    buildLocateChatRootScript,
} = require('./lib/chat-dom');

const {
    SELECTORS, IGNORE_SELECTORS, IGNORE_JOINED,
    messageContentById, MAX_CHARS, VW_SIZE, MIN_VW, MAX_VW,
    applyDynamicWidth, attachVWResize, buildMaxLayoutCSS,
    maxLayoutCssCache, injectedFrameIdsByWC, insertedMainCssKeyByWC, cssApplyDebounceByWC,
    injectCSSOnLoad, injectCSSIntoAllFrames, applyMaxLayoutCSS, requestExpandedLayout,
    buildFindContentVisibilityCSS, enableFindContentVisibility, disableFindContentVisibility,
} = require('./lib/layout-css');

// === Shared modules ===
const { createWindowState } = require('./lib/window-state');
const { createQuickChatManager } = require('./lib/quick-chat');
const { createFindInPage } = require('./lib/find-in-page');
const { createDirectOpen } = require('./lib/direct-open');
const { createSessionHelpers } = require('./lib/session-helpers');
const { createContextMenu } = require('./lib/context-menu');
const { createAppMenu } = require('./lib/app-menu');
const { createExporters, EXPORT_SCOPES } = require('./lib/exporters');

// ============================================================================
// App identity & constants
// ============================================================================
const APP_LABEL = 'Gemini';
const APP_SLUG  = 'gemini';

let GEMINI_URL       = 'https://gemini.google.com';
let GEMINI_PARTITION = String(process.env.GEMINI_PARTITION ?? 'persist:gemini-for-linux').trim();

const IPC = createIPC(APP_SLUG);

const SEND_MODE = Object.freeze({ PLAIN: 'plain', QUOTE: 'quote' });

const DEFAULT_APP_CONFIG = Object.freeze({
    appUrl: GEMINI_URL,
    partition: GEMINI_PARTITION,
    enableLayoutCss: true,
    enableDirectOpen: true,
    enableQuickChat: true,
    defaultExportFormat: 'md',
    defaultPaneExportProfile: 'cleanMarkdown',
    defaultSelectionExportProfile: 'cleanMarkdown',
    quickPasteDelayMs: 3000,
    findContentVisibilityOverride: false,
    devToolsEnabled: true,
    enableConsoleLogging: true,
    enableFileLogging: false,
    logFileName: 'gemini-for-linux.log',
});

let APP_CONFIG = { ...DEFAULT_APP_CONFIG };

// ============================================================================
// Config file — auto-create, load, merge with defaults
// ============================================================================
function getConfigFilePath() {
    return path.join(app.getPath('userData'), 'config.json');
}

function getLogFilePath() {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    return path.join(logsDir, APP_CONFIG.logFileName || DEFAULT_APP_CONFIG.logFileName);
}

function ensureConfigFile() {
    const cfgPath = getConfigFilePath();
    let existing = {};
    try {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        existing = JSON.parse(raw);
        if (!existing || typeof existing !== 'object') existing = {};
    } catch {
        // File missing or corrupt — will be (re)created below
    }
    // Merge: existing keys win, new defaults are added
    const merged = { ...DEFAULT_APP_CONFIG, ...existing };
    // Validate / coerce types
    merged.appUrl = String(merged.appUrl || DEFAULT_APP_CONFIG.appUrl).trim();
    merged.partition = String(
        process.env.GEMINI_PARTITION ?? merged.partition ?? DEFAULT_APP_CONFIG.partition
    ).trim();
    if (typeof merged.enableLayoutCss !== 'boolean')             merged.enableLayoutCss = DEFAULT_APP_CONFIG.enableLayoutCss;
    if (typeof merged.enableDirectOpen !== 'boolean')            merged.enableDirectOpen = DEFAULT_APP_CONFIG.enableDirectOpen;
    if (typeof merged.enableQuickChat !== 'boolean')             merged.enableQuickChat = DEFAULT_APP_CONFIG.enableQuickChat;
    if (typeof merged.findContentVisibilityOverride !== 'boolean') merged.findContentVisibilityOverride = DEFAULT_APP_CONFIG.findContentVisibilityOverride;
    if (typeof merged.devToolsEnabled !== 'boolean')             merged.devToolsEnabled = DEFAULT_APP_CONFIG.devToolsEnabled;
    if (typeof merged.enableConsoleLogging !== 'boolean')        merged.enableConsoleLogging = DEFAULT_APP_CONFIG.enableConsoleLogging;
    if (typeof merged.enableFileLogging !== 'boolean')           merged.enableFileLogging = DEFAULT_APP_CONFIG.enableFileLogging;
    if (typeof merged.quickPasteDelayMs !== 'number')            merged.quickPasteDelayMs = DEFAULT_APP_CONFIG.quickPasteDelayMs;
    if (!merged.appUrl) merged.appUrl = DEFAULT_APP_CONFIG.appUrl;
    merged.logFileName = String(merged.logFileName || DEFAULT_APP_CONFIG.logFileName)
        .replace(/[^a-zA-Z0-9._-]/g, '-');
    // Write back (adds any new keys introduced in this version)
    try {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to write config file:', err);
    }
    return merged;
}

function loadAppConfig() {
    const merged = ensureConfigFile();
    APP_CONFIG = merged;
    // Let config override the compile-time URL and partition
    GEMINI_URL = APP_CONFIG.appUrl || GEMINI_URL;
    GEMINI_PARTITION = APP_CONFIG.partition || GEMINI_PARTITION;
    return APP_CONFIG;
}

// ============================================================================
// Dual-channel logging — console + file
// ============================================================================
function setupLogging() {
    const config = APP_CONFIG;
    const origLog   = console.log.bind(console);
    const origInfo  = console.info.bind(console);
    const origDebug = console.debug.bind(console);
    const origWarn  = console.warn.bind(console);
    const origError = console.error.bind(console);

    // Suppress console output if disabled (but keep originals for file logging)
    const noop = () => {};
    const cLog   = config.enableConsoleLogging ? origLog   : noop;
    const cInfo  = config.enableConsoleLogging ? origInfo  : noop;
    const cDebug = config.enableConsoleLogging ? origDebug : noop;
    const cWarn  = config.enableConsoleLogging ? origWarn  : noop;
    const cError = config.enableConsoleLogging ? origError : noop;

    if (!config.enableFileLogging) {
        // No file logging — just apply console suppression if needed
        console.log = cLog; console.info = cInfo; console.debug = cDebug;
        console.warn = cWarn; console.error = cError;
        return;
    }

    // File logging enabled
    const logPath = getLogFilePath();

    function formatArgs(args) {
        return args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
    }

    function appendToLog(level, args) {
        try {
            const timestamp = new Date().toISOString();
            const line = `[${timestamp}] [${level}] ${formatArgs(args)}\n`;
            fs.appendFileSync(logPath, line, 'utf8');
        } catch {}
    }

    console.log   = (...args) => { cLog(...args);   appendToLog('LOG',   args); };
    console.info  = (...args) => { cInfo(...args);  appendToLog('INFO',  args); };
    console.debug = (...args) => { cDebug(...args); appendToLog('DEBUG', args); };
    console.warn  = (...args) => { cWarn(...args);  appendToLog('WARN',  args); };
    console.error = (...args) => { cError(...args); appendToLog('ERROR', args); };
}

// --- Initialize config + logging before anything else ---
try { loadAppConfig(); } catch (err) { console.error('Config load failed:', err); }
try { setupLogging(); } catch (err) { console.error('Logging setup failed:', err); }

function getAppConfig() { return APP_CONFIG; }

// ============================================================================
// State
// ============================================================================
let mainWindow  = null;
let tray        = null;
let isQuitting  = false;
let appIconImage = null;
let trayImage24  = null;

// ============================================================================
// Utility
// ============================================================================
function reveal(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch {}
}

function safeShowError(title, message) {
    try { dialog.showErrorBox(String(title ?? 'Error'), String(message ?? 'An error occurred')); }
    catch (err) { console.error('Could not show error dialog:', err); }
}

// ============================================================================
// Window-state persistence
// ============================================================================
const windowState = createWindowState({ app, screen, fs, path });
const { loadWindowState, getInitialWindowBounds, scheduleSaveWindowState } = windowState;

function attachWindowStatePersistence(win, boundsKey) {
    win.on('resize', () => scheduleSaveWindowState(win, boundsKey));
    win.on('move',   () => scheduleSaveWindowState(win, boundsKey));
    win.on('close',  () => scheduleSaveWindowState(win, boundsKey));
}

// ============================================================================
// did-stop-loading handler
// ============================================================================
function onDidStopLoading() {
    try { /* placeholder for post-load logic */ } catch (err) { console.error('did-stop-loading handler error:', err); }
}

function ensureDidStopLoadingHandler(webContents) {
    if (!webContents) return;
    if (webContents.__hasDidStopLoadingHandler) return;
    webContents.__hasDidStopLoadingHandler = true;
    webContents.on('did-stop-loading', onDidStopLoading);
}

// ============================================================================
// CSS & layout attachment helper
// ============================================================================
function attachCSSAndLayoutHandlers(win) {
    if (!win) return;
    try {
        win.webContents.once('did-stop-loading', () => {
            setTimeout(() => {
                try { applyMaxLayoutCSS(win); }
                catch (e) { console.error('applyMaxLayoutCSS (deferred) failed:', e); }
            }, 10);
        });
    } catch (e) { console.error('applyMaxLayoutCSS defer wiring failed:', e); }
}

// ============================================================================
// Find-result forwarding helper
// ============================================================================
function attachFindResultForwarding(win) {
    if (!win?.webContents) return;
    if (win.webContents.__findResultForwardingAttached) return;
    win.webContents.__findResultForwardingAttached = true;
    win.webContents.on('found-in-page', (_event, result) => { /* log or forward */ });
}

// ============================================================================
// Session helpers
// ============================================================================

const sessionHelpers = createSessionHelpers({
    app, dialog, shell, session, clipboard, nativeImage, fs, path,
    BrowserWindow,
    appLabel: APP_LABEL,
    getAppConfig,
    getAppPartition: () => GEMINI_PARTITION,
    getAppUrl: () => GEMINI_URL,
    getConfigFilePath,
    getLogFilePath,
    ensureConfigFile,
    getMainWindow: () => mainWindow,
    getAppIconImage: () => appIconImage,
    safeShowError,
    refreshTrayMenu,
    refreshQuickChatMenu: () => { try { initQuickChat().refreshQuickChatMenu(); } catch {} },
});
const {
    getRuntimeInfo, showAboutDialog, showApplicationHelp,
    reloadApp, clearAppCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal,
    getAppSession, openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop,
} = sessionHelpers;

// ============================================================================
// Utility — executeInAllFrames
// ============================================================================
async function executeInAllFrames(win, script) {
    if (!win?.webContents) return [];
    const wc = win.webContents;
    const results = [];
    // Main frame
    try {
        const value = await wc.executeJavaScript(script);
        results.push({ frameId: 0, value });
    } catch {}
    // Sub-frames
    try {
        const frames = wc.mainFrame?.framesInSubtree ?? wc.mainFrame?.frames ?? [];
        for (const frame of frames) {
            if (frame === wc.mainFrame) continue;
            try {
                const value = await frame.executeJavaScript(script);
                results.push({ frameId: frame.routingId ?? -1, value });
            } catch {}
        }
    } catch {}
    return results;
}

// ============================================================================
// Utility — normalizeExportFormat
// ============================================================================
function normalizeExportFormat(fmt, fallback = 'md') {
    const normalized = String(fmt ?? fallback ?? 'md').trim().toLowerCase();
    const map = { markdown: 'md', md: 'md', html: 'html', mhtml: 'mhtml', txt: 'txt', pdf: 'pdf', text: 'txt' };
    return map[normalized] ?? normalized;
}

// ============================================================================
// Exporters
// ============================================================================
const exporters = createExporters({
    app, fs, path, dialog, clipboard, shell,
    BrowserWindow,
    safeShowError,
    getMainWindow: () => mainWindow,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    CHAT_ROOT_SELECTORS, CHAT_MESSAGE_LIST_SELECTORS,
    CHAT_SCOPE_SELECTOR, CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_SELECTOR, CHAT_MESSAGE_LIST_PSEUDO,
    EXPORT_ROOT_CLASS, EXPORT_ROOT_SELECTOR,
    CODE_PREVIEW_IFRAME_SELECTOR,
    DOM_CLEANUP_SELECTORS, cleanupDOMFragmentScript,
    buildLocateChatRootScript,
    buildChatPaneDetectionScript,
    executeInAllFrames,
    normalizeExportFormat,
    appSlug: APP_SLUG,
    appLabel: APP_LABEL,
});
const {
    getSelectionFragment, htmlToMarkdown,
    buildSelectionMarkdownForExport,
    selectChatPane, promptSaveChatPane, saveSelectionAsMarkdown,
    saveSelectionAsText,
    buildExportProfileMenuTemplate, promptExportWithProfile,
} = exporters;

// ============================================================================
// Context menu
// ============================================================================
const contextMenuModule = createContextMenu({
    Menu, MenuItem, dialog, shell, clipboard,
    BrowserWindow,
    getMainWindow: () => mainWindow,
    getAppConfig,
    SEND_MODE,
    EXPORT_SCOPES,
    reveal, safeShowError,
    // From exporters
    selectChatPane, promptSaveChatPane,
    getSelectionFragment, htmlToMarkdown,
    buildSelectionMarkdownForExport,
    saveSelectionAsMarkdown, saveSelectionAsText,
    promptExportWithProfile, buildExportProfileMenuTemplate,
    // Quick Chat (lazy)
    buildSendToQuickSubmenu: (...args) => initQuickChat().buildSendToQuickSubmenu(...args),
    createQuickChatWindow: (...args) => initQuickChat().createQuickChatWindow(...args),
    // Find
    openFindModal: (...args) => findInPage.openFindModal(...args),
});
const { buildContextMenuTemplate } = contextMenuModule;

// ============================================================================
// Quick Chat manager
// ============================================================================
let quickChatManager = null;
function initQuickChat() {
    if (quickChatManager) return quickChatManager;
    quickChatManager = createQuickChatManager({
        app, BrowserWindow, Menu, MenuItem, ipcMain, dialog, shell, clipboard, path,
        dirname: __dirname,
        getMainWindow: () => mainWindow,
        getAppIconImage: () => appIconImage,
        getAppConfig,
        DEFAULT_APP_CONFIG,
        appSlug: APP_SLUG,
        getAppUrl: () => GEMINI_URL,
        getAppPartition: () => GEMINI_PARTITION,
        SEND_MODE, IPC, reveal, safeShowError,
        getInitialWindowBounds,
        attachWindowStatePersistence,
        attachCSSAndLayoutHandlers,
        attachFindResultForwarding,
        ensureDidStopLoadingHandler,
        onDidStopLoading,
        buildContextMenuTemplate,
        getSelectionFragment, htmlToMarkdown,
        refreshTrayMenu,
        appLabel: APP_LABEL,
    });
    quickChatManager.registerIpcHandlers();
    return quickChatManager;
}

// ============================================================================
// Find-in-page
// ============================================================================
const findInPage = createFindInPage({
    BrowserWindow, Menu, ipcMain, screen,
    getMainWindow: () => mainWindow,
    getAppConfig, enableFindContentVisibility,
    disableFindContentVisibility,
});

// direct-open initialization
const directOpen = createDirectOpen({
    session, shell, fs, path, app, ipcMain,
    getAppConfig,
    getAppPartition: () => GEMINI_PARTITION,
    appSlug: APP_SLUG,
    safeShowError,
});

// ============================================================================
// Utility — ensureSaveState
// ============================================================================
function ensureSaveState(win) {
    if (!win) return;
    if (win.__saveStateInitialized) return;
    win.__saveStateInitialized = true;
}

// ============================================================================
// App menu
// ============================================================================
const appMenu = createAppMenu({
    app, Menu, MenuItem, dialog, shell, BrowserWindow, ipcMain, clipboard,
    getMainWindow: () => mainWindow,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    appLabel: APP_LABEL,
    reveal, safeShowError,
    // From session helpers
    getRuntimeInfo, showAboutDialog, showApplicationHelp,
    reloadApp, clearAppCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal,
    // From exporters
    selectChatPane, promptSaveChatPane, saveSelectionAsMarkdown,
    buildExportProfileMenuTemplate, promptExportWithProfile,
    EXPORT_SCOPES,
    // Find
    openFindModal: (...args) => findInPage.openFindModal(...args),
    initFindInPage: () => findInPage,
    // Quick Chat (lazy — initQuickChat returns the manager)
    buildQuickChatManagerMenuTemplate: (...args) => initQuickChat().buildQuickChatManagerMenuTemplate(...args),
    installQuickChatMenu: (...args) => initQuickChat().installQuickChatMenu(...args),
    refreshQuickChatMenu: (...args) => initQuickChat().refreshQuickChatMenu(...args),
    createQuickChatWindow: (...args) => initQuickChat().createQuickChatWindow(...args),
    buildSendToQuickSubmenu: (...args) => initQuickChat().buildSendToQuickSubmenu(...args),
    // Other
    buildContextMenuTemplate,
    getAppIconImage: () => appIconImage,
    SEND_MODE,
    ensureSaveState, 
    openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop,
    initQuickChat,
});

// ============================================================
// Tray menu (rebuilt when Quick Chat windows change)
// ============================================================
function refreshTrayMenu() {
    if (!tray) return;
    const items = [
        { label: 'Show', click: () => { if (mainWindow) reveal(mainWindow); } },
        { label: 'Hide', click: () => { if (mainWindow) mainWindow.hide(); } },
        { type: 'separator' },
    ];
    // Quick Chat windows
    try {
        const qm = initQuickChat();
        const ids = qm.listQuickIds();
        if (ids.length) {
            items.push({ label: 'New Quick Chat', click: () => initQuickChat().createQuickChatWindow() });
            items.push({ label: 'Show Active Quick Chat', click: () => {
                const w = initQuickChat().getActiveQuickChatWindow();
                if (w) reveal(w);
            }});
            for (const id of ids) {
                items.push({
                    label: `Quick Chat ${id}`,
                    click: () => { const w = qm.getQuickById(id); if (w) reveal(w); },
                });
            }
            items.push({ type: 'separator' });
        }
    } catch {}
    // Save Chat Pane
    items.push({
        label: 'Save Chat Pane',
        click: () => { if (mainWindow) promptSaveChatPane(mainWindow); }
    });
    items.push({ type: 'separator' });
    // Session management
    items.push({
        label: 'Reload',
        click: () => reloadApp({ ignoreCache: false })
    });
    items.push({
        label: 'Toggle Always on Top',
        click: () => toggleActiveWindowAlwaysOnTop()
    });
    items.push({
        label: 'Clear Session/Cache',
        submenu: [
            { label: 'Clear ' + APP_LABEL + ' Cache', click: () => clearAppCache() },
            { label: 'Clear Cookies / Sign Out', click: () => clearCookiesAndSignOut() },
        ]
    });
    items.push({ type: 'separator' });
    // Config & Logs
    items.push({
        label: 'Open Logs Folder',
        click: () => openLogsFolder()
    });
    items.push({
        label: 'Open Config File',
        click: () => openConfigFile()
    });
    items.push({ type: 'separator' });
    // About & Quit
    items.push({ label: 'About', click: () => showAboutDialog() });
    items.push({ type: 'separator' });
    items.push({ label: 'Quit', click: () => { isQuitting = true; app.quit(); } });

    tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ============================================================
// Icon helper
// ============================================================
function getIconPath(filename) {
    const basePath = app.getAppPath();
    const iconPath = path.join(basePath, 'assets', filename);
    if (app.isPackaged) {
        const asarPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', filename);
        if (fs.existsSync(asarPath)) return asarPath;
    }
    return iconPath;
}

// ============================================================
// createWindow
// ============================================================
function createWindow() {
    if (mainWindow) return;

    const taIcon = nativeImage.createFromPath(getIconPath('gemini-for-linux.png'));
    if (!appIconImage || appIconImage.isEmpty()) appIconImage = taIcon;
    console.log('ICON DEBUG:', 'empty:', appIconImage.isEmpty(), 'size:', appIconImage.getSize());
    if (!trayImage24 || trayImage24.isEmpty?.()) {
        try { trayImage24 = taIcon.resize({ width: 24, height: 24 }); } catch {}
    }

    const boundsKey = 'main';
    const initialBounds = getInitialWindowBounds(boundsKey);

    mainWindow = new BrowserWindow({
        skipTaskbar: false,
        title: `${APP_LABEL} Main Chat`,
        width: initialBounds.width,
        height: initialBounds.height,
        x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
        y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
        show: false,
        icon: appIconImage || taIcon,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
            partition: GEMINI_PARTITION,
            devTools: true,
            backgroundThrottling: true,
            spellcheck: false,
        },
        type: 'normal',
        autoHideMenuBar: false,
    });

    mainWindow.setMenuBarVisibility(true);

    mainWindow.once('ready-to-show', () => {
        reveal(mainWindow);
        try { mainWindow.__appRole = 'main'; } catch {}
        try { mainWindow.__boundsKey = boundsKey; } catch {}
        appMenu.augmentApplicationMenu(mainWindow);
    });

    mainWindow.setSkipTaskbar(false);
    ensureDidStopLoadingHandler(mainWindow.webContents);
    mainWindow.webContents.setMaxListeners(0);
    mainWindow.loadURL(GEMINI_URL);

    attachCSSAndLayoutHandlers(mainWindow);
    attachWindowStatePersistence(mainWindow, boundsKey);
    attachFindResultForwarding(mainWindow);

    // Context menu
    mainWindow.webContents.on('context-menu', (_event, params) => {
        let menu;
        try {
            menu = Menu.buildFromTemplate(
                buildContextMenuTemplate(mainWindow, params, {
                    includeQuickChatFeatures: true,
                    includeChatPaneFeatures: true,
                    includeMarkdownExport: true,
                })
            );
        } catch (err) {
            console.error('Context menu template error:', err);
            const hasSelection = !!params?.selectionText && params.selectionText.length > 0;
            menu = Menu.buildFromTemplate([{ role: 'copy', enabled: hasSelection }, { role: 'selectAll' }]);
        }
        try { menu.popup({ window: mainWindow }); }
        catch (err) { console.error('Context menu popup failed:', err); }
    });

    // External links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => (
        shell.openExternal(url), { action: 'deny' }
    ));

    // Escape to clear find
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
            const wc = mainWindow.webContents;
            if (wc) wc.stopFindInPage('clearSelection');
        }
    });

    mainWindow.on('close', (e) => {
        if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
// createTray
// ============================================================
function createTray() {
    const iconPath = getIconPath('gemini-for-linux.png');
    const trayImage = trayImage24 || nativeImage.createFromPath(iconPath);
    const smallImage = trayImage.isEmpty ? null : trayImage.resize({ width: 24, height: 24 });

    tray = new Tray(smallImage || appIconImage || nativeImage.createFromPath(
        path.join(__dirname, 'assets', 'gemini-for-linux.png')
    ));
    tray.setToolTip(`${APP_LABEL} for Linux`);
    refreshTrayMenu();

    tray.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else reveal(mainWindow);
    });
}

// ============================================================
// App lifecycle
// ============================================================
app.setName('gemini-for-linux');
app.setAppUserModelId('your.company.gemini');

app.whenReady().then(() => {
    createWindow();
    createTray();
    directOpen.registerDirectOpenDownloadHandler();
    directOpen.registerDirectOpenIpcHandler(IPC);
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
});

app.on('window-all-closed', () => { /* keep tray resident */ });

app.on('before-quit', () => {
    isQuitting = true;
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript(`(function(){
                try {
                    if (window.__gemini_layoutObserver) {
                        window.__gemini_layoutObserver.disconnect();
                        window.__gemini_layoutObserver = null;
                    }
                } catch {}
            })();`).catch(() => {});
        }
        try { initQuickChat().closeAllQuickChatWindows(); } catch {}
    } catch {}
});
