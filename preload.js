// preload.js
const { contextBridge, ipcRenderer } = require('electron');
// ============================================================================
// Host API (Quick Chat interactions are clipboard-based in main)
// ============================================================================
// Optional host API for future in-page integrations (not required by menus)
contextBridge.exposeInMainWorld('geminiHost', {
  /**
   * Ask main process to send current selection to Quick Chat.
   * options = { mode: 'plain'|'quote', autoSubmit: boolean, targetQuickId?: number }
   */
  sendSelection(options = {}) {
    ipcRenderer.send('gemini:send-selection', {
      mode: options.mode || 'plain',
      autoSubmit: !!options.autoSubmit,
      targetQuickId: (typeof options.targetQuickId === 'number') ? options.targetQuickId : null
    });
  },
  /**
   * Create a new Quick Chat window.
   */
  newQuickChat() {
    ipcRenderer.send('gemini:quick-new');
  }
});
