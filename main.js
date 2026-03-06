// main.js
const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Force a persistent Chromium storage partition for gemini.
// Electron: partitions starting with "persist:" use a persistent session. [5](https://www.electronjs.org/docs/latest/api/session)
const gemini_PARTITION = String(process.env.gemini_PARTITION ?? 'persist:gemini-for-linux').trim();

let mainWindow = null;
let quickChatWindows = [];         // Multi-Quick Chat windows
let activeQuickChatId = null;      // last-focused quick window id
let quickChatIdCounter = 0;
let tray = null;
let isQuitting = false;
let lastSavePath = null;  // (legacy) Remember where "Save" last wrote to (per session/window)
let findModal = null;  // === Find modal ===
let appIconImage = null;  // Cached icon images
let trayImage24 = null;  // Cached icon images

// --- Clipboard-based Quick Chat paste timing ---------------------------------
// Requirement: copy selection -> open/focus Quick Chat -> wait 3s -> paste.
const QUICK_PASTE_DELAY_MS = 3000; // NOTE: This is now a fallback timeout only. Primary path waits for input readiness.
const QUICK_PASTE_POST_KEY_DELAY_MS = 40; // tiny gap between paste and optional Enter


// --- Quick Chat / IPC constants --------------------------------------------
const gemini_URL = 'https://gemini.google.com';

const IPC = Object.freeze({
  SEND_SELECTION: 'gemini:send-selection',
  QUICK_NEW: 'gemini:quick-new',
});

const SEND_MODE = Object.freeze({
  PLAIN: 'plain',
  QUOTE: 'quote',
});

function applyWideLayout(wc) {
  wc.on('did-finish-load', () => {
    wc.insertCSS(`
      /* Expand the main conversation width */
      .conversation-container, 
      main, 
      article, 
      .full-width-container { 
        max-width: 100% !important; 
        width: 100% !important;
      }

      /* Expand the input/text area at the bottom */
      .input-area-container,
      .bottom-container { 
        max-width: 95% !important; 
        margin: 0 auto !important;
      }

      /* Optional: Adjust padding for readability on ultra-wide screens */
      .conversation-container {
        padding-left: 20px !important;
        padding-right: 20px !important;
      }

/* Trying to get the user input in the conversation area to also expand */
.user-query-container,
[class*="user-query"],
[data-test-id="user-query"],
.query-content,
.user-query {
  max-width: none !important;
width: 95vw !important;
  box-sizing: content-box !important;
  display: block !important; /* Overrides flex-end alignment if present */
    padding-right: 10 !important;
    padding-left: auto !important;
    display: block !important;
  margin-left: auto !important;
  margin-right: 10 !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    white-space: pre-wrap !important;
}
    `);
  });
}

function normalizeSendOptions(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  return {
    mode: (o.mode === SEND_MODE.QUOTE) ? SEND_MODE.QUOTE : SEND_MODE.PLAIN,
    autoSubmit: !!o.autoSubmit,
    targetQuickId: (typeof o.targetQuickId === 'number' && Number.isFinite(o.targetQuickId)) ? o.targetQuickId : null,
  };
}

function quoteify(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function setRoleTitle(win, role, id) {
  try {
    if (role === 'main') win.setTitle('gemini — Main Chat');
    else win.setTitle(`gemini — Quick Chat ${id}`);
  } catch {}
}

  // Unified reveal helper to avoid repeated show/focus chains
  function reveal(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch {}
  }

// ============================================================================
// Multi-Quick Chat window management + send-to-specific-#N helpers
// ============================================================================
function getQuickById(id) {
  return quickChatWindows.find(w => w && !w.isDestroyed() && w.__quickId === id) || null;
}

function listQuickIds() {
  return quickChatWindows
    .filter(w => w && !w.isDestroyed() && typeof w.__quickId === 'number')
    .map(w => w.__quickId)
    .sort((a, b) => a - b);
}

function getActiveQuickChatWindow({ createIfMissing = true } = {}) {
  const active = activeQuickChatId ? getQuickById(activeQuickChatId) : null;
  if (active) return active;
  const any = quickChatWindows.find(w => w && !w.isDestroyed());
  if (any) return any;
  if (!createIfMissing) return null;
  return createQuickChatWindow();
}

function getTargetQuickWindow(targetQuickId, { createIfMissing = true } = {}) {
  if (typeof targetQuickId === 'number') {
    const exact = getQuickById(targetQuickId);
    if (exact) return exact;
    return getActiveQuickChatWindow({ createIfMissing });
  }
  return getActiveQuickChatWindow({ createIfMissing });
}

function registerQuickWindow(win) {
  if (!win) return;
  quickChatWindows = quickChatWindows.filter(w => w && !w.isDestroyed());
  if (!quickChatWindows.includes(win)) quickChatWindows.push(win);
}

function onQuickFocus(win) {
  try { activeQuickChatId = win.__quickId || null; } catch {}
}

function onQuickClosed(win) {
  quickChatWindows = quickChatWindows.filter(w => w && w !== win && !w.isDestroyed());
  if (activeQuickChatId && win && win.__quickId === activeQuickChatId) {
    activeQuickChatId = quickChatWindows.at(-1)?.__quickId || null;
  }
}

// ============================================================================
// Clipboard paste helpers (iframe-safe)
// ============================================================================
function getPasteModifiers() {
  // Cmd+V on macOS, Ctrl+V elsewhere
  return (process.platform === 'darwin') ? ['meta'] : ['control'];
}

function sendPasteKeystroke(wc) {
  if (!wc) return false;
  try {
    const mods = getPasteModifiers();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: mods });
    return true;
  } catch (e) {
    console.error('sendPasteKeystroke failed:', e);
    return false;
  }
}

function sendEnterKeystroke(wc) {
  if (!wc) return false;
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp',   keyCode: 'Enter' });
    return true;
  } catch (e) {
    console.error('sendEnterKeystroke failed:', e);
    return false;
  }
}

function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until the gemini chat input appears and is visible.
 * This avoids a fixed delay and pastes as soon as the UI is ready.
 *
 * Returns true if ready before timeout, else false.
 */
async function waitForChatInput(wc, timeoutMs = 4000) {
  const start = Date.now();
  const pollIntervalMs = 200;

  // A small set of selectors to detect an input surface.
  // The UI can change; we keep this conservative and generic.
  const probeScript = `
    (function () {
      try {
        // Common cases: textarea or contenteditable editor
        const el =
          document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('div[role="textbox"]');
        if (!el) return false;

        // Visible-ish check: offsetParent null usually means display:none or detached.
        // Also ensure it has a client rect (not 0x0).
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const visible = (el.offsetParent !== null) && r && (r.width > 0) && (r.height > 0);
        return !!visible;
      } catch (e) {
        return false;
      }
    })();
  `;

  while ((Date.now() - start) < timeoutMs) {
    const ok = await wc.executeJavaScript(probeScript, true).catch(() => false);
    if (ok) return true;
    await delayMs(pollIntervalMs);
  }
  return false;
}

/**
 * Dynamic paste: wait for input readiness (up to timeout), then paste.
 * Falls back to QUICK_PASTE_DELAY_MS if readiness isn't detected in time.
 */
async function scheduleQuickPaste(wc, { autoSubmit = false } = {}) {
  if (!wc) return;

  // Primary: wait for UI readiness
  const ready = await waitForChatInput(wc, 4000);
  if (ready) {
    const pasted = sendPasteKeystroke(wc);
    if (autoSubmit && pasted) {
      setTimeout(() => sendEnterKeystroke(wc), QUICK_PASTE_POST_KEY_DELAY_MS);
    }
    return;
  }

  // Fallback: preserve old behavior in case selectors break / UI changes
  setTimeout(() => {
    const pasted = sendPasteKeystroke(wc);
    if (autoSubmit && pasted) {
      setTimeout(() => sendEnterKeystroke(wc), QUICK_PASTE_POST_KEY_DELAY_MS);
    }
  }, QUICK_PASTE_DELAY_MS);
}

