// Must be imported before any Monaco module.
//
// In a content script's isolated world `window.customElements` is null (Chromium), but Monaco
// 0.57's base/browser/dom.js runs `customElements.get('connection-observer')` at module load to
// register an element the editor itself never uses. A no-op registry keeps that from throwing.
if ((globalThis as any).customElements == null) {
  const registry: Partial<CustomElementRegistry> = {
    get: () => undefined,
    getName: () => null,
    define: () => {},
    upgrade: () => {},
    whenDefined: () => new Promise<CustomElementConstructor>(() => {}),
  };
  Object.defineProperty(globalThis, 'customElements', { value: registry, configurable: true });
}
export {};
