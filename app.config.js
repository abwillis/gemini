'use strict';

const defaultAppConfig = Object.freeze({
    appUrl: 'https://gemini.google.com',
    partition: String(process.env.GEMINI_PARTITION ?? 'persist:gemini-for-linux').trim(),
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

module.exports = Object.freeze({
    appLabel: 'Gemini',
    appSlug: 'gemini',
    appName: 'gemini-for-linux',
    appUserModelId: 'your.company.gemini',
    iconFileName: 'gemini-for-linux.png',
    trayToolTip: 'Gemini for Linux',
    partitionEnvVar: 'GEMINI_PARTITION',
    layoutObserverGlobal: '__gemini_layoutObserver',
    defaultAppConfig,
});
