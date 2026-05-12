## Gemini for Linux — Help

This document describes the **capabilities**, **application menus**, **right-click (context) menus**, **keyboard accelerators**, **tray menu**, **configuration**, and **logging** features available in the Gemini for Linux Electron application.

### Overview & Capabilities

Gemini for Linux is an Electron-based wrapper around **Google Gemini** that adds desktop-oriented workflows on Linux (and Windows builds), including:

- **Main Chat + Multi Quick Chat Windows**
  - Run multiple independent _Quick Chat_ windows alongside the main chat.
  - Each Quick Chat can be renamed, pinned (Always on Top), focused, or closed independently.

- **Send Selection to Gemini**
  - Send text selections from the main window or Quick Chat windows directly into another Quick Chat.
  - Supports plain text, quoted text, and optional auto-submit.

- **Clipboard-Safe Injection**
  - Selection content is converted to Markdown and pasted safely using clipboard-based injection (iframe-safe).

- **Advanced Find in Page**
  - Custom Find dialog with live match count.
  - Temporarily disables lazy rendering so _all_ messages are searchable.

- **Profile-Based Export System**
  - Save the entire chat pane or current selection using seven export profiles:
    - Clean Markdown (.md)
    - Raw Markdown (.md)
    - Markdown with metadata header (.md)
    - Clean HTML (.html)
    - HTML Archive (.mhtml)
    - Plain Text (.txt)
    - PDF (.pdf)
  - Profiles are accessible from the File menu, context menu, and tray.

- **Selection Export**
  - Copy or save selected content as Markdown, plain text, HTML, PDF, or other profiles.

- **Improved Layout & Wrapping**
  - Forces full-width layout.
  - Prevents horizontal scrolling.
  - Ensures code blocks, tables, and long URLs wrap correctly.

- **Shift-Click Direct Download Open**
  - Shift-clicking downloadable links automatically downloads to a temp file and opens it using the system default application.

- **Persistent Session & Window State**
  - Uses a persistent Chromium session partition.
  - Remembers window size and position for main and Quick Chat windows.

- **User Configuration (`config.json`)**
  - Major features can be toggled or tuned via a JSON config file.
  - The file is auto-created on first run with sensible defaults.

- **Dual-Channel Logging**
  - Console and file logging, both independently configurable.
  - Log files are stored in the application logs folder and can be opened from the tray menu.

---

### Configuration (`config.json`)

The application reads its settings from a `config.json` file located in the Electron user-data directory:

- **Linux**: `~/.config/gemini-for-linux/config.json`
- **Windows**: `%APPDATA%/gemini-for-linux/config.json`

On first launch (or if the file is missing), the app creates it automatically with default values. The file is self-documenting — newly introduced keys are added on startup so it always reflects the full set of options.

#### Configuration Keys

| Key | Type | Default | Description |
|---|---|---:|---|
| `geminiUrl` | string | `https://gemini.google.com` |
| `partition` | string | `persist:gemini-for-linux` | Chromium session partition name. Changing this creates a separate session/cookie store. |
| `enableLayoutCss` | boolean | `true` | Inject full-width layout CSS that removes artificial margins and forces content wrapping. |
| `enableDirectOpen` | boolean | `true` | Enable Shift+click direct-download-and-open behavior. |
| `enableQuickChat` | boolean | `true` | Enable the Quick Chat subsystem (menu, tray items, keyboard shortcuts). |
| `defaultExportFormat` | string | `md` | Default file format for the Save Chat Pane dialog. Accepted: `md`, `pdf`, `html`, `mhtml`, `txt`. |
| `defaultPaneExportProfile` | string | `cleanMarkdown` | Default export profile for chat pane exports. |
| `defaultSelectionExportProfile` | string | `cleanMarkdown` | Default export profile for selection exports. |
| `quickPasteDelayMs` | integer | `3000` | Fallback delay (ms) before pasting into Quick Chat if input-readiness detection times out. |
| `findContentVisibilityOverride` | boolean | `true` | When the Find modal is open, temporarily override `content-visibility: auto` so Chromium can search all messages. |
| `devToolsEnabled` | boolean | `true` | Allow opening DevTools (Inspect Element, Toggle DevTools). |
| `enableConsoleLogging` | boolean | `true` | Write log output to stdout/stderr (the terminal). |
| `enableFileLogging` | boolean | `true` | Write log output to a file in the logs folder. |
| `logFileName` | string | `gemini-for-linux.log` | Name of the log file (unsafe characters are sanitized). |

**Tip:** You can open the config file directly from the tray menu → **Open Config File**. Changes take effect after restarting the application.

**Note:** The partition key can also be overridden by the `GEMINI_PARTITION` environment variable, which takes precedence if set.

---

### File Logging

When `enableFileLogging` is `true`, every `console.log`, `console.info`, `console.debug`, `console.warn`, and `console.error` call is appended to a log file in the application logs directory.

