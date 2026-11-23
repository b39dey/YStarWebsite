const BSC_CHAIN_ID = 56;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

function currentAccount(accounts) {
  const account = Array.isArray(accounts) ? accounts[0] : null;
  return typeof account === "string" && ADDRESS.test(account) ? account.toLowerCase() : null;
}

function currentChain(chainId) {
  if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId)) return null;
  const value = Number(chainId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// readProviderState(provider) is injected and returns {accounts, chainId}
// in EIP-1193 form. There is no default provider read or wallet request.
// Capture a valid snapshot when preparing an action and call isCurrent
// before using it. Every event, provider change or refresh invalidates it.
export function createWalletSession({readProviderState} = {}) {
  if (typeof readProviderState !== "function") throw new Error("WALLET_STATE_READER_REQUIRED");

  let binding = null;
  let state = Object.freeze({provider: null, account: null, chainId: null, connected: false, valid: false});

  function publish({provider, account = null, chainId = null, connected = false}) {
    state = Object.freeze({
      provider, account, chainId, connected,
      valid: connected && account !== null && chainId === BSC_CHAIN_ID
    });
    return state;
  }

  function clear() {
    const previous = binding;
    binding = null;
    publish({provider: null});
    if (!previous) return;
    const errors = [];
    for (const [event, listener] of previous.listeners) {
      try {
        previous.provider.removeListener(event, listener);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "WALLET_LISTENER_CLEANUP_FAILED");
  }

  function selectProvider(provider) {
    if (typeof provider?.request !== "function" ||
        typeof provider.on !== "function" || typeof provider.removeListener !== "function") {
      throw new Error("INVALID_WALLET_PROVIDER");
    }
    if (binding?.provider === provider) return state;
    clear();

    const selected = {provider, listeners: []};
    binding = selected;
    publish({provider});
    const listeners = [
      ["accountsChanged", accounts => publish({...state, account: currentAccount(accounts)})],
      ["chainChanged", chainId => publish({...state, chainId: currentChain(chainId)})],
      ["disconnect", () => publish({provider})]
    ];
    try {
      for (const [event, update] of listeners) {
        const listener = value => {
          if (binding === selected) update(value);
        };
        selected.listeners.push([event, listener]);
        provider.on(event, listener);
      }
    } catch (error) {
      clear();
      throw error;
    }
    return state;
  }

  async function refresh() {
    const provider = binding?.provider;
    if (!provider) throw new Error("WALLET_NOT_SELECTED");
    const pending = publish({provider});
    const result = await readProviderState(provider);
    const account = currentAccount(result?.accounts);
    const chainId = currentChain(result?.chainId);
    if (state !== pending) throw new Error("WALLET_SESSION_CHANGED");
    return publish({provider, account, chainId, connected: true});
  }

  return {
    selectProvider,
    refresh,
    clear,
    getSnapshot: () => state,
    isCurrent: snapshot => state.valid && snapshot === state
  };
}
