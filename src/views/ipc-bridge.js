(function () {
  const BRIDGE_GLOBAL = "__WHISPLINE_IPC__";

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-ipc-bridge-ran", "1");
  }

  if (typeof window !== "undefined" && window[BRIDGE_GLOBAL]) {
    return;
  }

  const TAURI_READY_TIMEOUT_MS = 3000;
  const TAURI_READY_POLL_MS = 25;

  const tauriCommands = {
    "get-settings": "get_settings",
    "save-settings": "save_settings",
    "get-app-version": "get_app_version",
    "open-settings": "open_settings",
    "close-settings": "close_settings",
    "hide-input-prompt": "hide_input_prompt",
    "cleanup-microphone": "cleanup_microphone",
    "cancel-transcription": "cancel_transcription",
    "transcribe-audio": "transcribe_audio",
    "type-text": "type_text",
    "show-permission-dialog": "show_permission_dialog",
    "check-microphone-permission": "check_microphone_permission",
    "check-accessibility-permission": "check_accessibility_permission",
    "request-accessibility-permission": "request_accessibility_permission",
    "recheck-accessibility-permission": "recheck_accessibility_permission",
    "get-recent-activities": "get_recent_activities",
    "get-dictionary": "get_dictionary",
    "save-dictionary": "save_dictionary",
  };

  const tauriArgs = {
    "save-settings": [["settings", "settingsInput", "settings_input"]],
    "transcribe-audio": [
      ["audioBuffer", "audio_buffer"],
      ["translateMode", "translate_mode"],
      ["mimeType", "mime_type"],
    ],
    "type-text": [["text"]],
    "save-dictionary": [["text"]],
  };

  function hasWindow() {
    return typeof window !== "undefined";
  }

  function getTauriApi() {
    if (!hasWindow()) {
      return null;
    }

    const api = window.__TAURI__;
    if (
      api &&
      api.core &&
      typeof api.core.invoke === "function" &&
      api.event &&
      typeof api.event.listen === "function"
    ) {
      return api;
    }

    return null;
  }

  function getTauriInternals() {
    if (!hasWindow()) {
      return null;
    }

    const internals = window.__TAURI_INTERNALS__;
    if (
      internals &&
      typeof internals.invoke === "function" &&
      typeof internals.transformCallback === "function"
    ) {
      return internals;
    }

    return null;
  }

  function hasTauriEventInternals() {
    return (
      hasWindow() &&
      !!window.__TAURI_EVENT_PLUGIN_INTERNALS__ &&
      typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener ===
        "function"
    );
  }

  function hasTauriRuntimeHint() {
    return hasWindow() && (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForTauriApi() {
    let api = getTauriApi();
    let internals = getTauriInternals();
    if (api || internals) {
      return { api, internals };
    }

    const deadline = Date.now() + TAURI_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(TAURI_READY_POLL_MS);
      api = getTauriApi();
      internals = getTauriInternals();
      if (api || internals) {
        return { api, internals };
      }
    }

    api = getTauriApi();
    internals = getTauriInternals();
    return api || internals ? { api, internals } : null;
  }

  function buildTauriPayload(channel, args) {
    const argNames = tauriArgs[channel] || [];
    const payload = {};

    argNames.forEach((names, index) => {
      const aliases = Array.isArray(names) ? names : [names];
      aliases.forEach((name) => {
        payload[name] = args[index];
      });
    });

    return payload;
  }

  async function invoke(channel, ...args) {
    const tauriRuntime =
      (getTauriApi() || getTauriInternals()) && {
        api: getTauriApi(),
        internals: getTauriInternals(),
      };
    const resolvedRuntime = tauriRuntime || (await waitForTauriApi());
    if (resolvedRuntime) {
      const command = tauriCommands[channel];
      if (!command) {
        throw new Error(`ipc-bridge: unknown Tauri command for channel \"${channel}\"`);
      }

      const payload = buildTauriPayload(channel, args);
      if (resolvedRuntime.api && resolvedRuntime.api.core) {
        return resolvedRuntime.api.core.invoke(command, payload);
      }
      if (resolvedRuntime.internals) {
        return resolvedRuntime.internals.invoke(command, payload);
      }
    }

    throw new Error(`ipc-bridge: runtime unavailable for channel \"${channel}\"`);
  }

  async function listenWithTauriInternals(channel, handler, internals) {
    if (!hasTauriEventInternals()) {
      throw new Error(
        `ipc-bridge: event internals unavailable for channel \"${channel}\"`
      );
    }

    const eventId = await internals.invoke("plugin:event|listen", {
      event: channel,
      target: { kind: "Any" },
      handler: internals.transformCallback(handler),
    });

    return () => {
      try {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(
          channel,
          eventId
        );
      } catch (error) {
        console.warn(`Failed to unregister frontend listener for ${channel}:`, error);
      }

      internals
        .invoke("plugin:event|unlisten", {
          event: channel,
          eventId,
        })
        .catch((error) => {
          console.warn(`Failed to unlisten Tauri event ${channel}:`, error);
        });
    };
  }

  function on(channel, handler) {
    let disposed = false;
    let cleanup = null;

    const attach = async () => {
      const resolvedRuntime =
        (getTauriApi() || getTauriInternals()) && {
          api: getTauriApi(),
          internals: getTauriInternals(),
        };
      const tauri = resolvedRuntime || (await waitForTauriApi());
      if (disposed) {
        return;
      }

      if (tauri) {
        if (tauri.api && tauri.api.event && typeof tauri.api.event.listen === "function") {
          cleanup = await tauri.api.event.listen(channel, (event) => {
            handler(null, event.payload);
          });
          return;
        }

        if (tauri.internals) {
          cleanup = await listenWithTauriInternals(channel, (event) => {
            handler(null, event.payload);
          }, tauri.internals);
          return;
        }

        return;
      }

      throw new Error(`ipc-bridge: runtime unavailable for event \"${channel}\"`);
    };

    attach().catch((error) => {
      console.error(`Failed to attach IPC listener for ${channel}:`, error);
    });

    return () => {
      disposed = true;
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }

  window[BRIDGE_GLOBAL] = {
    invoke,
    on,
    get isTauri() {
      return !!getTauriApi() || !!getTauriInternals() || hasTauriRuntimeHint();
    },
  };

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-ipc-bridge-ready", "1");
  }
})();