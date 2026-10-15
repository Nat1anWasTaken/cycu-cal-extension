// Offscreen document: hosts the shared clangd worker and the SLM worker for all tabs.
// Content scripts connect here directly with chrome.runtime.connect({name}).

import { LSP_PORT, SLM_PORT } from '../shared/protocol';
import { attachSlmPort } from '../slm/host';
import { LspHost } from './lsp-host';

if (!self.crossOriginIsolated) {
  console.error('[cal] offscreen document is not crossOriginIsolated; clangd (pthreads) cannot start');
}

const lsp = new LspHost();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === LSP_PORT) lsp.attach(port);
  else if (port.name === SLM_PORT) attachSlmPort(port);
});