- **Log location**: the folder returned by Electron’s `app.getPath('logs')`, typically:
  - Linux: `~/.config/gemini-for-linux/logs/`
  - Windows: `%APPDATA%/gemini-for-linux/logs/`
- **Log format**: `[ISO-8601 timestamp] [LEVEL] message`
- Example: `[2026-05-05T21:30:00.123Z] [LOG] Gemini loaded successfully`
- **Log file name**: controlled by the `logFileName` config key.
- **Open from tray**: use **Tray → Open Logs Folder** to open the logs directory in your file manager.

Console logging (`enableConsoleLogging`) and file logging (`enableFileLogging`) are independent — you can enable one, both, or neither.

---

### Export Profiles

The application uses a **profile-based export system** for both chat pane and selection exports. Each profile defines a conversion pipeline, default file extension, and save-dialog filters.

| Profile Key | Label | Extension | Description |
|---|---|---|---|
| `cleanMarkdown` | Clean Markdown | `.md` | DOM is cleaned (buttons, reactions, toolbars removed), then converted to Markdown via Turndown. This is the default profile. |
| `rawMarkdown` | Raw Markdown | `.md` | HTML is converted to Markdown **without** DOM cleanup — preserves more of the original page structure. |
| `markdownWithMetadata` | Markdown with metadata header | `.md` | Same as Clean Markdown, but prepends a YAML front-matter block with title, source URL, timestamp, and profile name. |
| `html` | HTML | `.html` | Cleaned standalone HTML document with minimal readable CSS. Hashed classes and inline styles are stripped. |
| `htmlArchive` | HTML archive | `.mhtml` | Full-page MHTML archive via Chromium’s `savePage`. Non-chat content is hidden with CSS before saving. _(Pane export only — not available for selection.)_ |
| `plainText` | Plain text | `.txt` | All HTML tags stripped, entities decoded, whitespace normalized. |
| `pdf` | PDF | `.pdf` | Cleaned HTML rendered in a hidden `BrowserWindow` and exported via `printToPDF` (Letter size, background graphics enabled). |

Profiles are accessible from:

- **File → Export Chat Pane**
- **File → Export Selection**
- **Right-click → Save Selection As**
- Programmatically via the `defaultPaneExportProfile` and `defaultSelectionExportProfile` config keys

---

### Application Menu

#### File Menu

| Menu Item | Accelerator | Description |
|---|---|---|
| **Save Chat Pane** | `Ctrl+S` | Save the entire chat pane using the default pane export profile. |
| **Export Chat Pane** _(submenu)_ | — | Choose a specific export profile for the chat pane. |
| **Export Selection** _(submenu)_ | — | Choose a specific export profile for the current selection. |
| **Save Selection as Markdown** | `Ctrl+Shift+M` | Save the currently selected content as a Clean Markdown file. |

#### Edit Menu

| Menu Item | Accelerator | Description |
|---|---|---|
| **Find** | `Ctrl+F` | Open the custom Find-in-Page dialog. |
| **Find Next** | `F3` | Jump to the next match in the page. |
| **Find Previous** | `Shift+F3` | Jump to the previous match in the page. |
| **Clear Highlights** | `Esc` | Clear current find highlights. |
| **Select Chat Pane** | `Ctrl+Shift+A` | Select the entire chat pane content for copy/export. |

#### Quick Chat Menu

This menu dynamically reflects currently open Quick Chat windows.

| Menu Item | Accelerator | Description |
|---|---|---|
| **New Quick Chat Window** | `Ctrl+Alt+N` | Open a new Quick Chat window. |
| **Show Active Quick Chat** | `Ctrl+Alt+2` | Bring the active Quick Chat to the front. |
| **Send Selection to Active Quick Chat** | `Ctrl+Alt+Q` | Send current selection as plain text. |
| **Send Selection as Quote** | `Ctrl+Alt+Shift+Q` | Send selection as quoted Markdown. |
| **Send Selection & Auto Submit** | `Ctrl+Alt+Enter` | Paste and automatically submit the message. |
| **Send Selection to Specific Quick Chat** | `Ctrl+Alt+W` | Choose a Quick Chat target from a dialog. |
| **Quick Chat #N** _(submenu)_ | — | Window-specific actions: Bring to Front, Send Here, Send as Quote Here, Send & Auto Submit Here, Pin Always on Top, Rename, Close. |
| **Close All Quick Chat Windows** | — | Close all Quick Chat windows. |

#### Session Menu

| Menu Item | Accelerator | Description |
|---|---|---|
| **Reload Gemini** | `Ctrl+R` | Reload the page normally. |
| **Hard Reload** | `Ctrl+Shift+R` | Reload while bypassing cache. |
| **Clear Gemini Cache** | — | Clear Chromium cache only. |
| **Clear Cookies / Sign Out** | — | Clear cookies and storage and reload. |
| **Copy Current URL** | — | Copy the current Gemini URL to the clipboard. |
| **Open Current URL in External Browser** | — | Open the current page in the default system browser. |