async function chooseQuickChatTargetDialog(parentWin) {
  const ids = listQuickIds();
  const buttons = ids.map(id => `Quick Chat ${id}`);
  buttons.push('New Quick Chat…');
  buttons.push('Cancel');

  const res = await dialog.showMessageBox(parentWin || mainWindow, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    title: 'Send to Quick Chat',
    message: 'Choose a Quick Chat target window:',
    noLink: true
  });

  if (res.response === buttons.length - 1) return null;
  if (res.response === buttons.length - 2) return createQuickChatWindow();
  const chosenId = ids[res.response];
  return getQuickById(chosenId);
}

function createQuickChatWindow() {
  quickChatIdCounter += 1;
  const id = quickChatIdCounter;
  const boundsKey = `quick-${id}`;
  const initialBounds = getInitialWindowBounds(boundsKey);

  const win = new BrowserWindow({
    skipTaskbar: false,
    width: initialBounds.width,
    height: initialBounds.height,
    x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
    y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
    show: false,
    title: `gemini — Quick Chat ${id}`,
    icon: appIconImage,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: gemini_PARTITION,
      devTools: true,
      backgroundThrottling: true,
      spellcheck: false
    },
    type: 'normal',
    autoHideMenuBar: false
  });

  win.__geminiRole = 'quick';
  win.__quickId = id;
  win.__boundsKey = boundsKey;
  setRoleTitle(win, 'quick', id);
  registerQuickWindow(win);
  activeQuickChatId = id;

  win.setMenuBarVisibility(true);

  win.on('close', (e) => {
    try { scheduleSaveWindowState(win, boundsKey); } catch {}
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('focus', () => onQuickFocus(win));
  win.on('closed', () => onQuickClosed(win));
  win.webContents.on('destroyed', () => {
    try {
      win.webContents?.removeListener('did-stop-loading', onDidStopLoading);
      delete win.webContents.__hasDidStopLoadingHandler;
    } catch {}
  });
  win.on('resize', () => scheduleSaveWindowState(win, boundsKey));
  win.on('move', () => scheduleSaveWindowState(win, boundsKey));

  // Allow Electron's internal executeJavaScript() listeners
  // without triggering false-positive leak warnings
  win.webContents.setMaxListeners(0);
  win.loadURL(gemini_URL);

  // ... inside createQuickChatWindow ...
    win.loadURL(gemini_URL);

  // Apply the wide layout to this specific window
  applyWideLayout(win.webContents);

  // --- Right-click native context menu (same as Main Chat) ---
  win.webContents.on('context-menu', (_event, params) => {
    // params: { isEditable, selectionText, selectionTextIsEditable, mediaType, linkURL, inputFieldType, x, y, ... }
    const isEditable = !!params.isEditable;
    const hasSelection = !!params.selectionText && params.selectionText.length > 0;

    // Always offer at least a minimal fallback menu so users are not left without options
    const minimalTemplate = [
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            win.webContents.inspectElement(params.x, params.y);
            if (!win.webContents.isDevToolsOpened()) {
              win.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];

    const template = [
      { role: 'cut', accelerator: 'Ctrl+X', enabled: isEditable },
      { role: 'copy', accelerator: 'Ctrl+C', enabled: (hasSelection || isEditable) },
      { role: 'paste', accelerator: 'Ctrl+V', enabled: isEditable },
      { type: 'separator' },
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
      { type: 'separator' },
      {
        label: 'Send to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: false })
      },
      {
        label: 'Send as Quote to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.QUOTE, autoSubmit: false })
      },
      {
        label: 'Send & Auto-Submit to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: true })
      },
      { type: 'separator' },
      {
        label: 'Select Chat Pane',
        accelerator: 'Ctrl+Shift+A',
        enabled: true,
        click: async () => {
          try {
            const res = await selectChatPane(win);
            if (!res?.ok) {
              try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
            }
          } catch (err) {
            console.error('Select Chat Pane failed:', err);
            try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message ?? err)); } catch {}
          }
        }
      },
      {
        label: 'Save Chat Pane…',
        click: async () => {
          await promptSaveChatPane(win);
        }
      },
      { type: 'separator' },
      {
        label: 'Copy Selection as Markdown',
        accelerator: 'Ctrl+Shift+M',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(win);
            if (!ok) return;
            const md = htmlToMarkdown(html || text);
            clipboard.writeText(md);
          } catch (err) {
            console.error('Copy Selection as Markdown failed:', err);
          }
        }
      },
      {
        label: 'Save Selection as Markdown…',
        enabled: hasSelection,
        click: async () => {
          await saveSelectionAsMarkdown(win);
        }
      },
      {
        label: 'Save Selection as Plain Text…',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(win);
            if (!ok) {
              try { dialog.showErrorBox('Save Selection as Text', 'No selection found.'); } catch {}
              return;
            }
            const safeHtml = stripExecutableBlocks(decodeEntities(html || text));
            let plain = stripTags(safeHtml)
              .replace(/[ 	]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const { filePath, canceled } = await dialog.showSaveDialog(win, {
              title: 'Save Selection as Plain Text',
              defaultPath: 'selection.txt',
              filters: [{ name: 'Plain Text', extensions: ['txt'] }]
            });
            if (canceled || !filePath) return;
            await fs.promises.writeFile(filePath, plain, 'utf8');
          } catch (err) {
            console.error('Save Selection as Plain Text failed:', err);
            try { dialog.showErrorBox('Save failed', String(err?.message ?? err)); } catch {}
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            win.webContents.inspectElement(params.x, params.y);
            if (!win.webContents.isDevToolsOpened()) {
              win.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];

    let menu;
    try {
      menu = Menu.buildFromTemplate(template);
    } catch (err) {
      console.error('Context menu template error:', err);
      menu = Menu.buildFromTemplate([{ role: 'copy', enabled: hasSelection }, { role: 'selectAll' }]);
    }

    try { menu.popup({ window: win }); }
    catch (err) { console.error('Context menu popup failed:', err); }
  });
  // --- end context menu ---

  win.webContents.setWindowOpenHandler(({ url }) => (
    shell.openExternal(url),
    { action: 'deny' }
  ));

  return win;
}

const windowStateCache = new Map(); // key -> {x,y,width,height}
const saveStateDebounceByKey = new Map(); // key -> timeoutId
const SAVE_STATE_DEBOUNCE_MS = 500;

function loadWindowState(key = 'main') {
  try {
    const file = getWindowStateFile(key);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    windowStateCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function isBoundsOnAnyDisplay(bounds) {
  try {
    const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const disp = screen.getDisplayMatching(rect);
    if (!disp) return false;
    const wa = disp.workArea;
    const intersects =
      rect.x < (wa.x + wa.width) &&
      (rect.x + rect.width) > wa.x &&
      rect.y < (wa.y + wa.height) &&
      (rect.y + rect.height) > wa.y;
    return intersects;
  } catch {
    return true;
  }
}

function getInitialWindowBounds(key = 'main') {
  const persisted = windowStateCache.get(key) || loadWindowState(key);
  if (persisted && persisted.width && persisted.height) {
    if (isBoundsOnAnyDisplay(persisted)) {
      return {
        width: Math.max(600, persisted.width),
        height: Math.max(400, persisted.height),
        x: typeof persisted.x === 'number' ? persisted.x : undefined,
        y: typeof persisted.y === 'number' ? persisted.y : undefined
      };
    }
    return {
      width: Math.max(600, persisted.width),
      height: Math.max(400, persisted.height)
    };
  }
  return { width: 1200, height: 800 };
}

function scheduleSaveWindowState(win, key = 'main') {
  const prev = saveStateDebounceByKey.get(key);
  if (prev) clearTimeout(prev);
 const t = setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const state = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      const file = getWindowStateFile(key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(state), 'utf8');
      windowStateCache.set(key, state);
    } catch (err) {
      console.error('Failed to persist window state:', err);
    }
  }, SAVE_STATE_DEBOUNCE_MS);
  saveStateDebounceByKey.set(key, t);
}

