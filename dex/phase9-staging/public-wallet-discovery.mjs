const ANNOUNCE = "eip6963:announceProvider";
const REQUEST = "eip6963:requestProvider";

// Announcements are untrusted. Local IDs identify provider objects only for
// this discovery instance. Never render announced icons or trust brand claims.
export function createWalletDiscovery({eventTarget, getFallbackProvider} = {}) {
  const wallets = new Map();
  const providers = new Set();
  let listening = false;
  let nextId = 0;

  function announce(event) {
    if (!listening) return;
    let provider;
    let name;
    try {
      provider = event.detail?.provider;
      if (typeof provider?.request !== "function") return;
      name = event.detail?.info?.name;
    } catch {
      return;
    }
    if (!listening || providers.has(provider)) return;

    const displayName = typeof name === "string"
      ? name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim().slice(0, 80)
      : "";
    const id = "injected-" + ++nextId;
    wallets.set(id, {provider, display: Object.freeze({id, name: displayName || "Injected wallet"})});
    providers.add(provider);
  }

  function stop() {
    if (!listening) return;
    listening = false;
    eventTarget.removeEventListener(ANNOUNCE, announce);
    wallets.clear();
    providers.clear();
  }

  return {
    start() {
      if (listening) return;
      eventTarget.addEventListener(ANNOUNCE, announce);
      listening = true;
      try {
        eventTarget.dispatchEvent(new Event(REQUEST));
      } catch (error) {
        stop();
        throw error;
      }
    },
    stop,

    // Names are labels for text rendering. They do not authenticate a wallet.
    listWallets() {
      return Array.from(wallets.values(), ({display}) => display);
    },

    selectWallet(id) {
      const entry = wallets.get(id);
      if (!entry) throw new Error("WALLET_NOT_DISCOVERED");
      return entry.provider;
    },

    // An integration may inject () => window.ethereum here. The getter is
    // invoked only when the user explicitly selects the fallback.
    selectFallback() {
      const provider = getFallbackProvider?.();
      if (typeof provider?.request !== "function") throw new Error("WALLET_FALLBACK_UNAVAILABLE");
      return provider;
    }
  };
}