#### Help Menu

| Menu Item | Accelerator | Description |
|---|---|---|
| **Application Help** | `F1` | Open the built-in help viewer (renders `assets/help.md` in a dedicated window). |
| **About** | — | Show application version and runtime information (Electron, Chromium, Node, V8). |

---

### Right-Click (Context) Menu

The context menu adapts based on selection and window type.

#### Standard Editing

| Action | Notes |
|---|---|
| Cut | Enabled in editable fields. |
| Copy | Enabled when text is selected. |
| Paste | Enabled in editable fields. |
| Select All | Always available. |

#### Quick Chat Actions

| Action | Description |
|---|---|
| Send to Quick Chat _(submenu)_ | Send selection to the active Quick Chat, a specific Quick Chat, or a new one. |
| Send as Quote to Quick Chat _(submenu)_ | Send quoted Markdown. |
| Send & Auto Submit to Quick Chat _(submenu)_ | Paste and auto-submit. |
| New Quick Chat Window | Open a new Quick Chat. |

#### Chat Pane Actions

| Action | Accelerator | Description |
|---|---|---|
| Select Chat Pane | `Ctrl+Shift+A` | Select full conversation output. |
| Save Chat Pane | — | Export entire pane using the default profile. |

#### Export

| Action | Accelerator | Description |
|---|---|---|
| Copy Selection as Markdown | `Ctrl+Shift+M` | Copy Markdown to the clipboard. |
| Save Selection as Markdown | — | Save to file. |
| **Save Selection As** _(submenu)_ | — | Choose an export profile: Clean Markdown, Raw Markdown, Markdown with metadata, HTML, Plain text, PDF. |
| Save Selection as Plain Text | — | Save cleaned text. |

#### Developer

| Action | Accelerator | Description |
|---|---|---|
| Inspect Element | `Ctrl+Shift+C` | Open DevTools at the cursor location. |

---

### Keyboard Accelerators

| Shortcut | Action |
|---|---|
| **Ctrl+S** | Save Chat Pane |
| **Ctrl+Shift+M** | Save / Copy Selection as Markdown |
| **Ctrl+Shift+A** | Select Chat Pane |
| **Ctrl+F** | Find in Page |
| **F3** | Find Next |
| **Shift+F3** | Find Previous |
| **Esc** | Clear Find Highlights |
| **Ctrl+Alt+N** | New Quick Chat Window |
| **Ctrl+Alt+2** | Show Active Quick Chat |
| **Ctrl+Alt+Q** | Send Selection to Active Quick Chat |
| **Ctrl+Alt+Shift+Q** | Send Selection as Quote |
| **Ctrl+Alt+Enter** | Send Selection & Auto Submit |
| **Ctrl+Alt+W** | Choose Quick Chat Target |
| **Ctrl+R** | Reload |
| **Ctrl+Shift+R** | Hard Reload |
| **Ctrl+Shift+C** | Inspect Element |
| **F1** | Application Help |

---

### Tray Menu

| Tray Item | Description |
|---|---|
| **Show** | Show the main window. |
| **Hide** | Hide the main window. |
| **New Quick Chat** | Create a new Quick Chat window. |
| **Show Active Quick Chat** | Bring the active Quick Chat to the front. |
| **Save Chat Pane** | Export current chat using the default profile. |
| **Reload** | Reload Gemini. |
| **Toggle Always on Top** | Pin/unpin the active window. |
| **Clear Session/Cache** _(submenu)_ | Session and cache management. |
| ↳ Clear Gemini Cache | Clear Chromium cache only. |
| ↳ Clear Cookies / Sign Out | Full sign-out: clears cookies, local storage, session storage, IndexedDB, service workers, cache storage, then reloads. |
| **Open Logs Folder** | Open the application logs directory in the file manager. |
| **Open Config File** | Open `config.json` in the system default editor. |
| **About** | Show app information. |
| **Quit** | Exit the application. |

---

### Tips

- **Shift + Click on links** to auto-download and open files with the system default application.
- Use **Quick Chat windows** for side-by-side comparisons or long-running prompts.
- Markdown export preserves **code blocks**, **tables**, and **diffs** reliably.
- Use **Markdown with metadata** export to include a YAML front-matter header with title, URL, and timestamp — useful for archiving.
- Open **config.json** from the tray menu to toggle features like layout CSS, Quick Chat, direct-open, or DevTools without editing code.
- Enable **file logging** to capture debug output for troubleshooting; open the logs folder from the tray menu.
- The **content-visibility override** (`findContentVisibilityOverride`) ensures Find-in-Page works across all messages, including content lazily rendered off-screen. Disable it only if you experience performance issues during search.

_End of Help Documentation_