// === Helper: runtime info for About dialog ===
function getRuntimeInfo() {
  const name = app.getName?.() || 'Application';
  const appVersion = app.getVersion?.() || '0.0.0';
  const nodeVersion = process.versions?.node || 'unknown';
  const electronVersion = process.versions?.electron || 'unknown';
  const chromeVersion = process.versions?.chrome || 'unknown';
  const v8Version = process.versions?.v8 || 'unknown';

  return {
    name,
    appVersion,
    nodeVersion,
    electronVersion,
    chromeVersion,
    v8Version,
    detail:
      `Version: ${appVersion}\n` +
      `Node: ${nodeVersion}\n` +
      `V8: ${v8Version}\n` +
      `Electron: ${electronVersion}\n` +
      `Chromium: ${chromeVersion}\n`
  };
}

app.setName('gemini-for-linux');  // Shows as WMClass "yourapp" or "YourApp"
app.setAppUserModelId('your.company.gemini');

// === Parent-aware helpers for find-in-page ===
// Prefer the parent window's webContents when the focused window is a modal.
function getWCFromEventSender(sender) {
  const modalWin = BrowserWindow.fromWebContents(sender);
  const targetWin = modalWin?.getParentWindow() || mainWindow;
  return targetWin?.webContents || null;
}

function getWC() {
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused?.getParentWindow() || focused || mainWindow;
  return target?.webContents || null;
}

// Optional: utility to safely enable "whole word-ish" behavior.
// Chromium's flags are heuristic; enable if desired.
function applyWordStartOptions(opts) {
  return {
    ...opts,
    // Enable these if you want word-start behavior, useful for token-like terms.
    wordStart: opts.wordStart ?? true,
    medialCapitalAsWordStart: opts.medialCapitalAsWordStart ?? true,
  };
}

function openFindModal(parent) {
  if (findModal && !findModal.isDestroyed()) {
    findModal.show(); findModal.focus(); return;
  }
  findModal = new BrowserWindow({
    parent, modal: true, width: 380, height: 160, resizable: false,
    minimizable: false, maximizable: false, show: false,
    title: 'Find in Page', autoHideMenuBar: true,
    // Enable Node only in the modal; main window remains sandboxed
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  // --- Position the find window relative to the parent window (Cinnamon-friendly) ---
  try {
    // Prefer the *restored* bounds if parent is maximized/fullscreen
    const pb = (parent && typeof parent.getNormalBounds === 'function')
      ? parent.getNormalBounds()
      : parent.getBounds();

    const modalW = 380;
    const modalH = 160;

    // Center over parent
    let x = Math.round(pb.x + (pb.width - modalW) / 2);
    let y = Math.round(pb.y + (pb.height - modalH) / 2);

    // Clamp to nearest display workArea so it doesn't end up off-screen
    const display = screen.getDisplayMatching({ x: pb.x, y: pb.y, width: pb.width, height: pb.height });
    const wa = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };

    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - modalW));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - modalH));

    findModal.setBounds({ x, y, width: modalW, height: modalH });
  } catch (e) {
    // If anything goes wrong, let the WM decide placement
  }

  // Build plain HTML, then encode only the payload for the data URL
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:12px}
  .row{display:flex;gap:8px;align-items:center}
  input[type=text]{flex:1;padding:6px 8px}
  .actions{margin-top:10px;display:flex;gap:8px;justify-content:flex-end}
  label{font-size:12px;color:#444}
</style></head><body>
  <div class="row">
    <input id="term" type="text" placeholder="Find in page..." autofocus />
    <label><input id="match" type="checkbox"> Match case</label>
  </div>
  <div class="actions">
    <button id="prev">Previous</button>
    <button id="next">Next</button>
    <button id="clear">Clear</button>
    <button id="close">Close</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const termEl = document.getElementById('term');
    const matchEl = document.getElementById('match');
    const send = (kind) => ipcRenderer.send('find-modal-submit', {
      kind, term: termEl.value || '', matchCase: !!matchEl.checked
    });
    document.getElementById('next').onclick = () => send('next');
    document.getElementById('prev').onclick = () => send('prev');
    document.getElementById('clear').onclick = () => ipcRenderer.send('find-modal-clear');
    document.getElementById('close').onclick = () => ipcRenderer.send('find-modal-close');
    termEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send('next');
      if (e.key === 'Escape') {
        ipcRenderer.send('find-modal-clear');
        ipcRenderer.send('find-modal-close');
      }
    });
  </script>
