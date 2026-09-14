(() => {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-i18n-ran", "1");
  }

  const translations = {
    en: {
      sidebar: {
        home: "Home",
        dictionary: "Dictionary",
        history: "History",
        settings: "Settings",
        help: "Help",
      },
      home: {
        ready: "Ready to dictate",
        setupNeeded: "Finish setup to start",
        readyHint: "Hold the shortcut in any app and start speaking",
        setupHint: "Add what's missing below, then you're ready",
        dictate: "Dictate",
        english: "English",
        readyBadge: "Ready",
        setupBadge: "Setup",
        recentTitle: "Recent",
        viewAll: "View all",
        noActivity: "No recent activity",
        engineLabel: "Engine",
        engineLocalQwen: "Qwen",
        engineLocalQwenLarge: "Qwen 1.7B",
        engineCaptionLocalQwenLarge: "Qwen3-ASR 1.7B runs locally · Experimental · Compare speed and accuracy on your device",
        engineLocalNemotron: "Nemotron",
        engineRecommended: "Recommended",
        engineExperimental: "Experimental",
        engineChecking: "Checking\u2026",
        engineReadyLocal: "Local",
        engineReadyCloud: "Cloud",
        engineDownloading: "Downloading\u2026",
        engineDownloadProgress: "Downloading \u00b7 {percent}%",
        engineNeedsDownload: "Needs download",
        engineNeedsSetup: "Needs setup",
        engineCaptionLocalQwen: "Qwen3-ASR runs locally — ordinary dictation stays on this computer",
        engineCaptionLocalNemotron: "Nemotron 3.5 runs locally with live transcription",
        engineCaptionGroq: "Cloud transcription with your Groq key",
        engineCaptionOpenai: "Cloud transcription with your OpenAI key",
      },
      readiness: {
        apiKey: "API key",
        microphone: "Microphone",
        accessibility: "Accessibility",
        addApiKey: "Add API key",
        localModel: "Local model",
        engine: "Transcription engine",
        axGuide: {
          title: "Turn on Accessibility to finish setup",
          lead: "macOS asks for this permission so SayType can do exactly two things:",
          useInsert: "Type your dictated text into whatever app you're using",
          useHotkey: "Notice the hold-to-dictate shortcut while you're in any app",
          privacy:
            "SayType never logs your keystrokes, never watches other apps, and never uploads anything — this permission is used only for the two things above.",
          open: "Open Accessibility Settings",
          waiting: "Waiting for permission…",
          waitingHint:
            "In System Settings, turn on the switch next to SayType — this screen continues automatically once it's on.",
          retryHint:
            "Permission not detected yet. Turn on SayType in the Accessibility list, or try again.",
          revealApp: "Reveal SayType in Finder",
          revealHint: "Can't find SayType in the list? Drag it in from Finder — same as clicking +.",
        },
      },
      onboarding: {
        start: "Get started",
        next: "Next",
        back: "Back",
        skip: "Skip for now",
        skipStep: "Skip this step for now",
        finish: "Done",
        resume: "Continue setup guide",
        welcome: {
          title: "Speak. It types.",
          lead: "In any app, hold the shortcut and talk — release, and the words appear at your cursor.",
          holdTitle: "Hold {keys}",
          holdDesc: "in any text field",
          speakTitle: "Speak",
          speakDesc: "then just let go",
          insertTitle: "Text appears",
          insertDesc: "typed at your cursor",
        },
        privacy: {
          title: "Local dictation. Your voice stays here.",
          lead: "With a local model, speech becomes text on this computer — without uploading audio.",
          noAccount: "No sign-up needed for local dictation",
          offline: "Download the model once, then dictate offline",
          line2: "History is stored only on this computer",
        },
        mic: {
          title: "Let SayType hear you",
          lead: "It records only while you hold the shortcut — release, and it stops.",
          enable: "Enable microphone",
          enableHint: "Your system will ask for microphone access — allow it to continue.",
          granted: "Microphone ready",
          denied:
            "Microphone access was denied. Turn on SayType under System Settings → Privacy & Security → Microphone — this page continues automatically.",
          unknown: "Not yet tested with a recording",
          openSettings: "Open Microphone Settings",
        },
        ax: {
          title: "Let it type for you",
          granted: "Accessibility ready",
        },
        key: {
          title: "Connect your transcription service",
          lead: "SayType ships no built-in quota — you use your own API key, so your data and billing stay yours.",
          leadCloudDefault: "This computer has limited memory or CPU cores. OpenAI is the default; local Qwen is still available.",
          cloudDefault: "Default on this computer to avoid slow local transcription.",
          localDescription: "Transcribes on this computer. No account needed.",
          localKind: "Local model",
          cloudKind: "Cloud service",
          cloudNotice: "Dictation audio is sent to {provider} for transcription, using your own API key.",
          localSlow: "Local transcription may be very slow on this computer.",
          largeSlow: "Experimental. More memory, potentially slower; accuracy improvement is unmeasured.",
          largeComparison: "Experimental. Compare its measured speed and memory below.",
          comparisonDownload: "Download",
          comparisonMemory: "Peak memory",
          comparisonTime: "30 s audio → text",
          comparisonNote: "Measured on M4 / 24 GB: transcription only, excluding model loading and insertion. Accuracy improvement has not been measured.",
          more: "More options ▸",
          moreHide: "Hide more options ▾",
          cloudSetup: "Click to select and configure your API key.",
          keyLabel: "{provider} API key",
          downloadProgress: "Downloading {percent}%",
          downloadMissing: "Not downloaded",
          downloadReady: "Ready",
          downloadFailed: "Download failed — open to retry",
          otherDownloading: "Another model is downloading. Finish or cancel it in Settings first.",
          titleLocalFirst: "Choose your transcription engine",
          leadLocalFirst:
            "Choose free, offline dictation on this computer, or use OpenAI with your own API key.",
          localNemotronName: "Local · Nemotron 3.5 ASR",
          localQwenName: "Local · Qwen3-ASR",
          localRecommendedTag: "Recommended · free · offline",
          localOfflineTag: "Free · offline",
          localAbsent: "One-time {total} download — click to select and download.",
          localResume: "Download interrupted — click to resume where it left off.",
          localDownloading: "Downloading… {done} / {total}. You can keep going and finish setup later.",
          localReady: "Downloaded and ready — click to use the local engine.",
          localSelected: "Selected — ordinary dictation runs on this computer.",
          localError: "Download failed: {reason} Click to retry.",
          cloudToggle: "Or connect a cloud service (Groq / OpenAI) ▸",
          cloudToggleHide: "Hide cloud options ▾",
          groqTag: "Your own key",
          groqDesc: "Use your own Groq key. Quotas are set by Groq.",
          openaiDesc: "Uses your own OpenAI API key. Pay as you go.",
          placeholderGroq: "Paste your Groq API key (gsk_…)",
          placeholderOpenai: "Paste your OpenAI API key (sk-…)",
          save: "Save",
          saved: "Saved ✓",
          getKeyGroq: "No key yet? Create one free at console.groq.com (about a minute).",
          getKeyOpenai: "No key yet? Create one at platform.openai.com.",
          configured: "This provider already has a key — you can go straight on.",
          error: "Couldn't save: {message}",
        },
        try: {
          engineReady: "Engine ready",
          micUnchecked: "Microphone not yet tested",
          historyHint: "If text does not appear, find it in History.",
          historyFallback: "A result was saved, but nothing appeared here. Open History to check or copy it.",
          success: "Text received! You can use this shortcut in other apps too.",
          title: "Ready! Say your first sentence",
          lead: "It works the same way in every app from now on.",
          placeholder: "Put the cursor here, hold {keys} and say: nice weather today",
          hint: "Hold {keys} and speak → release → the text lands here",
        },
        tryPending: {
          title: "Almost there",
          lead: "Finish the items below and you're set — or head into the app; the readiness card on Home will keep track.",
        },
      },
      update: {
        checkShort: "Check for updates",
        checkingShort: "Checking…",
        downloadingShort: "Downloading {version}",
        restartShort: "Restart to update",
        readyTitle: "{version} is downloaded — restart to use it",
        cardTitle: "{version} is ready",
        cardHint: "Restart whenever suits you — it won't do it on its own.",
        restart: "Restart to update",
      },
      history: {
        title: "History",
        subtitle: "Your recent transcriptions",
        search: "Search",
        clearAll: "Clear all",
        confirmClear: "Click again to confirm",
        empty: "No history yet",
        noResults: "No matches",
        today: "Today",
        yesterday: "Yesterday",
      },
      dictionary: {
        title: "Dictionary",
        subtitle: "Add custom words and phrases to improve transcription accuracy",
        label: "Custom Dictionary Prompt:",
        placeholder:
          "Enter custom words, phrases, or context to help improve transcription accuracy. For example: 'Technical terms: API, JSON, OAuth, WebSocket'",
        save: "Save Dictionary",
        saved: "Saved!",
        helpTitle: "How to use the Dictionary",
        helpItem1: "Add technical terms, proper nouns, or domain-specific vocabulary",
        helpItem2: "Include context or examples for better recognition",
        helpItem3: "Use clear, descriptive language",
        helpItem4:
          "This content will be sent as a prompt to improve transcription accuracy",
        localNote:
          "The local engine does not receive the dictionary — it goes out as a prompt parameter, which only the cloud APIs accept. Your entries are kept and apply again on Groq or OpenAI.",
        punctuationTitle: "Automatic punctuation for Chinese",
        punctuationDesc:
          "When transcribing Chinese with a Whisper model, SayType automatically appends the fixed example below after your dictionary so punctuation comes out reliably. It contains no personal data, and is not added for GPT models or other languages.",
        saveError: "Error saving dictionary: {message}",
      },
      activity: {
        retryErrors: {
          historyRead: "Could not read History. Please try again.",
          entryMissing: "This history entry no longer exists.",
          notPending: "This history entry is no longer pending.",
          audioMissing: "The recording for this entry is no longer available.",
          audioRead: "Could not read the recording. Please try again.",
          settingsRead: "Could not read Settings. Please try again.",
          resultSave: "Could not save the retry result. Please try again.",
          audioFormat: "The local engine cannot read this recording’s format. Switch to a cloud engine in Settings to re-transcribe it.",
          noSpeech: "No speech detected",
          captureIncomplete: "Recording incomplete. Audio retained for retry.",
        },
        copyTitle: "Copy text",
        deleteTitle: "Delete",
        playTitle: "Play recording (debug)",
        pendingAudio: "Transcription stalled — tap to retry",
        pendingHint: "The recording is kept — re-transcribe once the cause is fixed.",
        retranscribeTitle: "Re-transcribe",
        retranscribeFailed: "Re-transcribe failed — try again",
        retranscribeFailedReason: "Re-transcribe failed: {reason}",
      },
      settings: {
        title: "Settings - SayType",
        pageTitle: "Settings",
        pageSubtitle: "Settings save automatically. Click the check button to use an engine; click its title to configure it.",
        tabsAria: "Settings sections",
        modelSingleHint: "Cloud transcription · billed by audio duration.",
        modelMultipleHint: "Prices in USD. Groq bills at least 10 seconds per request.",
        modelOpenaiPrice: "US$0.0045/min · US$0.27/audio hour",
        modelOpenaiDetail: "High-accuracy multilingual transcription. The model used for OpenAI dictation in SayType.",
        modelTurboPrice: "US$0.04/audio hour",
        modelTurboDetail: "Recommended for everyday dictation: faster and lower cost. Groq benchmark: 12% word error rate.",
        modelV3Price: "US$0.111/audio hour · 2.8× the cost",
        modelV3Detail: "Slower, with a lower word error rate in Groq’s benchmark (10.3%). Actual accuracy depends on your audio.",
        advanced: "Advanced settings",
        section: {
          dictation: "Dictation Settings",
          app: "App Settings",
          engines: "Engines & Translation",
        },
        recordingShortcut: {
          title: "Recording shortcut",
          description:
            "Choose your preferred hold-to-record shortcut. Translation uses Shift + Alt.",
          selectTitle: "Select recording shortcut",
        },
        accessibility: {
          title: "Accessibility Permission",
          description: "Required for global hotkeys and automatic text insertion.",
          granted: "✅ Accessibility permission granted",
          notRequired: "✅ Not required on this platform",
          denied: "❌ Accessibility permission denied",
          rechecking: "Rechecking...",
        },
        microphone: {
          title: "Microphone Permission",
          description: "Current status of microphone access permission.",
        },
        permission: {
          checking: "Checking...",
          granted: "✅ Granted",
          notDetermined: "Microphone access has not been requested yet",
          denied: "❌ Denied — please enable in System Settings",
          restricted: "❌ Restricted by system policy",
          error: "❌ Error checking permission",
        },
        checkPermission: "Check Permission",
        uiLanguage: {
          title: "Interface language",
          description: "Choose the language used in the app UI.",
          selectTitle: "Select interface language",
          auto: "System",
          english: "English",
          chinese: "中文",
        },
        theme: {
          title: "Theme",
          description: "Light, dark, or follow your system.",
          selectTitle: "Select interface theme",
          option: {
            auto: "System",
            midnight: "Dark",
            elegant: "Light",
          },
        },
        transcriptionLanguage: {
          title: "Set default language",
          description: "Choose the default language for voice transcription.",
          auto: "Auto-detect",
          selectTitle: "Select default language for transcription",
          localNote:
            "Qwen detects the language automatically and does not use this setting.",
          groupCommon: "Common",
          groupAll: "All languages",
        },
        mergeSpelledLetters: {
          title: "Merge spelled-out letters",
          description: "Join space-separated capital letters, for example A P I → API. Keep punctuation and line breaks.",
        },
        autoLaunch: {
          title: "Start with system",
          description: "Automatically start SayType when your computer starts up.",
          aria: "Start with system",
        },
        startMinimized: {
          title: "Start minimized",
          description:
            "When starting with system, hide the main window and run in the background.",
          aria: "Start minimized",
        },
        updates: {
          title: "Software updates",
          description: "New versions download in the background; you choose when to restart.",
          check: "Check for updates",
          restart: "Restart to update",
          checking: "Checking…",
          downloading: "Downloading v{version}…",
          ready: "v{version} ready — restart to update",
          upToDate: "v{version} — up to date",
          error: "Update check failed: {message}",
        },
        diagnostics: {
          title: "Diagnostic logs",
          description: "View and copy the local log used to investigate performance problems.",
          refresh: "Refresh",
          copy: "Copy all",
          contentAria: "Diagnostic log content",
          loading: "Loading log…",
          empty: "No diagnostic log is available yet.",
          loaded: "{size} · Updated {time}",
          truncated: "Showing the latest {size} · Updated {time}",
          loadError: "Could not read the log: {message}",
          copied: "Copied to clipboard",
          copyError: "Could not copy the log: {message}",
        },
        apiProvider: {
          title: "Transcription Provider",
          description: "Choose a cloud provider or local engine.",
          selectTitle: "Select transcription provider",
          localQwenLarge: "Local · Qwen3-ASR 1.7B · Experimental",
          localNemotron: "Local · Nemotron 3.5 ASR",
          localQwen: "Local · Qwen3-ASR · ★ Recommended",
        },
        nemotronLatency: {
          title: "Nemotron look-ahead",
          description: "Model look-ahead; total response time also includes audio and processing.",
          selectTitle: "Select Nemotron latency",
          balanced: "Lower latency · 0.56 s",
          accuracy: "Higher accuracy · 1.12 s",
        },
        engine: {
          active: "Currently in use",
          activeModel: "In use · {model}",
          whisperLarge: "Whisper Large V3",
          whisperTurbo: "Whisper Large V3 Turbo",
          gptTranscribe: "GPT Transcribe",
          use: "Use {model}",
          switching: "Switching…",
          switchFailed: "Engine unchanged.",
          invalidModel: "Choose an available model.",
          keyRequired: "Enter an API key before using this model.",
          cloudNotice: "Using this cloud model uploads dictation audio to its provider.",
          recommended: "Recommended",
          experimental: "Experimental",
          localQwenLarge: {
            name: "Qwen3-ASR 1.7B",
            description: "Experimental: about 2.5 GB to download and 2.9 GB peak process memory on M4 / 24 GB. A 30-second clip took 2.07 s versus 0.96 s with 0.6B, excluding model load. Accuracy improvement has not been measured.",
          },
          localQwen: {
            name: "Qwen3-ASR 0.6B",
            description: "Decodes on this computer — audio never leaves the device. Good Chinese punctuation.",
          },
          groq: {
            name: "Groq",
            description: "The fastest cloud Whisper. Audio is uploaded to Groq.",
          },
          openai: {
            name: "OpenAI",
            description: "Best punctuation of the cloud options (gpt-transcribe). Audio is uploaded to OpenAI.",
          },
          localNemotron: {
            name: "Nemotron 3.5 ASR",
            description: "Streams while you speak, but noticeably less accurate than Qwen.",
          },
          status: {
            ready: "Ready",
            downloading: "Downloading",
            needsDownload: "Needs download",
            needsKey: "Needs a key",
            keySet: "Key saved",
            local: "On this device",
          },
        },
        apiKey: {
          title: "API Key",
          description: "Stored locally on this device. Shown hidden by default.",
          groqPlaceholder: "Groq API key",
          openaiPlaceholder: "OpenAI API key",
          reveal: "Show key",
          hide: "Hide key",
        },
        translateCloud: {
          title: "Cloud translation (optional)",
          description:
            "Local dictation needs no API key. Expand only to set up English translation with Shift + Alt.",
          uploadNote:
            "Translation sends your recording to the selected cloud provider. Ordinary dictation stays on this device.",
          selectTitle: "Select the provider translation uses",
        },
        model: {
          title: "Model",
          description: "Select transcription model.",
          selectTitle: "Select transcription model",
          recommendedTag: "★ Recommended",
          options: {
            gptTranscribe: "GPT Transcribe — $0.0045/min ($0.27/hr)",
            whisperLargeV3:
              "Whisper Large V3 (Standard) — $0.00185/min ($0.111/hr)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo (Faster) — $0.000667/min ($0.04/hr)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B (on-device) — free, offline",
            nemotron35Local: "Nemotron 3.5 ASR 0.6B (live) — free, offline",
          },
        },
        localModel: {
          title: "Local model",
          statusAbsent: "Not downloaded — about {total} on disk, one-time download.",
          statusPartial: "Download interrupted — resume where it left off.",
          statusDownloading: "Downloading… {done} / {total}",
          statusReady: "Ready · {size} on disk",
          statusUnsupported: "Nemotron is not available on this platform.",
          download: "Download model",
          resume: "Resume download",
          cancel: "Cancel download",
          delete: "Delete model",
          deleteConfirm: "Delete the local model? You'll need to download ~1 GB again to use it.",
          deletePartial: "Discard download",
          deletePartialConfirm:
            "Discard the unfinished download and free up the disk space? You can start it again anytime.",
          notReady: "Download the local model first, then save.",
          downloadFailed: "Model download failed: {reason}",
          switchPrompt: "Local model is ready. Switch transcription to the local engine now?",
        },
        localCompute: {
          title: "GPU acceleration",
          selectTitle: "Select the backend the local engine runs on",
          auto: "Automatic (currently CPU)",
          cpu: "CPU",
          gpu: "GPU (Vulkan)",
          statusCpu:
            "Running on the CPU. A discrete GPU is usually faster; integrated graphics (Intel HD/UHD) measured about twice as slow here, so it is worth leaving on the CPU.",
          statusAbsent: "Needs a one-time {total} download of the Vulkan runtime.",
          statusDownloading: "Downloading the GPU runtime… {done} / {total}",
          statusReady: "Using {device}.",
          statusNoDevice: "The GPU runtime is installed, but no usable Vulkan device was found — still running on the CPU. A graphics driver update may fix it.",
          statusFellBack: "The GPU could not be started this session, so transcription fell back to the CPU. Restart SayType to try again.",
          download: "Download GPU runtime",
          retry: "Retry download",
          cancel: "Cancel download",
          delete: "Remove GPU runtime",
          deleteConfirm: "Remove the GPU runtime and go back to the CPU? The models stay; only the 33 MB runtime is deleted.",
          downloadFailed: "GPU runtime download failed: {reason}",
        },
        saved: "Saved",
        saveError: "Couldn't save — the last change was not kept.",
        permissions: {
          allGranted: "System permissions are in place",
          allGrantedDetail:
            "Microphone and Accessibility are both granted — recording and automatic insertion work.",
          recheck: "Re-check",
          checked: "Checked — all permissions are in place.",
          needsAttention: "Checked — some permissions need attention. See the controls below.",
          checkFailed: "Could not complete the permission check. Please try again.",
        },
        dictionaryLink: {
          title: "Dictionary",
          description:
            "Proper nouns and terms you say often, passed to the cloud engines so they come out spelled your way.",
          open: "Edit dictionary",
        },
        about: {
          title: "About",
          reveal: "Show in Finder",
        },
      },
      axCloud: {
        hint: "Drag me into the list",
        close: "Close",
      },
      microphoneAccess: {
        unknown: "Microphone not yet checked",
        granted: "Microphone available",
        denied: "Microphone access blocked",
        unavailable: "No microphone found",
        error: "Microphone check failed — try again",
        check: "Check microphone",
        checking: "Checking microphone…",
        deniedHint: "Allow desktop apps to access the microphone in Windows Settings, then return and check again.",
        settingsFailed: "Could not open Windows microphone settings. Open Privacy & security → Microphone manually.",
      },
      inputPrompt: {
        title: "Voice Input",
        hint: "Hold {record} to dictate, {translate} for English",
        starting: "Starting recording...",
        listening: "Listening...",
        listeningEnglish: "Listening (English output)...",
        recording: "Recording",
        cancelled: "Cancelled",
        processing: "Processing...",
        transcribing: "Transcribing audio...",
        recordingWithDuration: "Recording {duration}",
        transcribingCount: "Transcribing ({count})",
        inserting: "Inserting...",
        insertingCount: "Inserting ({count})",
        statusSeparator: " · ",
        noAudio: "No audio captured",
        noSpeech: "No speech detected",
        transcriptionFailed: "Transcription failed - please try again",
        transcriptionFailedReason: "Transcription failed: {reason}",
        transcriptionHungSaved: "Transcription stalled - saved to History to retry",
        recordingInterrupted: "Recording interrupted",
        transcriptionIncompleteTitle: "Transcription incomplete",
        transcriptionIncompleteHint: "Recovered text is available. You can copy it here.",
        recoverySavedHint: "Saved to History. You can copy it here or continue dictating.",
        localModelMissingTitle: "Local model is not downloaded yet",
        localModelMissing: "Finish downloading the model to start dictating.",
        openLocalModel: "Open model settings",
        noApiKeyTitle: "API key required",
        noApiKey: "Add your API key in Settings first",
        invalidApiKey: "API key invalid or unauthorized - check Settings",
        recordingFailed: "Recording failed",
        permissionDenied: "Microphone permission denied",
        noMicrophone: "No microphone found",
        microphoneStartupTimeout: "Microphone startup timed out",
        microphoneBusy: "Microphone is busy",
        microphoneUnsupported: "Microphone settings not supported",
        checkMicrophone: "Please check your microphone settings",
        textInserted: "Text inserted",
        insertFailed: "Insertion failed — copy it from History",
        translateConsentTitle: "Send this clip to {provider}?",
        translateConsentHint:
          "Translation cannot run locally. Ordinary dictation stays on this device.",
        translateConsentAccept: "Upload & translate",
        translateConsentDecline: "Not now",
        translateConsentDeclined: "Not sent — nothing left this device.",
        insertFailedTitle: "Insertion failed",
        insertFailedHint: "Click Copy, then paste it yourself",
        copyButton: "Copy",
        copied: "Copied",
        copyFailed: "Copy failed. Try again; your text is still in History.",
      },
    },
    zh: {
      sidebar: {
        home: "首页",
        dictionary: "词典",
        history: "历史",
        settings: "设置",
        help: "帮助",
      },
      home: {
        ready: "随时可以听写",
        setupNeeded: "完成设置后即可开始",
        readyHint: "在任意应用中按住快捷键即可开始讲话",
        setupHint: "补齐下方缺失项后即可使用",
        dictate: "听写",
        english: "英文",
        readyBadge: "就绪",
        setupBadge: "待设置",
        recentTitle: "最近",
        viewAll: "查看全部",
        noActivity: "暂无最近活动",
        engineLabel: "转写引擎",
        engineLocalQwen: "Qwen",
        engineLocalQwenLarge: "Qwen 1.7B",
        engineCaptionLocalQwenLarge: "Qwen3-ASR 1.7B 本地运行 · 实验性 · 可在本机比较速度，准确率提升尚未实测",
        engineLocalNemotron: "Nemotron",
        engineRecommended: "推荐",
        engineExperimental: "\u5b9e\u9a8c\u6027",
        engineChecking: "\u68c0\u67e5\u4e2d\u2026",
        engineReadyLocal: "\u672c\u5730",
        engineReadyCloud: "\u4e91\u7aef",
        engineDownloading: "\u4e0b\u8f7d\u4e2d\u2026",
        engineDownloadProgress: "\u4e0b\u8f7d\u4e2d \u00b7 {percent}%",
        engineNeedsDownload: "\u9700\u8981\u4e0b\u8f7d",
        engineNeedsSetup: "\u9700\u8981\u914d\u7f6e",
        engineCaptionLocalQwen: "Qwen3-ASR 在本机运行，普通听写音频不离开这台电脑",
        engineCaptionLocalNemotron: "Nemotron 3.5 在本机运行并提供实时转写",
        engineCaptionGroq: "云端转写,使用你的 Groq key",
        engineCaptionOpenai: "云端转写,使用你的 OpenAI key",
      },
      readiness: {
        apiKey: "API 密钥",
        microphone: "麦克风",
        accessibility: "辅助功能",
        addApiKey: "添加 API 密钥",
        localModel: "本地模型",
        engine: "转写引擎",
        axGuide: {
          title: "开启辅助功能，完成最后一步",
          lead: "macOS 需要这项权限，SayType 才能做到这两件事：",
          useInsert: "把听写好的文字直接输入到你正在用的应用里",
          useHotkey: "在任意应用中响应“按住说话”快捷键",
          privacy:
            "SayType 不会记录你的按键、不会监控其他应用、也不会上传任何数据——这项权限只用于上面两件事。",
          open: "打开辅助功能设置",
          waiting: "等待授权中…",
          waitingHint: "在系统设置里打开 SayType 旁边的开关，授权后这里会自动继续。",
          retryHint: "还没检测到授权。请在辅助功能列表中打开 SayType，或再试一次。",
          revealApp: "在 Finder 中显示 SayType",
          revealHint: "列表里找不到 SayType？把它从 Finder 拖进列表即可（等同于点 +）。",
        },
      },
      onboarding: {
        start: "开始",
        next: "下一步",
        back: "上一步",
        skip: "先跳过",
        skipStep: "暂时跳过这一步",
        finish: "完成",
        resume: "继续设置向导",
        welcome: {
          title: "说话，就是打字",
          lead: "在任何应用里，按住快捷键开口说，松手，文字就出现在光标处。",
          holdTitle: "按住 {keys}",
          holdDesc: "在任意输入框里",
          speakTitle: "开口说话",
          speakDesc: "说完直接松手",
          insertTitle: "文字上屏",
          insertDesc: "自动输入到光标处",
        },
        privacy: {
          title: "本地听写，声音留在本机",
          lead: "使用本地模型，语音在这台电脑上转成文字，无需上传音频。",
          noAccount: "本地听写无需注册账号",
          offline: "模型下载一次，即可离线听写",
          line2: "历史记录只保存在这台电脑上",
        },
        mic: {
          title: "先让 SayType 听到你",
          lead: "只在你按住快捷键时录音，松手即停。",
          enable: "启用麦克风",
          enableHint: "系统会询问是否允许使用麦克风，允许后即可继续。",
          granted: "麦克风已就绪",
          denied: "麦克风被拒绝了。请在 系统设置 → 隐私与安全性 → 麦克风 里打开 SayType，授权后这里会自动继续。",
          unknown: "还没实际录过音",
          openSettings: "打开麦克风设置",
        },
        ax: {
          title: "让 SayType 为你输入文字",
          granted: "辅助功能已就绪",
        },
        key: {
          title: "连接你的转写服务",
          lead: "SayType 不内置额度——用你自己的 API key，数据和账单都归你自己。",
          leadCloudDefault: "这台电脑的内存或 CPU 核心较少，默认使用 OpenAI；也可以选择本地千问。",
          cloudDefault: "这台电脑默认使用云端，以免本地转写过慢。",
          localDescription: "在这台电脑上转写，无需注册账号。",
          localKind: "本地模型",
          cloudKind: "云端服务",
          cloudNotice: "听写录音将发送至 {provider} 转写，使用你自己的 API Key。",
          localSlow: "本地转写在这台电脑上可能很慢。",
          largeSlow: "实验性。需要更多内存，可能偏慢；准确率提升未实测。",
          largeComparison: "实验性。实测速度和内存对比见下方。",
          comparisonDownload: "下载大小",
          comparisonMemory: "内存峰值",
          comparisonTime: "30 秒录音转写",
          comparisonNote: "M4 / 24 GB 实测，仅转写耗时，不含模型加载及文字插入。准确率提升尚未实测。",
          more: "更多选项 ▸",
          moreHide: "收起更多选项 ▾",
          cloudSetup: "点击选择并配置 API 密钥。",
          keyLabel: "{provider} API 密钥",
          downloadProgress: "下载中 {percent}%",
          downloadMissing: "未下载",
          downloadReady: "就绪",
          downloadFailed: "下载失败——点击重试",
          otherDownloading: "另一个模型正在下载，请先在设置中完成或取消。",
          titleLocalFirst: "选择转写引擎",
          leadLocalFirst: "选择免费、离线的本地听写，或使用自己的 API Key 连接 OpenAI。",
          localNemotronName: "本地 · Nemotron 3.5 ASR",
          localQwenName: "本地 · Qwen3-ASR",
          localRecommendedTag: "推荐 · 免费 · 离线",
          localOfflineTag: "免费 · 离线",
          localAbsent: "一次性下载约 {total}——点击选择并下载。",
          localResume: "下载中断了——点击从断点继续。",
          localDownloading: "下载中… {done} / {total}。可以先继续后面的设置，稍后自动完成。",
          localReady: "已下载就绪——点击启用本地引擎。",
          localSelected: "已选中——普通听写在这台电脑上完成。",
          localError: "下载失败：{reason}点击重试。",
          cloudToggle: "或连接云端服务（Groq / OpenAI）▸",
          cloudToggleHide: "收起云端选项 ▾",
          groqTag: "自备密钥",
          groqDesc: "用你自己的 Groq key，额度以 Groq 为准。",
          openaiDesc: "使用你自己的 OpenAI API Key，按量付费。",
          placeholderGroq: "粘贴你的 Groq API key（gsk_…）",
          placeholderOpenai: "粘贴你的 OpenAI API key（sk-…）",
          save: "保存",
          saved: "已保存 ✓",
          getKeyGroq: "还没有 key？打开 console.groq.com 免费创建（约 1 分钟）。",
          getKeyOpenai: "还没有 key？打开 platform.openai.com 创建。",
          configured: "当前服务已配置过 key，可直接继续。",
          error: "保存失败：{message}",
        },
        try: {
          engineReady: "引擎就绪",
          micUnchecked: "麦克风尚未验证",
          historyHint: "文字没出现的话，历史记录里都有。",
          historyFallback: "已有结果保存，但这里还没出现文字。打开历史记录查看或复制。",
          success: "文字收到了！在其他应用中也可以这样使用快捷键。",
          title: "就绪！说你的第一句话",
          lead: "以后在任何应用里，都是同样的动作。",
          placeholder: "把光标放在这里，按住 {keys} 说：今天天气不错",
          hint: "按住 {keys} 说话 → 松手 → 文字出现在这里",
        },
        tryPending: {
          title: "还差一点",
          lead: "补齐下面几项就能用了；也可以先进入主界面，首页的就绪卡会随时提醒你。",
        },
      },
      update: {
        checkShort: "检查更新",
        checkingShort: "检查中…",
        downloadingShort: "下载 {version}",
        restartShort: "重启更新",
        readyTitle: "{version} 已下好，重启即可用上",
        cardTitle: "{version} 已经下好了",
        cardHint: "什么时候重启由你决定，它不会自己跳。",
        restart: "重启更新",
      },
      history: {
        title: "历史",
        subtitle: "你最近的转写记录",
        search: "搜索",
        clearAll: "清空",
        confirmClear: "再次点击以确认",
        empty: "暂无历史记录",
        noResults: "无匹配结果",
        today: "今天",
        yesterday: "昨天",
      },
      dictionary: {
        title: "词典",
        subtitle: "添加自定义词语和短语以提升转录准确率",
        label: "自定义词典提示：",
        placeholder:
          "输入自定义词语、短语或上下文以提高转录准确率。例如：'技术术语：API、JSON、OAuth、WebSocket'",
        save: "保存词典",
        saved: "已保存！",
        helpTitle: "如何使用词典",
        helpItem1: "添加技术术语、专有名词或领域相关词汇",
        helpItem2: "提供上下文或示例以提升识别效果",
        helpItem3: "使用清晰、具体的描述",
        helpItem4: "此内容将作为提示发送，以提升转录准确率",
        localNote:
          "本地引擎收不到词典——词典是作为 prompt 参数发出去的，只有云端 API 认。词条不会丢，换回 Groq 或 OpenAI 就继续生效。",
        punctuationTitle: "中文标点自动优化",
        punctuationDesc:
          "使用 Whisper 模型转录中文时，SayType 会在你的词典之后自动追加下面这句固定示例，让标点稳定输出。它不含任何隐私内容；GPT 系列模型和其它语言不会追加。",
        saveError: "保存词典出错：{message}",
      },
      activity: {
        retryErrors: {
          historyRead: "无法读取历史记录，请重试。",
          entryMissing: "这条历史记录已不存在。",
          notPending: "这条历史记录已不再等待重试。",
          audioMissing: "这条记录的录音已不可用。",
          audioRead: "无法读取录音，请重试。",
          settingsRead: "无法读取设置，请重试。",
          resultSave: "无法保存重试结果，请重试。",
          audioFormat: "本地引擎无法读取此录音格式，请在设置中切换到云端引擎后重试。",
          noSpeech: "未检测到语音",
          captureIncomplete: "录音采集不完整，已保留录音以便重试。",
        },
        copyTitle: "复制文本",
        deleteTitle: "删除",
        playTitle: "播放录音（调试）",
        pendingAudio: "转录卡住了 — 点击重试",
        pendingHint: "录音已保留 — 排除原因后可重新转录。",
        retranscribeTitle: "重新转录",
        retranscribeFailed: "重新转录失败 — 请再试一次",
        retranscribeFailedReason: "重新转录失败：{reason}",
      },
      settings: {
        title: "设置 - SayType",
        pageTitle: "设置",
        pageSubtitle: "设置会自动保存。点击勾选按钮启用引擎，点击名称查看配置。",
        tabsAria: "设置分类",
        modelSingleHint: "云端转写，按音频时长计费。",
        modelMultipleHint: "价格为美元。Groq 每次请求至少按 10 秒计费。",
        modelOpenaiPrice: "US$0.0045/分钟 · US$0.27/音频小时",
        modelOpenaiDetail: "高准确率多语言转写。这是 SayType 用于 OpenAI 听写的模型。",
        modelTurboPrice: "US$0.04/音频小时",
        modelTurboDetail: "日常听写推荐：更快、费用更低。Groq 官方基准词错误率为 12%。",
        modelV3Price: "US$0.111/音频小时 · 约 2.8 倍费用",
        modelV3Detail: "速度较慢，Groq 官方基准词错误率更低（10.3%）；实际准确率取决于你的音频。",
        advanced: "高级设置",
        section: {
          dictation: "听写设置",
          app: "应用设置",
          engines: "引擎与翻译",
        },
        recordingShortcut: {
          title: "录音快捷键",
          description:
            "选择你偏好的按住录音快捷键。翻译使用 Shift + Alt。",
          selectTitle: "选择录音快捷键",
        },
        accessibility: {
          title: "辅助功能权限",
          description: "用于全局快捷键和自动插入文本。",
          granted: "✅ 已授予辅助功能权限",
          notRequired: "✅ 此平台无需权限",
          denied: "❌ 辅助功能权限被拒绝",
          rechecking: "重新检查中...",
        },
        microphone: {
          title: "麦克风权限",
          description: "当前麦克风访问权限状态。",
        },
        permission: {
          checking: "检查中...",
          granted: "✅ 已授权",
          notDetermined: "尚未请求麦克风权限",
          denied: "❌ 已拒绝 — 请在系统设置中开启",
          restricted: "❌ 受系统策略限制",
          error: "❌ 检查权限出错",
        },
        checkPermission: "检查权限",
        uiLanguage: {
          title: "界面语言",
          description: "选择应用界面显示语言。",
          selectTitle: "选择界面语言",
          auto: "跟随系统",
          english: "English",
          chinese: "中文",
        },
        theme: {
          title: "主题风格",
          description: "浅色、深色，或跟随系统外观。",
          selectTitle: "选择界面主题",
          option: {
            auto: "跟随系统",
            midnight: "深色",
            elegant: "浅色",
          },
        },
        transcriptionLanguage: {
          title: "设置默认语言",
          description: "选择语音转录的默认语言。",
          auto: "自动检测",
          selectTitle: "选择转录默认语言",
          localNote:
            "千问自动识别语言，不使用此设置。",
          groupCommon: "常用",
          groupAll: "全部语言",
        },
        mergeSpelledLetters: {
          title: "自动合并拼读字母",
          description: "将连续、由空格分隔的大写字母合并，例如 A P I → API。保留标点和换行。",
        },
        autoLaunch: {
          title: "开机自启",
          description: "电脑启动时自动运行 SayType。",
          aria: "开机自启",
        },
        startMinimized: {
          title: "启动时最小化",
          description: "开机自启时隐藏主窗口并在后台运行。",
          aria: "启动时最小化",
        },
        updates: {
          title: "软件更新",
          description: "新版本会在后台自动下载,由你决定何时重启生效。",
          check: "检查更新",
          restart: "重启并更新",
          checking: "正在检查…",
          downloading: "正在下载 v{version}…",
          ready: "v{version} 已就绪 — 重启即可更新",
          upToDate: "v{version} — 已是最新",
          error: "检查更新失败:{message}",
        },
        diagnostics: {
          title: "\u8bca\u65ad\u65e5\u5fd7",
          description: "\u67e5\u770b\u5e76\u590d\u5236\u7528\u4e8e\u6392\u67e5\u6027\u80fd\u95ee\u9898\u7684\u672c\u673a\u65e5\u5fd7\u3002",
          refresh: "\u5237\u65b0",
          copy: "\u590d\u5236\u5168\u90e8",
          contentAria: "\u8bca\u65ad\u65e5\u5fd7\u5185\u5bb9",
          loading: "\u6b63\u5728\u52a0\u8f7d\u65e5\u5fd7\u2026",
          empty: "\u76ee\u524d\u6ca1\u6709\u53ef\u7528\u7684\u8bca\u65ad\u65e5\u5fd7\u3002",
          loaded: "{size} \u00b7 \u66f4\u65b0\u4e8e {time}",
          truncated: "\u4ec5\u663e\u793a\u6700\u65b0 {size} \u00b7 \u66f4\u65b0\u4e8e {time}",
          loadError: "\u65e0\u6cd5\u8bfb\u53d6\u65e5\u5fd7\uff1a{message}",
          copied: "\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f",
          copyError: "\u65e0\u6cd5\u590d\u5236\u65e5\u5fd7\uff1a{message}",
        },
        apiProvider: {
          title: "转写服务",
          description: "选择云端服务或本地引擎。",
          selectTitle: "选择转写服务",
          localQwenLarge: "本地 · Qwen3-ASR 1.7B · 实验性",
          localNemotron: "本地 · Nemotron 3.5 ASR",
          localQwen: "本地 · Qwen3-ASR · ★ 推荐",
        },
        nemotronLatency: {
          title: "Nemotron 前瞻延迟",
          description: "这是模型前瞻时间；总响应时间还包含录音与处理耗时。",
          selectTitle: "选择 Nemotron 延迟",
          balanced: "较低延迟 · 0.56 秒",
          accuracy: "较高准确率 · 1.12 秒",
        },
        engine: {
          active: "正在使用",
          activeModel: "正在使用 · {model}",
          whisperLarge: "Whisper Large V3",
          whisperTurbo: "Whisper Large V3 Turbo",
          gptTranscribe: "GPT Transcribe",
          use: "使用 {model}",
          switching: "正在切换…",
          switchFailed: "引擎未更改。",
          invalidModel: "请选择可用的模型。",
          keyRequired: "使用此模型前，请先填写 API 密钥。",
          cloudNotice: "使用此云端模型会将听写录音上传至对应服务商。",
          recommended: "推荐",
          experimental: "实验",
          localQwenLarge: {
            name: "Qwen3-ASR 1.7B",
            description: "实验性：下载约 2.5 GB，在 M4 / 24 GB 上测得进程内存峰值约 2.9 GB。30 秒录音转写耗时 2.07 秒，0.6B 为 0.96 秒（均不含模型加载）。准确率提升尚未实测。",
          },
          localQwen: {
            name: "Qwen3-ASR 0.6B",
            description: "在这台电脑上解码，音频不离开设备。中文标点打得好。",
          },
          groq: {
            name: "Groq",
            description: "最快的云端 Whisper。音频会上传到 Groq。",
          },
          openai: {
            name: "OpenAI",
            description: "云端里标点最好的一档（gpt-transcribe）。音频会上传到 OpenAI。",
          },
          localNemotron: {
            name: "Nemotron 3.5 ASR",
            description: "边说边出字，但识别准确率明显低于 Qwen。",
          },
          status: {
            ready: "已就绪",
            downloading: "下载中",
            needsDownload: "需下载",
            needsKey: "待填密钥",
            keySet: "密钥已存",
            local: "本机运行",
          },
        },
        apiKey: {
          title: "API 密钥",
          description: "仅保存在本机，默认隐藏显示。",
          groqPlaceholder: "Groq API 密钥",
          openaiPlaceholder: "OpenAI API 密钥",
          reveal: "显示密钥",
          hide: "隐藏密钥",
        },
        translateCloud: {
          title: "云端翻译（可选）",
          description:
            "本地听写无需 API 密钥。只有需要用 Shift + Alt 翻译成英文时，才需展开配置。",
          uploadNote:
            "翻译会将录音上传至所选云端服务商，普通听写仍在本机完成。",
          selectTitle: "选择翻译使用的服务商",
        },
        model: {
          title: "模型",
          description: "选择转录模型。",
          selectTitle: "选择转录模型",
          recommendedTag: "★ 推荐",
          options: {
            gptTranscribe: "GPT Transcribe — $0.0045/分钟 ($0.27/小时)",
            whisperLargeV3:
              "Whisper Large V3（标准） — $0.00185/分钟 ($0.111/小时)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo（更快） — $0.000667/分钟 ($0.04/小时)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B（本地）— 免费、离线",
            nemotron35Local: "Nemotron 3.5 ASR 0.6B（实时）— 免费、离线",
          },
        },
        localModel: {
          title: "本地模型",
          statusAbsent: "未下载 — 磁盘占用约 {total}，一次性下载。",
          statusPartial: "下载中断 — 可从断点继续。",
          statusDownloading: "下载中… {done} / {total}",
          statusReady: "已就绪 · 磁盘占用 {size}",
          statusUnsupported: "Nemotron 在当前平台不可用。",
          download: "下载模型",
          resume: "继续下载",
          cancel: "取消下载",
          delete: "删除模型",
          deleteConfirm: "删除本地模型？再次使用需重新下载约 1 GB。",
          deletePartial: "删除未完成的下载",
          deletePartialConfirm: "删除未完成的下载文件、释放磁盘空间？随时可以重新开始下载。",
          notReady: "请先下载本地模型，再保存设置。",
          downloadFailed: "模型下载失败：{reason}",
          switchPrompt: "本地模型已就绪。现在切换到本地转写引擎吗？",
        },
        localCompute: {
          title: "显卡加速",
          selectTitle: "选择本地引擎运行的后端",
          auto: "自动（当前为 CPU）",
          cpu: "CPU",
          gpu: "显卡（Vulkan）",
          statusCpu:
            "当前用 CPU 运行。独立显卡通常更快；核显（Intel HD／UHD）实测比 CPU 慢约一倍，装了也建议留在 CPU。",
          statusAbsent: "需要一次性下载 {total} 的 Vulkan 运行时。",
          statusDownloading: "正在下载显卡运行时… {done} / {total}",
          statusReady: "正在使用 {device}。",
          statusNoDevice: "显卡运行时已安装，但没有找到可用的 Vulkan 设备，仍在用 CPU 运行。更新显卡驱动可能可以解决。",
          statusFellBack: "本次运行显卡启动失败，转写已回退到 CPU。重启 SayType 可以再试一次。",
          download: "下载显卡运行时",
          retry: "重新下载",
          cancel: "取消下载",
          delete: "删除显卡运行时",
          deleteConfirm: "删除显卡运行时并改回 CPU？模型会保留，只删除 33 MB 的运行时。",
          downloadFailed: "显卡运行时下载失败：{reason}",
        },
        saved: "已保存",
        saveError: "没能保存——刚才那次改动没生效。",
        permissions: {
          allGranted: "系统权限齐了",
          allGrantedDetail: "麦克风、辅助功能都已授权——录音和自动插入文字都能用。",
          recheck: "重新检查",
          checked: "已检查，所有权限正常。",
          needsAttention: "已检查，部分权限需要处理，请查看下方设置。",
          checkFailed: "未能完成权限检查，请重试。",
        },
        dictionaryLink: {
          title: "词典",
          description: "常说的专有名词和术语，发给云端引擎，让它照你的写法出字。",
          open: "编辑词典",
        },
        about: {
          title: "关于",
          reveal: "在 Finder 中显示",
        },
      },
      axCloud: {
        hint: "把我拖进列表",
        close: "关闭",
      },
      microphoneAccess: {
        unknown: "麦克风尚未检查",
        granted: "麦克风可用",
        denied: "无法访问麦克风",
        unavailable: "未找到麦克风",
        error: "麦克风检查失败，请重试",
        check: "检查麦克风",
        checking: "正在检查麦克风…",
        deniedHint: "请在 Windows 设置中允许桌面应用访问麦克风，然后返回重新检查。",
        settingsFailed: "无法打开 Windows 麦克风设置，请手动前往“隐私和安全性 → 麦克风”。",
      },
      inputPrompt: {
        title: "语音输入",
        hint: "按住 {record} 进行听写，{translate} 翻译成英文",
        starting: "正在开始录音...",
        listening: "正在聆听...",
        listeningEnglish: "正在聆听（英文输出）...",
        recording: "录音中",
        cancelled: "已取消",
        processing: "处理中...",
        transcribing: "正在转录音频...",
        recordingWithDuration: "录音中 {duration}",
        transcribingCount: "转写中（{count}）",
        inserting: "正在插入...",
        insertingCount: "正在插入（{count}）",
        statusSeparator: " · ",
        noAudio: "未捕获到音频",
        noSpeech: "未检测到语音",
        transcriptionFailed: "转录失败，请重试",
        transcriptionFailedReason: "转录失败：{reason}",
        transcriptionHungSaved: "转录卡住了 — 已存到历史，可重试",
        recordingInterrupted: "\u5f55\u97f3\u5df2\u4e2d\u65ad",
        transcriptionIncompleteTitle: "\u8f6c\u5f55\u672a\u5b8c\u6210",
        transcriptionIncompleteHint: "\u5df2\u4fdd\u7559\u90e8\u5206\u6587\u5b57\uff0c\u53ef\u5728\u8fd9\u91cc\u590d\u5236\u3002",
        recoverySavedHint: "\u5df2\u4fdd\u5b58\u5230\u5386\u53f2\u8bb0\u5f55\uff0c\u53ef\u5728\u8fd9\u91cc\u590d\u5236\u6216\u7ee7\u7eed\u542c\u5199\u3002",
        localModelMissingTitle: "本地模型还没下载好",
        localModelMissing: "下载完成后即可开始听写。",
        openLocalModel: "打开模型设置",
        noApiKeyTitle: "需要 API Key",
        noApiKey: "请先在设置中填写 API Key",
        invalidApiKey: "API Key 无效或未授权，请检查设置",
        recordingFailed: "录音失败",
        permissionDenied: "麦克风权限被拒绝",
        noMicrophone: "未发现麦克风",
        microphoneStartupTimeout: "\u9ea6\u514b\u98ce\u542f\u52a8\u8d85\u65f6",
        microphoneBusy: "麦克风正被占用",
        microphoneUnsupported: "麦克风设置不受支持",
        checkMicrophone: "请检查麦克风设置",
        textInserted: "文本已插入",
        insertFailed: "插入失败，可在历史记录中复制",
        translateConsentTitle: "把这段发给 {provider}？",
        translateConsentHint: "翻译跑不了本地。平时的听写不出这台电脑。",
        translateConsentAccept: "上传并翻译",
        translateConsentDecline: "这次不用",
        translateConsentDeclined: "没有发出去，音频留在本机。",
        insertFailedTitle: "插入失败",
        insertFailedHint: "点「复制」，自己粘贴一下",
        copyButton: "复制",
        copied: "已复制",
        copyFailed: "复制失败，请重试；文字仍保存在历史记录中。",
      },
    },
  };

  const fallbackLanguage = "en";
  let currentLanguage = fallbackLanguage;

  function getNestedValue(source, key) {
    if (!source || typeof key !== "string") {
      return undefined;
    }
    return key.split(".").reduce((acc, part) => {
      if (!acc || typeof acc !== "object") {
        return undefined;
      }
      return acc[part];
    }, source);
  }

  function formatTemplate(value, vars = {}) {
    if (typeof value !== "string") {
      return value;
    }
    return value.replace(/\{(\w+)\}/g, (match, key) => {
      const replacement = vars[key];
      return replacement === undefined || replacement === null
        ? match
        : String(replacement);
    });
  }

  function detectSystemLanguage() {
    const lang = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    if (lang && lang.toLowerCase().startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function resolveLanguage(value) {
    if (!value || typeof value !== "string" || value === "auto") {
      return detectSystemLanguage();
    }
    const normalized = value.toLowerCase();
    if (normalized.startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function setLanguage(value) {
    currentLanguage = resolveLanguage(value);
    setDocumentLanguage(currentLanguage);
    return currentLanguage;
  }

  function getLanguage() {
    return currentLanguage;
  }

  function t(key, vars) {
    const langPack = translations[currentLanguage] || translations[fallbackLanguage];
    const fallbackPack = translations[fallbackLanguage];
    const value =
      getNestedValue(langPack, key) ?? getNestedValue(fallbackPack, key) ?? key;
    return formatTemplate(value, vars);
  }

  function applyI18n(root = document) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      if (!key) {
        return;
      }
      const value = t(key);
      const attr = element.getAttribute("data-i18n-attr");
      if (attr) {
        attr
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .forEach((name) => {
            element.setAttribute(name, value);
          });
      } else {
        element.textContent = value;
      }
    });
  }

  function setDocumentLanguage(lang) {
    if (!document || !document.documentElement) {
      return;
    }
    const htmlLang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.setAttribute("lang", htmlLang);
  }

  function initI18n(preferredLanguage) {
    const resolved = setLanguage(preferredLanguage);
    applyI18n(document);
    return resolved;
  }

  function getLocale() {
    return currentLanguage === "zh" ? "zh-CN" : "en-US";
  }

  // Persistent History text/error codes: keep translations for retired codes.
  // Renaming a code requires a data migration, not just editing this lookup.
  function localizeRetryError(reason) {
    const keys = {
      RETRY_HISTORY_READ: "historyRead",
      RETRY_ENTRY_MISSING: "entryMissing",
      RETRY_NOT_PENDING: "notPending",
      RETRY_AUDIO_MISSING: "audioMissing",
      RETRY_AUDIO_READ: "audioRead",
      RETRY_SETTINGS_READ: "settingsRead",
      RETRY_RESULT_SAVE: "resultSave",
      RETRY_AUDIO_FORMAT: "audioFormat",
      RETRY_NO_SPEECH: "noSpeech",
      RETRY_CAPTURE_INCOMPLETE: "captureIncomplete",
    };
    const key = Object.hasOwn(keys, reason) ? keys[reason] : null;
    return key ? t(`activity.retryErrors.${key}`) : reason;
  }

  window.SayTypeI18n = {
    localizeRetryError,
    initI18n,
    setLanguage,
    getLanguage,
    resolveLanguage,
    applyI18n,
    t,
    getLocale,
  };

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-i18n-ready", "1");
  }
})();
