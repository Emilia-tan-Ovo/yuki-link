// Adapted from AAAAGENT desktop/electron/preload.cjs at the pinned revision.
const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['ready', 'submit', 'credential', 'workbench-save', 'workbench-open', 'workbench-check', 'persona-load', 'persona-save', 'persona-reset', 'quit']);
contextBridge.exposeInMainWorld('yukiDesktop', {
  send(name, value) { if (commands.has(name)) ipcRenderer.send('yuki:' + name, value); },
  subscribe(callback) { if (typeof callback === 'function') ipcRenderer.on('yuki:delivery', (_event, message) => callback(message)); }
});