</body></html>`;
  // Keep the modal clean; no menu bar
  findModal.removeMenu();
  // Encode only the HTML part, not the "data:" URL header
  findModal.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  // Show when ready and log any load failures
  findModal.once('ready-to-show', () => {
    try { findModal.show(); findModal.focus(); } catch {}
  });
  findModal.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Find modal failed to load:', code, desc, url);
  });
}

// === Find-in-page state ===
let lastFindTerm = '';
let lastFindOpts = { forward: true, matchCase: false, medialCapitalAsWordStart: true, wordStart: true, findNext: false };
let findDebounce;
const FIND_DEBOUNCE_MS = 20;

// Build Edit menu as a reusable factory
function appendEditItems(editSubmenu) {
  const template = [
//    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
//    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
//    { role: 'selectAll' }, { type: 'separator' },
    {
      label: 'Find…',
      accelerator: 'Ctrl+F',
      click: () => {
        const w = BrowserWindow.getFocusedWindow() || mainWindow;
        if (w) openFindModal(w);
      }
    },
    {
      label: 'Find Next',
      accelerator: 'F3',
      click: () => {
        const wc = getWC(); if (!wc || !lastFindTerm) return;
        lastFindOpts = applyWordStartOptions({ ...lastFindOpts, forward: true, findNext: true });
        wc.findInPage(lastFindTerm, lastFindOpts);
      }
    },
    {
      label: 'Find Previous',
      accelerator: 'Shift+F3',
      click: () => {
        const wc = getWC(); if (!wc || !lastFindTerm) return;
        lastFindOpts = applyWordStartOptions({ ...lastFindOpts, forward: false, findNext: true });
        wc.findInPage(lastFindTerm, lastFindOpts);
      }
    },
    {
      label: 'Clear Highlights',
      accelerator: 'Esc',
      click: () => { const wc = getWC(); if (!wc) return; wc.stopFindInPage('clearSelection'); }
    },
    { type: 'separator' },
 {
  label: 'New Quick Chat Window',
  accelerator: 'Ctrl+Alt+N',
  click: () => { try { reveal(createQuickChatWindow()); } catch (e) { console.error('New Quick Chat failed:', e); } }
 },
 {
  label: 'Show Active Quick Chat',
  accelerator: 'Ctrl+Alt+2',
  click: () => { try { const w = getActiveQuickChatWindow({ createIfMissing: true }); if (w) reveal(w); } catch (e) { console.error('Show Quick Chat failed:', e); } }
 },
 { type: 'separator' },
 {
  label: 'Send Selection to Active Quick Chat',
  accelerator: 'Ctrl+Alt+Q',
  click: async () => { const src = BrowserWindow.getFocusedWindow() || mainWindow; await sendSelectionToQuick(src, { mode: SEND_MODE.PLAIN, autoSubmit: false, targetQuickId: null }); }
 },
 {
  label: 'Send Selection as Quote (Active Quick)',
  accelerator: 'Ctrl+Alt+Shift+Q',
  click: async () => { const src = BrowserWindow.getFocusedWindow() || mainWindow; await sendSelectionToQuick(src, { mode: SEND_MODE.QUOTE, autoSubmit: false, targetQuickId: null }); }
 },
 {
  label: 'Send Selection & Auto‑Submit (Active Quick)',
  accelerator: 'Ctrl+Alt+Enter',
  click: async () => { const src = BrowserWindow.getFocusedWindow() || mainWindow; await sendSelectionToQuick(src, { mode: SEND_MODE.PLAIN, autoSubmit: true, targetQuickId: null }); }
 },
 {
  label: 'Send Selection to Specific Quick Chat…',
  accelerator: 'Ctrl+Alt+W',
  click: async () => { const src = BrowserWindow.getFocusedWindow() || mainWindow; await sendSelectionToSpecificQuickViaDialog(src, { mode: SEND_MODE.PLAIN, autoSubmit: false }); }
 },
 { type: 'separator' },
 {
  label: 'Select Chat Pane',
      accelerator: 'Ctrl+Shift+A',
      click: async () => {
        const w = BrowserWindow.getFocusedWindow() || mainWindow;
        if (!w) return;
        try {
          const res = await selectChatPane(w);
          if (!res?.ok) {
            try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
          }
        } catch (err) {
          console.error('Select Chat Pane failed:', err);
          try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message || err)); } catch {}
        }
      }
    },
  ];
  // Merge our items into the existing Edit menu
  Menu.buildFromTemplate(template).items.forEach(i => editSubmenu.append(i));
}

// --- Help menu: add About… screen (under the menu bar) ----------------------
function appendHelpItems(helpSubmenu) {
  const template = [
    new MenuItem({
      label: 'About…',
      // Optional: make F1 open About; change/remove if you already use F1 elsewhere
      accelerator: 'F1',
      click: async () => {
        try {
          const info = getRuntimeInfo();
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            defaultId: 0,
            title: `About ${info.name}`,
            message: `${info.name}`,
            detail: info.detail,
            noLink: true,
            icon: appIconImage
          });
        } catch (err) {
          console.error('Help→About dialog failed:', err);
        }
      }
    }),
    new MenuItem({ type: 'separator' }),
    // (Optional) quick links; uncomment/adjust as needed:
    // new MenuItem({
    //   label: 'Documentation',
    //   click: () => shell.openExternal('https://your.docs.url/')
    // }),
    // new MenuItem({
    //   label: 'Report Issue…',
    //   click: () => shell.openExternal('https://your.issues.url/')
    // }),
  ];
  template.forEach(i => helpSubmenu.append(i));
}


// Augment (mutate) the existing app menu rather than replacing it
function augmentApplicationMenu(win) {
  // Start from the current application menu.
  // NOTE: On Windows/Linux this may be null until first set; handle that.
  const appMenu = Menu.getApplicationMenu() ?? new Menu();

  // Ensure "File" submenu exists, then append our items
  let fileSubmenu = appMenu.items.find(i => i.label === 'File')?.submenu;
  if (!fileSubmenu) {
    fileSubmenu = new Menu();
    appMenu.insert(0, new MenuItem({ label: 'File', submenu: fileSubmenu }));
  }
  appendFileItems(fileSubmenu, win);

  // Ensure "Edit" submenu exists, then append our items
  let editSubmenu = appMenu.items.find(i => i.label === 'Edit')?.submenu;
  if (!editSubmenu) {
    editSubmenu = new Menu();
    appMenu.insert(1, new MenuItem({ label: 'Edit', submenu: editSubmenu }));
  }
  appendEditItems(editSubmenu);

  // Ensure "Help" submenu exists, then append our items
  let helpSubmenu = appMenu.items.find(i => i.label === 'Help')?.submenu;
  if (!helpSubmenu) {
    helpSubmenu = new Menu();
    // Place Help at the end for Windows/Linux conventions
    appMenu.append(new MenuItem({ label: 'Help', submenu: helpSubmenu }));
  }
  appendHelpItems(helpSubmenu);

  // Re-apply the mutated menu so the OS picks up changes
  Menu.setApplicationMenu(appMenu);
}

function ensureSaveState(win) {
  if (win && typeof win.__lastSavePath === 'undefined') win.__lastSavePath = null;
}

// ---------- Chat pane selection helper ----------
// Select the entire chat pane content in the renderer and return selection stats
async function selectChatPane(win) {
  const res = await win.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('${CHAT_SELECTOR}');
      if (!el) return { ok:false, selectedTextLength:0 };
      try {
        // Try to reveal as much content as possible before selecting (helps some virtualized views)
        el.scrollTo({ top: 0, behavior: 'auto' });
      } catch {}
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.addRange(range);
          const txt = String(sel.toString() || '');
          return { ok:true, selectedTextLength: txt.length };
        }
      } catch (e) {
        return { ok:false, selectedTextLength:0, err: String(e) };
      }
      return { ok:false, selectedTextLength:0 };
    })();
  `);
  return res;
}

// ---------- Selection → Markdown helpers ----------
// Extract the current selection from the renderer as HTML fragment and text.
async function getSelectionFragment(win) {

 const result = await win.webContents.executeJavaScript(`
 (function() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.rangeCount === 0) {
   return { hasSelection: false, html: "", text: "" };
  }

  // Clone selected contents so we never mutate the live DOM
  const range = sel.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());

  // -------------------------------
  // DOM CLEANUP (gemini-specific)
  // -------------------------------

  // Known non-content UI affordances:
  // copy buttons, feedback icons, toolbars, hover menus, references
  const JUNK_SELECTORS = [
   'button',
   '[role="button"]',
   '[data-testid*="copy"]',
   '[data-testid*="feedback"]',
   '[data-testid*="thumb"]',
   '[data-testid*="reaction"]',
   '[data-testid*="reference"]',
   '[data-testid*="citation"]',
   '[class*="copy" i]',
   '[class*="feedback" i]',
   '[class*="toolbar" i]',
   '[class*="action" i]',
   '[class*="hover" i]',
   '[class*="menu" i]',
   '[class*="icon" i]'
  ];

  container.querySelectorAll(JUNK_SELECTORS.join(',')).forEach(el => {
   try { el.remove(); } catch {}
  });

  // Preserve semantic blocks explicitly (never strip their parents)
  container.querySelectorAll('pre, code, table, ul, ol').forEach(el => {
   try { el.setAttribute('data-preserve', 'true'); } catch {}
  });

  // Remove empty wrapper nodes that add no content,
  // but do NOT touch semantic structures
  container.querySelectorAll('div, span').forEach(el => {
   try {
    if (
     !el.textContent.trim() &&
     !el.querySelector('[data-preserve]') &&
     !el.querySelector('pre, code, table, ul, ol')
    ) {
     el.remove();
    }
   } catch {}
  });

  const html = container.innerHTML;
  const text = String(sel.toString() || '');

  return { hasSelection: true, html, text };
 })();
 `).catch(() => ({ hasSelection: false, html: "", text: "" }));
  return result;
}

// ============================================================================
// Structured selection -> envelope -> quick chat inject (active OR specific #N)
// ============================================================================
async function buildSelectionEnvelope(sourceWin, opts) {
  const { mode, autoSubmit } = normalizeSendOptions(opts);
  const src = sourceWin || mainWindow;
  if (!src || src.isDestroyed()) return null;
  const { hasSelection, html, text } = await getSelectionFragment(src);
  if (!hasSelection) return null;

  let content = '';
  try {
    content = html ? htmlToMarkdown(html) : String(text || '');
  } catch {
    content = String(text || '');
  }

  if (mode === SEND_MODE.QUOTE) content = quoteify(content);

  const role = src.__geminiRole || (src === mainWindow ? 'main' : 'unknown');
  const quickId = (typeof src.__quickId === 'number') ? src.__quickId : undefined;

  return {
    kind: 'inject',
    mode,
    content,
    autoSubmit: !!autoSubmit,
    meta: {
      source: 'selection',
      sourceRole: role,
      sourceQuickId: quickId,
      timestamp: Date.now(),
      format: 'markdown'
    }
  };
}

async function sendSelectionToQuick(sourceWin, opts) {
  const { targetQuickId } = normalizeSendOptions(opts);
  const quick = getTargetQuickWindow(targetQuickId, { createIfMissing: true });
  if (!quick || quick.isDestroyed()) return;

  const envelope = await buildSelectionEnvelope(sourceWin, opts);
  if (!envelope) return;

  // Clipboard-based path (iframe-safe):
  // 1) Copy selection content to clipboard
  // 2) Reveal/focus Quick Chat window
  // 3) Wait 3 seconds
  // 4) Paste (Ctrl/Cmd+V)
  // 5) Optional Enter if autoSubmit
  try {
    clipboard.writeText(String(envelope.content || ''));
  } catch (e) {
    console.error('clipboard.writeText failed:', e);
  }

  reveal(quick);

  const wc = quick.webContents;
  try {
  if (wc && wc.isLoading && wc.isLoading()) {
    wc.once('did-finish-load', () => {
      // Dynamic wait + paste after load completes
      scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
    });
    } else {
    // Dynamic wait + paste immediately if already ready
    scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
    }
  } catch {
    scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
  }
}

