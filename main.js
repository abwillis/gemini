// main.js
'use strict';

const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { createIPC } = require('./lib/ipc');
const { createRuntimeConfig } = require('./lib/runtime-config');
const appConfig = require('./app.config');

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
const APP_LABEL = appConfig.appLabel;
const APP_SLUG  = appConfig.appSlug;

const IPC = createIPC(APP_SLUG);

const SEND_MODE = Object.freeze({
  PLAIN: 'plain',
  QUOTE: 'quote',
});
const LAYOUT_OBSERVER_GLOBAL = appConfig.layoutObserverGlobal;

const DEFAULT_APP_CONFIG = Object.freeze({ ...appConfig.defaultAppConfig });

let APP_URL = DEFAULT_APP_CONFIG.appUrl;
let APP_PARTITION = DEFAULT_APP_CONFIG.partition;

let APP_CONFIG = { ...DEFAULT_APP_CONFIG };

// ============================================================================
// Runtime config/logging
// ============================================================================
const runtimeConfig = createRuntimeConfig({
    app,
    fs,
    path,
    defaultAppConfig: DEFAULT_APP_CONFIG,
    partitionEnvVar: appConfig.partitionEnvVar,
    onConfigLoaded(config) {
        APP_CONFIG = config;
        APP_URL = config.appUrl;
        APP_PARTITION = config.partition;
    },
});

const {
    sanitizeLogFileName,
    getConfigFilePath,
    getLogFilePath,
    formatConsoleArg,
    appendConsoleLogToFile,
    makeConsoleMethod,
    applyConsoleLoggingConfig,
    normalizeBooleanConfig,
    normalizePositiveIntegerConfig,
    normalizeExportFormat,
    normalizeExportProfile,
    normalizeAppConfig,
    writeConfigFile,
    loadAppConfig,
    ensureConfigFile,
    getAppConfig,
} = runtimeConfig;

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
// Session helpers
// ============================================================================
let sessionHelpersInstance = null;
function initSessionHelpers() {
    if (sessionHelpersInstance) return sessionHelpersInstance;
    sessionHelpersInstance = createSessionHelpers({
        app, dialog, shell, session, clipboard, nativeImage, fs, path,
        BrowserWindow,
        appLabel: APP_LABEL,
        getAppConfig,
        getAppPartition: () => APP_PARTITION,
        getAppUrl: () => APP_URL,
        getConfigFilePath,
        getLogFilePath,
        ensureConfigFile,
        getMainWindow: () => mainWindow,
        getAppIconImage: () => appIconImage,
        safeShowError,
        refreshTrayMenu,
        refreshQuickChatMenu: () => { try { initQuickChat().refreshQuickChatMenu(); } catch {} },
    });
    return sessionHelpersInstance;
}

function getRuntimeInfo(...args) { return initSessionHelpers().getRuntimeInfo(...args); }
function showAboutDialog(...args) { return initSessionHelpers().showAboutDialog(...args); }
function showApplicationHelp(...args) { return initSessionHelpers().showApplicationHelp(...args); }
function reloadApp(...args) { return initSessionHelpers().reloadApp(...args); }
function clearAppCache(...args) { return initSessionHelpers().clearAppCache(...args); }
function clearCookiesAndSignOut(...args) { return initSessionHelpers().clearCookiesAndSignOut(...args); }
function copyCurrentUrl(...args) { return initSessionHelpers().copyCurrentUrl(...args); }
function openCurrentUrlExternal(...args) { return initSessionHelpers().openCurrentUrlExternal(...args); }
function getAppSession(...args) { return initSessionHelpers().getAppSession(...args); }
function openLogsFolder(...args) { return initSessionHelpers().openLogsFolder(...args); }
function openConfigFile(...args) { return initSessionHelpers().openConfigFile(...args); }
function toggleActiveWindowAlwaysOnTop(...args) { return initSessionHelpers().toggleActiveWindowAlwaysOnTop(...args); }

// ============================================================================

// Find-in-page
// ============================================================================
let findInPageInstance = null;
function initFindInPage() {
    if (findInPageInstance) return findInPageInstance;
    findInPageInstance = createFindInPage({
        BrowserWindow, Menu, ipcMain, screen,
        getMainWindow: () => mainWindow,
        getAppConfig,
        enableFindContentVisibility,
        disableFindContentVisibility,
    });
    return findInPageInstance;
}

function openFindModal(...args) { return initFindInPage().openFindModal(...args); }
function attachFindResultForwarding(...args) { return initFindInPage().attachFindResultForwarding(...args); }
function resetFindModalResults(...args) { return initFindInPage().resetFindModalResults(...args); }
function sendFindModalResults(...args) { return initFindInPage().sendFindModalResults(...args); }
function getWCFromEventSender(...args) { return initFindInPage().getWCFromEventSender(...args); }
function getWC(...args) { return initFindInPage().getWC(...args); }
function applyWordStartOptions(...args) { return initFindInPage().applyWordStartOptions(...args); }

