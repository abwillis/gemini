// preload.js — Gemini for Linux (app-specific wrapper)
'use strict';

const { createIPC } = require('./lib/ipc');
const { initPreload } = require('./lib/preload-core');

const IPC = createIPC('gemini');

initPreload({
  appSlug:             'gemini',
  hostApiName:         'geminiHost',
  IPC,
  enableDirectOpen:    true,
  enableHoverTooltips: true,
});
