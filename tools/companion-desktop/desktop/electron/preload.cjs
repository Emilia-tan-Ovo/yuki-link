// Adapted from AAAAGENT desktop/electron/preload.cjs at the pinned revision.
const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['ready', 'submit', 'cancel-model', 'voice-command', 'voice-event', 'voice-load', 'voice-save', 'voice-credential', 'memory', 'credential', 'workbench-save', 'workbench-open', 'workbench-check', 'persona-load', 'persona-save', 'persona-reset', 'thinking-load', 'thinking-save', 'quit']);
contextBridge.exposeInMainWorld('yukiDesktop', {
  send(name, value) { if (commands.has(name)) ipcRenderer.send('yuki:' + name, value); },
  subscribe(callback) { if (typeof callback === 'function') ipcRenderer.on('yuki:delivery', (_event, message) => callback(message)); }
});