// direct-open initialization
let directOpenInstance = null;
function initDirectOpen() {
    if (directOpenInstance) return directOpenInstance;
    directOpenInstance = createDirectOpen({
        session, shell, fs, path, app, ipcMain,
        getAppConfig,
        getAppPartition: () => APP_PARTITION,
        appSlug: APP_SLUG,
        safeShowError,
    });
    return directOpenInstance;
}

function registerDirectOpenDownloadHandler() { return initDirectOpen().registerDirectOpenDownloadHandler(); }

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
// Exporters
// ============================================================================
let exportersInstance = null;
function initExporters() {
    if (exportersInstance) return exportersInstance;
    exportersInstance = createExporters({
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
    return exportersInstance;
}

async function findBestChatRoot(...args) { return initExporters().findBestChatRoot(...args); }
async function getChatPaneSnapshot(...args) { return initExporters().getChatPaneSnapshot(...args); }
async function getSelectionFragment(...args) { return initExporters().getSelectionFragment(...args); }
async function getSelectionFragmentRaw(...args) { return initExporters().getSelectionFragmentRaw(...args); }
function htmlToMarkdown(...args) { return initExporters().htmlToMarkdown(...args); }
function stripTags(...args) { return initExporters().stripTags(...args); }
function decodeEntities(...args) { return initExporters().decodeEntities(...args); }
function stripExecutableBlocks(...args) { return initExporters().stripExecutableBlocks(...args); }
async function buildSelectionMarkdownForExport(...args) { return initExporters().buildSelectionMarkdownForExport(...args); }
async function selectChatPane(...args) { return initExporters().selectChatPane(...args); }
async function promptSaveChatPane(...args) { return initExporters().promptSaveChatPane(...args); }
async function saveSelectionAsMarkdown(...args) { return initExporters().saveSelectionAsMarkdown(...args); }
async function saveSelectionAsCleanMarkdown(...args) { return initExporters().saveSelectionAsCleanMarkdown(...args); }
async function saveSelectionAsRawMarkdown(...args) { return initExporters().saveSelectionAsRawMarkdown(...args); }
async function saveSelectionAsMarkdownWithMetadata(...args) { return initExporters().saveSelectionAsMarkdownWithMetadata(...args); }
async function saveSelectionAsHTML(...args) { return initExporters().saveSelectionAsHTML(...args); }
async function saveSelectionAsText(...args) { return initExporters().saveSelectionAsText(...args); }
async function saveSelectionAsPDF(...args) { return initExporters().saveSelectionAsPDF(...args); }
async function saveChatPaneByExtension(...args) { return initExporters().saveChatPaneByExtension(...args); }
async function saveChatPaneByProfile(...args) { return initExporters().saveChatPaneByProfile(...args); }
async function saveSelectionByProfile(...args) { return initExporters().saveSelectionByProfile(...args); }
async function promptExportWithProfile(...args) { return initExporters().promptExportWithProfile(...args); }
function buildExportProfileMenuTemplate(...args) { return initExporters().buildExportProfileMenuTemplate(...args); }
async function saveChatPaneAsMarkdown(...args) { return initExporters().saveChatPaneAsMarkdown(...args); }
async function saveChatPaneAsRawMarkdown(...args) { return initExporters().saveChatPaneAsRawMarkdown(...args); }
async function saveChatPaneAsMarkdownWithMetadata(...args) { return initExporters().saveChatPaneAsMarkdownWithMetadata(...args); }
async function getBestChatRootCleaned(...args) { return initExporters().getBestChatRootCleaned(...args); }
async function saveChatPaneAsText(...args) { return initExporters().saveChatPaneAsText(...args); }
function escapeHtmlForExport(...args) { return initExporters().escapeHtmlForExport(...args); }
function buildPrintableChatPaneHtml(...args) { return initExporters().buildPrintableChatPaneHtml(...args); }
async function writeHtmlDocumentToPDF(...args) { return initExporters().writeHtmlDocumentToPDF(...args); }
async function saveChatPaneAsPDF(...args) { return initExporters().saveChatPaneAsPDF(...args); }
async function saveAsDialog(...args) { return initExporters().saveAsDialog(...args); }

// ============================================================================
// Context menu
// ============================================================================
let contextMenuInstance = null;
function initContextMenu() {
    if (contextMenuInstance) return contextMenuInstance;
    contextMenuInstance = createContextMenu({
        Menu, MenuItem, dialog, shell, clipboard,
        BrowserWindow,
        getMainWindow: () => mainWindow,
        getAppConfig,
        SEND_MODE,
        EXPORT_SCOPES,
        reveal, safeShowError,
        selectChatPane, promptSaveChatPane,
        getSelectionFragment, htmlToMarkdown,
        buildSelectionMarkdownForExport,
        saveSelectionAsMarkdown, saveSelectionAsText,
        promptExportWithProfile, buildExportProfileMenuTemplate,
        buildSendToQuickSubmenu: (...args) => initQuickChat().buildSendToQuickSubmenu(...args),
        createQuickChatWindow: (...args) => initQuickChat().createQuickChatWindow(...args),
        openFindModal: (...args) => initFindInPage().openFindModal(...args),
    });
    return contextMenuInstance;
}

function buildContextMenuTemplate(...args) {
    return initContextMenu().buildContextMenuTemplate(...args);
}

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
        getAppUrl: () => APP_URL,
        getAppPartition: () => APP_PARTITION,
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
let appMenuInstance = null;
function initAppMenu() {
    if (appMenuInstance) return appMenuInstance;
    appMenuInstance = createAppMenu({
        app, Menu, MenuItem, dialog, shell, BrowserWindow, ipcMain, clipboard,
        getMainWindow: () => mainWindow,
        getAppConfig,
        DEFAULT_APP_CONFIG,
        appLabel: APP_LABEL,
        reveal, safeShowError,
        getRuntimeInfo, showAboutDialog, showApplicationHelp,
        reloadApp, clearAppCache, clearCookiesAndSignOut,
        copyCurrentUrl, openCurrentUrlExternal,
        selectChatPane, promptSaveChatPane, saveSelectionAsMarkdown,
        buildExportProfileMenuTemplate, promptExportWithProfile,
        EXPORT_SCOPES,
        openFindModal,
        initFindInPage,
        buildQuickChatManagerMenuTemplate: (...args) => initQuickChat().buildQuickChatManagerMenuTemplate(...args),
        installQuickChatMenu: (...args) => initQuickChat().installQuickChatMenu(...args),
        refreshQuickChatMenu: (...args) => initQuickChat().refreshQuickChatMenu(...args),
        createQuickChatWindow: (...args) => initQuickChat().createQuickChatWindow(...args),
        buildSendToQuickSubmenu: (...args) => initQuickChat().buildSendToQuickSubmenu(...args),
        buildContextMenuTemplate,
        getAppIconImage: () => appIconImage,
        SEND_MODE,
        ensureSaveState,
        openLogsFolder,
        openConfigFile,
        toggleActiveWindowAlwaysOnTop,
        initQuickChat,
    });
    return appMenuInstance;
}

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

    const taIcon = nativeImage.createFromPath(getIconPath(appConfig.iconFileName));
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
            partition: APP_PARTITION,
            devTools: !!APP_CONFIG.devToolsEnabled,
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
        initAppMenu().augmentApplicationMenu(mainWindow);

    });

    mainWindow.setSkipTaskbar(false);
    ensureDidStopLoadingHandler(mainWindow.webContents);
    mainWindow.webContents.setMaxListeners(0);
    mainWindow.loadURL(APP_URL);

    attachCSSAndLayoutHandlers(mainWindow);
    attachWindowStatePersistence(mainWindow, boundsKey);
    initFindInPage().attachFindResultForwarding(mainWindow);

    // Context menu
    mainWindow.webContents.on('context-menu', (_event, params) => {
        let menu;
        try {
            menu = Menu.buildFromTemplate(
                buildContextMenuTemplate(mainWindow, params, {
                    includeQuickChatFeatures: !!APP_CONFIG.enableQuickChat,
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
    const iconPath = getIconPath(appConfig.iconFileName);
    const trayImage = trayImage24 || nativeImage.createFromPath(iconPath);
    const smallImage = trayImage.isEmpty ? null : trayImage.resize({ width: 24, height: 24 });

    tray = new Tray(smallImage || appIconImage || nativeImage.createFromPath(
        path.join(__dirname, 'assets', appConfig.iconFileName)
    ));
    tray.setToolTip(appConfig.trayToolTip || `${APP_LABEL} for Linux`);
    refreshTrayMenu();

    tray.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else reveal(mainWindow);
        refreshTrayMenu();
    });
}

// ============================================================
// App lifecycle
// ============================================================
app.setName(appConfig.appName);
app.setAppUserModelId(appConfig.appUserModelId);

app.whenReady().then(() => {
    loadAppConfig();

    if (APP_CONFIG.enableDirectOpen) {
        initDirectOpen().registerDirectOpenIpcHandler(IPC);
        registerDirectOpenDownloadHandler();
    }

    createWindow();
    createTray();
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
            mainWindow.webContents.executeJavaScript(`(function(observerName){
                try {
                    if (window[observerName]) {
                        window[observerName].disconnect();
                        window[observerName] = null;
                    }
                } catch {}
            })(${JSON.stringify(LAYOUT_OBSERVER_GLOBAL)});`).catch(() => {});
        }
        try { initQuickChat().closeAllQuickChatWindows(); } catch {}
    } catch {}
});