async function sendSelectionToSpecificQuickViaDialog(sourceWin, opts) {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
  const target = await chooseQuickChatTargetDialog(parent);
  if (!target) return;
  const forced = { ...(opts || {}), targetQuickId: target.__quickId };
  await sendSelectionToQuick(sourceWin, forced);
}

function buildSendToQuickSubmenu(sourceWin, optsBase) {
  const ids = listQuickIds();
  const items = [];

  items.push({
    label: 'Active Quick Chat',
    click: async () => sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: null })
  });

  if (ids.length) {
    items.push({ type: 'separator' });
    for (const id of ids) {
      items.push({
        label: `Quick Chat ${id}`,
        click: async () => sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: id })
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Choose…', click: async () => sendSelectionToSpecificQuickViaDialog(sourceWin, optsBase) });
  items.push({ label: 'New Quick Chat Window', click: () => reveal(createQuickChatWindow()) });
  return items;
}

ipcMain.on(IPC.SEND_SELECTION, async (event, opts) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  const source = (sender && sender.__geminiRole === 'main') ? sender : mainWindow;
  try { await sendSelectionToQuick(source, opts); }
  catch (e) { console.error('IPC send selection failed:', e); }
});

ipcMain.on(IPC.QUICK_NEW, () => {
  try { reveal(createQuickChatWindow()); }
  catch (e) { console.error('IPC quick new failed:', e); }
});

// Minimal HTML → Markdown converter (headings, paragraphs, lists, code, links, quotes)
function htmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  // 1) Decode common entities so we operate on real tags
  let md = decodeEntities(html);
  // 2) Remove executable/unsafe blocks first
  md = stripExecutableBlocks(md);

  // 3) Blockquotes
  md = md.replace(/<blockquote[^>]*>/gi, '\n> ')
         .replace(/<\/blockquote>/gi, '\n');

  // 4) Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n# ${stripTags(c)}\n`);
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n## ${stripTags(c)}\n`);
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n### ${stripTags(c)}\n`);
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n#### ${stripTags(c)}\n`);
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n##### ${stripTags(c)}\n`);
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n###### ${stripTags(c)}\n`);

  // 5) Paragraphs & line breaks
  md = md.replace(/<p[^>]*>/gi, '\n')
         .replace(/<\/p>/gi, '\n')
         .replace(/<br\s*\/?>/gi, '\n');

  // 6) Lists
  md = md.replace(/<ul[^>]*>/gi, '\n')
         .replace(/<\/ul>/gi, '\n');
  md = md.replace(/<ol[^>]*>/gi, '\n')
         .replace(/<\/ol>/gi, '\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c)}\n`);

  // 7) Bold / Italic
  md = md.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, c) => `**${stripTags(c)}**`);
  md = md.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi,   (_, __, c) => `*${stripTags(c)}*`);

  // 8) Inline code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + stripTags(c).replace(/\n+/g, ' ') + '`');

  // 9) Preformatted blocks → fenced code
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => {
    const inner = c.replace(/<\/?code[^>]*>/gi, '');
    const clean = stripTags(inner).replace(/\r?\n/g, '\n');
    return `\n~~~\n${clean.trim()}\n~~~\n`;
  });

  // 10) Links (emit bare href if no text)
  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const t = stripTags(text).trim();
    const h = href.trim();
    return t ? `[${t}](${h})` : h;
  });

  // 11) Images → alt + URL, or URL
  md = md.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, alt, src) => {
    const a = alt.trim(); const s = src.trim();
    return a ? `![${a}](${s})` : s;
  });

  // 12) Strip remaining tags and normalize whitespace
  md = stripTags(md);

  // Normalize trailing whitespace only (do NOT collapse structural blank lines)
  md = md.replace(/[ \t]+\n/g, '\n');

  // Ensure at least one blank line between block elements
  md = md.replace(/\n{4,}/g, '\n\n');

  md = md.trim();
  return md;
}

function stripTags(s) {
  // Remove any remaining HTML tags; entity decoding is handled earlier
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00A0/g, ' '); // non-breaking space → regular space
}

// --- Centralized sanitizers ---
function decodeEntities(s) {
  // Minimal entity decode to operate on real tags and readable text
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripExecutableBlocks(input) {
  if (typeof input !== 'string') return input;
  // Real <script>/<style>
  const reScriptTags = /<script[\s\S]*?<\/script>/gi;
  const reStyleTags  = /<style[\s\S]*?<\/style>/gi;

  // Entity-encoded &lt;script&gt;/&lt;style&gt; (in case source was pre-escaped)
  const reEscScript  = /&lt;script[\s\S]*?&lt;\/script&gt;/gi;
  const reEscStyle   = /&lt;style[\s\S]*?&lt;\/style&gt;/gi;

  let out = input.replace(reScriptTags, '')
                 .replace(reStyleTags, '')
                 .replace(reEscScript, '')
                 .replace(reEscStyle, '');

  // Optional: strip inline event handlers like onclick="...", onload='...'
  out = out.replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');
  return out;
}

// --- Save selection as Markdown helper ---
async function saveSelectionAsMarkdown(win) {
  try {
    if (!win) return;
    const { hasSelection, html, text } = await getSelectionFragment(win);
    if (!hasSelection) {
      // Optional: inform user; keep silent if you prefer
      try { dialog.showErrorBox('Save Selection as Markdown', 'No selection found.'); } catch {}
      return;
    }
    const md = htmlToMarkdown(html || text);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Selection as Markdown',
      defaultPath: 'selection.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (canceled || !filePath) return;
    await fs.promises.writeFile(filePath, md, 'utf8');
  } catch (err) {
    console.error('Save Selection as Markdown failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

// ---------- Chat pane save helpers ----------
// A) Hide everything except the chat pane, then savePage (HTMLOnly/MHTML)
async function saveOnlyPaneWithSavePage(win, filePath, format /* 'HTMLOnly' | 'MHTML' */) {
  // Make everything except the chat invisible but still laid out.
  // Using opacity/pointer-events instead of display:none helps virtualized lists keep measurements,
  // reducing "white page" issues when saving.
  const css = `
    html, body {
      overflow: auto !important;
      background: #ffffff !important;
    }
    *:not(${CHAT_SELECTOR}):not(${CHAT_SELECTOR} *) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    ${CHAT_SELECTOR} {
      opacity: 1 !important;
      pointer-events: auto !important;
      width: 100% !important;
      max-width: 100% !important;
    }
  `;

  let key = null;
  try {
    key = await win.webContents.insertCSS(css);
  } catch (_) {}
  try {
    // Give the style a tick to apply before saving
    await new Promise(r => setTimeout(r, 150));
    await win.webContents.savePage(filePath, format);
  } finally {
    if (key) {
      try { await win.webContents.removeInsertedCSS(key); } catch {}
    }
  }
}

// B) Extract chat pane HTML and write a standalone file
async function savePaneAsStandaloneHTML(win, filePath) {
  const url = win.webContents.getURL();
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('${CHAT_SELECTOR}');
      if (!el) return { ok:false, html:'', title: document.title };
      return { ok:true, html: el.outerHTML, title: document.title };
    })();
  `);
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${(result && result.title) ? result.title : 'gemini Chat'}</title>
  <style>
    html, body { margin: 0; padding: 0; }
    ${CHAT_SELECTOR} { width: 100%; max-width: 100%; }
  </style>
</head>
<body>
${(result && result.html) ? result.html : '<p>Chat pane not found.</p>'}
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// B2) Clean HTML export: strip noisy classes/styles and add minimal readable CSS
async function savePaneAsCleanHTML(win, filePath) {
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const root = document.querySelector('${CHAT_SELECTOR}');
      if (!root) return { ok:false, title: document.title, html:'' };
      // clone and sanitize
      const clone = root.cloneNode(true);
      // remove hashed classes & inline styles (keeps text content)
      clone.querySelectorAll('[class]').forEach(n => n.removeAttribute('class'));
      clone.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
      // remove noisy attributes
      clone.querySelectorAll('*').forEach(n => {
        // drop data-* and aria-* and role, tabindex
        [...n.attributes].forEach(a => {
          const name = a.name.toLowerCase();
          if (name.startsWith('data-') || name.startsWith('aria-') || name === 'role' || name === 'tabindex') {
            n.removeAttribute(a.name);
          }
          // drop ephemeral ids except the root
          if (name === 'id' && n !== clone) n.removeAttribute('id');
        });
      })
      // remove empty containers to reduce noise
      clone.querySelectorAll('div').forEach(n => { if (!n.textContent.trim()) n.remove(); });
      // attempt to keep message semantics if present
      // (optional heuristics can be added here)
      return { ok:true, title: document.title, html: clone.innerHTML };
    })();
  `);
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${result.title || 'gemini Chat'}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.5; color: #222; }
    h1,h2,h3,h4,h5 { margin: 0.6em 0 0.3em; }
    p { margin: 0.4em 0; }
    .message { margin-bottom: 12px; }
    .user { font-weight: 600; color: #333; }
    .gemini { color: #004b9a; }
    /* Generic content spacing */
    ul,ol { margin: 0.4em 0 0.4em 1.2em; }
    pre, code { font-family: Consolas, Menlo, monospace; }
    pre { background: #f5f7fa; border: 1px solid #e3e7ee; padding: 10px; border-radius: 6px; overflow: auto; }
    blockquote { border-left: 3px solid #cbd5e1; margin: 0.4em 0; padding: 0.2em 0.8em; color: #555; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #e5e7eb; padding: 6px 8px; }
    /* Make top-level container stretch full width */
    ${CHAT_SELECTOR} { width: 100%; max-width: 100%; }
  </style>
  <!-- NOTE: This cleaned export removes hashed classes/inline styles for readability. -->
</head>
<body>
${result.html || '<p>No chat content found.</p>'}
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// Unified chooser by extension
async function saveChatPaneByExtension(win, filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.html')) {
    // Use cleaned fragment (B2)
    await savePaneAsCleanHTML(win, filePath);
  } else if (lower.endsWith('.mhtml')) {
    // Use savePage with hide-CSS (A)
    await saveOnlyPaneWithSavePage(win, filePath, 'MHTML');
   } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
     // New: export whole chat pane to Markdown
     await saveChatPaneAsMarkdown(win, filePath);
  } else if (lower.endsWith('.txt')) {
    // New: export whole chat pane to Plain Text
    await saveChatPaneAsText(win, filePath);
  } else {
    // Default: cleaned fragment HTML
    await savePaneAsCleanHTML(win, filePath);
  }
}

// --- Shared helper: prompt to Save Chat Pane (HTML or MHTML) ---
async function promptSaveChatPane(win) {
  if (!win) return;
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Chat Pane As…',
      defaultPath: 'gemini-chat.md',  // Default to Markdown file name
      // Put Markdown first so it's the preselected filter
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Web Page, HTML (clean)', extensions: ['html'] },
        { name: 'Web Archive (MHTML)', extensions: ['mhtml'] },
        { name: 'Plain Text', extensions: ['txt'] }
      ],
    });
    if (canceled || !filePath) return;
    await saveChatPaneByExtension(win, filePath);
    // Optionally remember for plain "Save"
    win.__lastSavePath = filePath;
  } catch (err) {
    console.error('Save Chat Pane failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

// --- New helper: save whole chat pane as Markdown ---
async function saveChatPaneAsMarkdown(win, filePath) {
  if (!win) return;
  try {
   const result = await win.webContents.executeJavaScript(`
   (function() {
    const root = document.querySelector('${CHAT_SELECTOR}');
    if (!root) return { ok:false, html:'', title: document.title };

    // Clone so we never mutate the live DOM
    const clone = root.cloneNode(true);

    // -------------------------------
    // DOM CLEANUP (gemini-specific)
    // -------------------------------

    // Known non-content UI affordances:
    // copy buttons, feedback icons, toolbars, hover menus, references
    const JUNK_SELECTORS = [
     'button',
     '[role="button"]',
     '[data-testid*="copy"]',
     '[data-testid*="feedback"]',
     '[data-testid*="thumb"]',
     '[data-testid*="reaction"]',
     '[data-testid*="reference"]',
     '[data-testid*="citation"]',
     '[class*="copy" i]',
     '[class*="feedback" i]',
     '[class*="toolbar" i]',
     '[class*="action" i]',
     '[class*="hover" i]',
     '[class*="menu" i]',
     '[class*="icon" i]'
    ];

    clone.querySelectorAll(JUNK_SELECTORS.join(',')).forEach(el => {
     try { el.remove(); } catch {}
    });

    // Explicitly preserve semantic structures
    clone.querySelectorAll('pre, code, table, ul, ol').forEach(el => {
     try { el.setAttribute('data-preserve', 'true'); } catch {}
    });

    // Remove empty wrapper nodes that add no content,
    // but do NOT touch semantic structures
    clone.querySelectorAll('div, span').forEach(el => {
     try {
      if (
       !el.textContent.trim() &&
       !el.querySelector('[data-preserve]') &&
       !el.querySelector('pre, code, table, ul, ol')
      ) {
       el.remove();
      }
     } catch {}
    });

    return {
     ok: true,
     html: clone.innerHTML,
     title: document.title
    };
   })();
   `);

    if (!result?.ok) {
      try { dialog.showErrorBox('Save Chat Pane as Markdown', 'Chat pane not found.'); } catch {}
      return;
    }

    // Convert cleaned semantic HTML → Markdown
    // (No entity decoding; structure already preserved)
    const paneHtml = String(result.html || '');

  // IMPORTANT:
  // gemini renders diff lines as separate block elements (div/span)
  // with NO newline text nodes. Inject newlines between blocks so
  // diffs and code retain line structure.
  const withLineBreaks = paneHtml.replace(/></g, '>\n<');
  const safeHtml = stripExecutableBlocks(withLineBreaks);
    const md = htmlToMarkdown(safeHtml);
    await fs.promises.writeFile(filePath, md, 'utf8');
  } catch (err) {
    console.error('Save Chat Pane as Markdown failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

async function saveChatPaneAsText(win, filePath) {
  if (!win) return;
  try {
    const result = await win.webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('${CHAT_SELECTOR}');
        if (!el) return { ok:false, html:'', title: document.title };
        return { ok:true, html: el.innerHTML, title: document.title };
      })();
    `);
    if (!result?.ok) {
      try { dialog.showErrorBox('Save Chat Pane as Text', 'Chat pane not found.'); } catch {}
      return;
    }
    // Convert pane HTML → Plain Text: decode → sanitize → strip tags → normalize
    const paneHtml = String(result.html || '');
    const safeHtml = stripExecutableBlocks(decodeEntities(paneHtml));
    let text = stripTags(safeHtml);
    // normalize whitespace: collapse >2 newlines, trim trailing spaces
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    await fs.promises.writeFile(filePath, text, 'utf8');
  } catch (err) {
    console.error('Save Chat Pane as Text failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

async function saveChatAsPDF(win, filePath) {
  const pdf = await win.webContents.printToPDF({ printBackground: true, marginsType: 1 });
  await fs.promises.writeFile(filePath, pdf);
}

// ---------- File menu (Save / Save As…) ----------
function appendFileItems(fileSubmenu, win) {
  ensureSaveState(win);
  const items = [
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Save Chat Pane…',
      accelerator: 'Ctrl+S',
      click: async () => {
        try { await promptSaveChatPane(win); }
        catch (err) {
          console.error('File→Save Chat Pane failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Save Selection as Markdown…',
      accelerator: 'Ctrl+Shift+M',
      click: async () => {
        try { await saveSelectionAsMarkdown(win); }
        catch (err) {
          console.error('File→Save Selection as Markdown failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Toggle DevTools',
      accelerator: 'Ctrl+Shift+I',
      click: () => {
        try { if (mainWindow) mainWindow.webContents.toggleDevTools(); }
        catch (err) { console.error('Toggle DevTools failed:', err); }
      }
    }),
//    new MenuItem({ type: 'separator' }),
    // Use role for native Quit (macOS label/shortcut handled automatically)
//    new MenuItem({ role: 'quit' }),
  ];
  items.forEach(i => fileSubmenu.append(i));
}

async function saveAsDialog(win) {
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Save Page As…',
    defaultPath: 'gemini.html',
    filters: [
      { name: 'Web Page, HTML only', extensions: ['html'] },
      { name: 'Web Archive (MHTML)', extensions: ['mhtml'] },
    ],
  });

  if (canceled || !filePath) return;

  const format = filePath.toLowerCase().endsWith('.mhtml') ? 'MHTML' : 'HTMLOnly';
  await win.webContents.savePage(filePath, format);

  // Remember for plain "Save"
  win.__lastSavePath = filePath;
}
// ---------- end File menu ----------

function createWindow() {
  // Clean up any existing window first
  if (mainWindow) return; // do not destroy/recreate unless needed

 const taIcon = nativeImage.createFromPath(getIconPath('gemini-for-linux.png'));
 /*     console.log('Native path resolved:', taIcon); // Echo to terminal
 if (taIcon.isEmpty()) {
  console.error('ICON FAILED TO LOAD — path is wrong or file corrupted');
 } else {
  console.log('ICON LOADED SUCCESSFULLY');
  console.log('Size:', taIcon.getSize());           // → { width: 512, height: 512 }
  console.log('Has alpha channel:', taIcon.hasAlpha?.() ?? true);
 }
*/
  // Cache app icon & tray sizes once
  if (!appIconImage || appIconImage.isEmpty()) {
    appIconImage = taIcon;
  }
  if (!trayImage24 || trayImage24.isEmpty?.()) {
    try { trayImage24 = taIcon.resize({ width: 24, height: 24 }); } catch {}
  }

  // Compute initial bounds from persisted state (if any)
  const boundsKey = 'main';
  // Compute initial bounds from persisted state (if any)
  const initialBounds = getInitialWindowBounds(boundsKey);
  // Assign to the outer-scoped variable (do NOT redeclare with const here)
  mainWindow = new BrowserWindow({
  skipTaskbar: false,
  title: 'gemini — Main Chat',
    width: initialBounds.width,
    height: initialBounds.height,
    x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
    y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
    show: false, // start hidden; control via tray
//    icon: path.join(__dirname, 'assets', 'gemini-for-linux.png'), // used for window/taskbar on Linux
    icon: appIconImage || taIcon, // cached if available
    webPreferences: {
      nodeIntegration: false,      // renderer cannot use Node APIs
      contextIsolation: true,      // safer: isolates preload from page
      preload: path.join(__dirname, 'preload.js'), // optional: expose safe APIs
      partition: gemini_PARTITION,
      devTools: true,
      backgroundThrottling: true,   // reduce CPU when hidden
      spellcheck: false            // disable if not required
    },
    // Linux-specific: ensure proper window identification
    type: 'normal',
    // Help with focus stealing prevention
    autoHideMenuBar: false

  });

  // Ensure menu bar is visible so users can access Edit → Find…
  mainWindow.setMenuBarVisibility(true);

  // --- Right-click native context menu with Cut/Copy/Paste/SelectAll ---
  const baseContextMenu = Menu.buildFromTemplate([
    { role: 'cut',        accelerator: 'Ctrl+X', enabled: false },
    { role: 'copy',       accelerator: 'Ctrl+C', enabled: false },
    { role: 'paste',      accelerator: 'Ctrl+V', enabled: false },
    { type: 'separator' },
    { role: 'selectAll',  accelerator: 'Ctrl+A', enabled: true  },
  ]);

  function popupContext(win, params) {
    const menu = Menu.buildFromTemplate([
      { role: 'cut',        accelerator: 'Ctrl+X', enabled: !!params?.isEditable },
      { role: 'copy',       accelerator: 'Ctrl+C', enabled: !!(params?.hasSelection || params?.isEditable) },
      { role: 'paste',      accelerator: 'Ctrl+V', enabled: !!params?.isEditable },
      { type: 'separator' },
      { role: 'selectAll',  accelerator: 'Ctrl+A', enabled: true  },
    ]);
    menu.popup({ window: win });
  }

  // Guard against duplicate registrations
  if (!ipcMain.listenerCount('show-context-menu')) {
    ipcMain.on('show-context-menu', (event, params) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    popupContext(win, params);
    });
  }   
  // --- end context menu ---

  mainWindow.setIcon(appIconImage || taIcon);

  // If you initially create hidden:
  mainWindow.once('ready-to-show', () => {
  reveal(mainWindow);
  try { mainWindow.__geminiRole = 'main'; } catch {}
  try { mainWindow.__boundsKey = boundsKey; } catch {}
  setRoleTitle(mainWindow, 'main');
  augmentApplicationMenu(mainWindow);  // Augment the existing app menu with our File/Edit items
  });
  // Safety in case it was toggled elsewhere:
  mainWindow.setSkipTaskbar(false);

  // Electron internally attaches temporary did-stop-loading listeners
  // during executeJavaScript(); this is expected for SPA apps.
  mainWindow.webContents.setMaxListeners(0);
  // OPTIONAL: uncomment this to trace *where* extra listeners are being added:
  // const _origOn = mainWindow.webContents.on.bind(mainWindow.webContents);
  // mainWindow.webContents.on = (evt, fn) => { if (evt === 'did-stop-loading') console.trace('[TRACE] did-stop-loading on()'); return _origOn(evt, fn); };

  mainWindow.loadURL(gemini_URL); // Load your app

  mainWindow.loadURL(gemini_URL);
  
  // Apply the wide layout here too
  applyWideLayout(mainWindow.webContents);

  // Build native context menu purely from main, based on Chromium's params

  mainWindow.webContents.on('context-menu', (_event, params) => {
    // params: { isEditable, selectionText, selectionTextIsEditable, mediaType, linkURL, inputFieldType, x, y, ... }
    const isEditable = !!params.isEditable;
    const hasSelection = !!params.selectionText && params.selectionText.length > 0;

    // Always offer at least a minimal fallback menu so users are not left without options
    const minimalTemplate = [
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            mainWindow.webContents.inspectElement(params.x, params.y);
            if (!mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];

    const template = [
      { role: 'cut',   accelerator: 'Ctrl+X', enabled: isEditable },
      { role: 'copy',  accelerator: 'Ctrl+C', enabled: (hasSelection || isEditable) },
      { role: 'paste', accelerator: 'Ctrl+V', enabled: isEditable },
      { type: 'separator' },
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
 { type: 'separator' },
 {
  label: 'Send to Quick Chat',
  submenu: buildSendToQuickSubmenu(mainWindow, { mode: SEND_MODE.PLAIN, autoSubmit: false })
 },
 {
  label: 'Send as Quote to Quick Chat',
  submenu: buildSendToQuickSubmenu(mainWindow, { mode: SEND_MODE.QUOTE, autoSubmit: false })
 },
 {
  label: 'Send & Auto‑Submit to Quick Chat',
  submenu: buildSendToQuickSubmenu(mainWindow, { mode: SEND_MODE.PLAIN, autoSubmit: true })
 },
 { type: 'separator' },
 {
  label: 'Select Chat Pane',
        accelerator: 'Ctrl+Shift+A',
        enabled: true, // ✅ Always enabled regardless of selection
        click: async () => {
          try {
            const res = await selectChatPane(mainWindow);
            if (!res?.ok) {
              try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
            }
          } catch (err) {
            console.error('Select Chat Pane failed:', err);
            try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message || err)); } catch {}
          }
        }
      },

      // ---- NEW: Save Chat Pane… (right-click) ----
      {
        label: 'Save Chat Pane…',
        click: async () => {
          await promptSaveChatPane(mainWindow);
        }
      },
      { type: 'separator' },
      {
        label: 'Copy Selection as Markdown',
        accelerator: 'Ctrl+Shift+M',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(mainWindow);
            if (!ok) return;
            const md = htmlToMarkdown(html || text);
            clipboard.writeText(md);
          } catch (err) {
            console.error('Copy Selection as Markdown failed:', err);
          }
        }
      },
      {
        label: 'Save Selection as Markdown…',
        enabled: hasSelection,
        click: async () => {
          await saveSelectionAsMarkdown(mainWindow);
        }
      },
      {
        label: 'Save Selection as Plain Text…',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(mainWindow);
            if (!ok) {
              try { dialog.showErrorBox('Save Selection as Text', 'No selection found.'); } catch {}
              return;
            }
            const safeHtml = stripExecutableBlocks(decodeEntities(html || text));
            let plain = stripTags(safeHtml)
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
              title: 'Save Selection as Plain Text',
              defaultPath: 'selection.txt',
              filters: [{ name: 'Plain Text', extensions: ['txt'] }]
            });
            if (canceled || !filePath) return;
            await fs.promises.writeFile(filePath, plain, 'utf8');
          } catch (err) {
            console.error('Save Selection as Plain Text failed:', err);
            try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            // Focus the element under the right-click position
            mainWindow.webContents.inspectElement(params.x, params.y);
            // Ensure DevTools is open so the Elements panel is visible
            if (!mainWindow.webContents.isDevToolsOpened()) {
              // Dock to the right; you can use 'bottom' or omit the mode
              mainWindow.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];
    try { 
      menu = Menu.buildFromTemplate(template);
    }
    catch (err) {
      console.error('Context menu template error:', err);
      // Fallback: minimal safe menu
      menu = Menu.buildFromTemplate([{ role: 'copy', enabled: hasSelection }, { role: 'selectAll' }]);
    }
    try { menu.popup({ window: mainWindow }); }
    catch (err) { console.error('Context menu popup failed:', err); }
  });

  // Control external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => (
    shell.openExternal(url), // open in default browser
    { action: 'deny' }       // block new Electron window
  ));

  // Optional: monitor find results (count, active match); useful for logging or future UI
  mainWindow.webContents.on('found-in-page', (event, result) => {
    // result = { requestId, activeMatchOrdinal, matches, selectionArea, finalUpdate }
    // You can log or use this info to show status in a future overlay.
    // console.log('find:', result);
  });

  // Handle Find modal events (parent-aware)
  if (!ipcMain.listenerCount('find-modal-submit')) {
    ipcMain.on('find-modal-submit', (event, payload) => {
    const wc = getWCFromEventSender(event.sender); if (!wc) return;
    const term = String(payload?.term || '').trim();
    const matchCase = !!payload?.matchCase;
    if (!term) return;
    const isNewTerm = term !== lastFindTerm;
    lastFindTerm = term;

    // Clear old highlights when starting a new term
    if (isNewTerm) {
      wc.stopFindInPage('clearSelection');
    }

    lastFindOpts = applyWordStartOptions({
      ...lastFindOpts,
      matchCase,
      // IMPORTANT: seed new search with findNext: false, continue with true
      findNext: isNewTerm ? false : true,
      forward: (payload?.kind !== 'prev')
    });
    clearTimeout(findDebounce);
    findDebounce = setTimeout(() => {
      try {
        wc.findInPage(lastFindTerm, lastFindOpts);
      } catch (_) {
        // ignore
      }
    }, FIND_DEBOUNCE_MS);
    });
  }

  ipcMain.on('find-modal-clear', (event) => {
    const wc = getWCFromEventSender(event.sender); if (!wc) return;
    wc.stopFindInPage('clearSelection');
  });

  ipcMain.on('find-modal-close', () => {
    if (findModal && !findModal.isDestroyed()) { findModal.close(); }
    findModal = null;
  });

  // Quick keyboard passthrough for Esc to clear highlights even without menu activation
  
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.alt) {
      if (input.key === '=' || input.key === '+') {
        event.preventDefault();
        try { mainWindow.webContents.executeJavaScript('(function(){const cur=window.__gemini_getTargetVW?.() ?? ${VW_SIZE}; window.__gemini_setTargetVW?.(cur+5);})()'); } catch {}
      }
      if (input.key === '-') {
        event.preventDefault();
        try { mainWindow.webContents.executeJavaScript('(function(){const cur=window.__gemini_getTargetVW?.() ?? ${VW_SIZE}; window.__gemini_setTargetVW?.(cur-5);})()'); } catch {}
      }
    }
    if (input.type === 'keyDown' && input.key === 'Escape') {
      const wc = mainWindow.webContents;
      if (wc) wc.stopFindInPage('clearSelection');
    }
  });

  // Persist window state on move/resize; debounce to avoid churn
  mainWindow.on('resize', () => scheduleSaveWindowState(mainWindow, boundsKey));
  mainWindow.on('move', () => scheduleSaveWindowState(mainWindow, boundsKey));
  // Also persist just before quit or close (in case of no recent move/resize)
  mainWindow.on('close', () => scheduleSaveWindowState(mainWindow, boundsKey));

  // Optional: hide instead of close when user closes window
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });


  // Defensive: recreate window if it gets destroyed unexpectedly
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getIconPath(filename) {
  // Handle both development and packaged environments
//  const basePath = __dirname;
  const basePath = app.getAppPath(); 
  const iconPath = path.join(basePath, 'assets', filename);
  
  // For packaged apps, try the asar-unpacked path first
  if (app.isPackaged) {
    const asarPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', filename);
    if (require('fs').existsSync(asarPath)) {

//      console.log('Icon path resolved:', asarPath); // Echo to terminal

      return asarPath;
    }
  }

//      console.log('Icon path resolved:', iconPath); // Echo to terminal  
  return iconPath;
}

function createTray() {
  // Use a 24x24 or 32x32 PNG for Cinnamon panel
  const iconPath = getIconPath('gemini-for-linux.png');

  // Validate path during development (optional)
 //  console.log('Tray icon exists?', require('fs').existsSync(iconPath));


  const trayImage = trayImage24 || nativeImage.createFromPath(iconPath);
  const smallImage = trayImage.isEmpty ? null : trayImage.resize({ width: 24, height: 24 });

  // Fall back to app icon if tray image is missing
  tray = new Tray(smallImage || appIconImage || nativeImage.createFromPath(path.join(__dirname, 'assets', 'gemini-for-linux.png')));

  tray.setToolTip('Microsoft gemini');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => { if (mainWindow) reveal(mainWindow); }
    },
    {
      label: 'Hide',
      click: () => { if (mainWindow) mainWindow.hide(); }
    },
    { type: 'separator' },

    // ---- NEW: About… item ----
    {
      label: 'About…',
      click: async () => {
        const info = getRuntimeInfo();
        try {
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            defaultId: 0,
            title: `About ${info.name}`,
            message: `${info.name}`,
            detail: info.detail,
            noLink: true,
            icon: appIconImage
          });
        } catch (err) {
          console.error('About dialog failed:', err);
        }
      }
    },

    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true; // so close handler doesn’t re-hide
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click toggles window visibility
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      reveal(mainWindow);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
//  createAppMenu();

  // macOS re-activation guard (harmless on Linux)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }

  });
});

// Keep the app running in the tray when all windows are closed
app.on('window-all-closed', () => {
  // Do not quit on Linux; keep tray resident
  // If you want to quit on non-Linux:
  // if (process.platform !== 'linux') app.quit();
});

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
  
  // Best-effort: close quick windows on quit
  try {
    for (const w of quickChatWindows) {
      try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
    }
  } catch {}
} catch {}
});

