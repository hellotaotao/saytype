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
        engineLocal: "Local",
        engineRecommended: "Recommended",
        engineCaptionLocal: "Runs on this Mac — audio never leaves it",
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
          title: "Your voice goes only where you point it",
          lead: "SayType has no servers of its own — and doesn't want your data.",
          nodeMac: "This Mac",
          nodeMacDesc: "local model · recording · history",
          arrow: "cloud mode only — direct, with your own key",
          nodeCloud: "Groq / OpenAI",
          nodeCloudDesc: "your own account",
          lineLocal: "With the local model, audio never leaves this Mac",
          line1: "Cloud mode sends audio straight to the service you pick — nothing in between",
          line2: "History is stored only on this Mac",
        },
        mic: {
          title: "Let SayType hear you",
          lead: "It records only while you hold the shortcut — release, and it stops.",
          enable: "Enable microphone",
          enableHint: "macOS will ask for confirmation — click Allow.",
          granted: "Microphone ready",
          denied:
            "Microphone access was denied. Turn on SayType under System Settings → Privacy & Security → Microphone — this page continues automatically.",
          openSettings: "Open Microphone Settings",
        },
        ax: {
          title: "Let it type for you",
          granted: "Accessibility ready",
        },
        key: {
          title: "Connect your transcription service",
          lead: "SayType ships no built-in quota — you use your own API key, so your data and billing stay yours.",
          titleLocalFirst: "Choose your transcription engine",
          leadLocalFirst:
            "Transcribe right on this Mac — free, offline, no account. Or connect a cloud service with your own key.",
          localName: "Local · Qwen3",
          localTag: "Recommended · free · offline",
          localAbsent: "Runs entirely on this Mac. One-time {total} download — click to start.",
          localResume: "Download interrupted — click to resume where it left off.",
          localDownloading: "Downloading… {done} / {total}. You can keep going and finish setup later.",
          localReady: "Downloaded and ready — click to use the local engine.",
          localSelected: "Local engine selected — dictation runs entirely on this Mac.",
          localError: "Download failed: {reason} Click to retry.",
          cloudToggle: "Or connect a cloud service (Groq / OpenAI) ▸",
          cloudToggleHide: "Hide cloud options ▾",
          groqTag: "Recommended · free",
          groqDesc: "The free tier is so generous that for most people daily dictation is simply free",
          openaiDesc: "gpt-4o-transcribe / whisper-1, pay as you go",
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
          title: "Ready! Say your first sentence",
          lead: "It works the same way in every app from now on.",
          placeholder: "Put the cursor here, hold {keys} and say: nice weather today",
          hint: "Hold {keys} and speak → release → the text lands here",
          tip: "Bonus: hold {keys} and speak Chinese — it comes out in English.",
        },
        tryPending: {
          title: "Almost there",
          lead: "Finish the items below and you're set — or head into the app; the readiness card on Home will keep track.",
        },
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
        punctuationTitle: "Automatic punctuation for Chinese",
        punctuationDesc:
          "When transcribing Chinese with a Whisper model, SayType automatically appends the fixed example below after your dictionary so punctuation comes out reliably. It contains no personal data, and is not added for gpt-4o models or other languages.",
        saveError: "Error saving dictionary: {message}",
      },
      activity: {
        copyTitle: "Copy text",
        deleteTitle: "Delete",
        playTitle: "Play recording (debug)",
        pendingAudio: "Transcription stalled — tap to retry",
        retranscribeTitle: "Re-transcribe",
        retranscribeFailed: "Re-transcribe failed — try again",
      },
      settings: {
        title: "Settings - SayType",
        pageTitle: "Settings",
        pageSubtitle: "Voice input, transcription, and app preferences",
        tabsAria: "Settings sections",
        section: {
          voiceInput: "Voice Input",
          transcription: "Transcription",
          app: "App",
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
          auto: "Auto (System)",
          english: "English",
          chinese: "中文 (简体)",
        },
        theme: {
          title: "Theme",
          description: "Light, dark, or follow your system.",
          selectTitle: "Select interface theme",
          option: {
            auto: "Auto (match system)",
            midnight: "Dark",
            elegant: "Light",
          },
        },
        transcriptionLanguage: {
          title: "Set default language",
          description: "Choose the default language for voice transcription.",
          auto: "Auto-detect",
          selectTitle: "Select default language for transcription",
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
          title: "API Provider",
          description: "Choose transcription API service.",
          selectTitle: "Select API provider",
        },
        apiKey: {
          title: "API Key",
          description: "Stored locally on this device. Shown hidden by default.",
          groqPlaceholder: "Groq API key",
          openaiPlaceholder: "OpenAI API key",
          reveal: "Show key",
          hide: "Hide key",
        },
        model: {
          title: "Model Selection",
          description: "Select transcription model.",
          selectTitle: "Select transcription model",
          recommendedTag: "★ Recommended",
          options: {
            whisper1: "Whisper-1 (Classic) — $0.006/min ($0.36/hr)",
            gpt4oTranscribe:
              "GPT-4o Transcribe (High Quality) — $0.006/min ($0.36/hr)",
            gpt4oMiniTranscribe:
              "GPT-4o Mini Transcribe (Fast) — $0.003/min ($0.18/hr)",
            gpt4oTranscribeDiarize:
              "GPT-4o Transcribe (Diarize) — $0.006/min ($0.36/hr)",
            whisperLargeV3:
              "Whisper Large V3 (Standard) — $0.00185/min ($0.111/hr)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo (Faster) — $0.000667/min ($0.04/hr)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B (on-device) — free, offline",
          },
        },
        localModel: {
          title: "Local model",
          statusAbsent: "Not downloaded — about {total} on disk, one-time download.",
          statusPartial: "Download interrupted — resume where it left off.",
          statusDownloading: "Downloading… {done} / {total}",
          statusReady: "Ready · {size} on disk",
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
        discard: "Discard changes",
        discardConfirm: "Discard your unsaved settings changes?",
        save: "Save",
        saved: "Saved",
        unsaved: "Unsaved changes",
        saveError: "Failed to save settings. Please try again.",
      },
      axCloud: {
        hint: "Drag me into the list",
        close: "Close",
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
        noApiKeyTitle: "API key required",
        noApiKey: "Add your API key in Settings first",
        invalidApiKey: "API key invalid or unauthorized - check Settings",
        recordingFailed: "Recording failed",
        permissionDenied: "Microphone permission denied",
        noMicrophone: "No microphone found",
        microphoneBusy: "Microphone is busy",
        microphoneUnsupported: "Microphone settings not supported",
        checkMicrophone: "Please check your microphone settings",
        textInserted: "Text inserted",
        insertFailed: "Insertion failed — copy it from History",
        insertFailedTitle: "Insertion failed",
        insertFailedHint: "Click Copy, then paste it yourself",
        copyButton: "Copy",
        copied: "Copied",
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
        engineLocal: "本地",
        engineRecommended: "推荐",
        engineCaptionLocal: "在本机运行,音频不离开这台 Mac",
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
          title: "你的声音，只去你指定的地方",
          lead: "SayType 没有自己的服务器，也不想要你的数据。",
          nodeMac: "这台 Mac",
          nodeMacDesc: "本地模型 · 录音 · 历史记录",
          arrow: "仅云端模式——用你自己的 key 直连",
          nodeCloud: "Groq / OpenAI",
          nodeCloudDesc: "你自己的账户",
          lineLocal: "使用本地模型时，音频不会离开这台 Mac",
          line1: "云端模式下，录音直接发给你选定的服务，中间没有任何中转",
          line2: "历史记录只保存在这台 Mac 上",
        },
        mic: {
          title: "先让 SayType 听到你",
          lead: "只在你按住快捷键时录音，松手即停。",
          enable: "启用麦克风",
          enableHint: "点击后 macOS 会弹出确认，允许即可。",
          granted: "麦克风已就绪",
          denied: "麦克风被拒绝了。请在 系统设置 → 隐私与安全性 → 麦克风 里打开 SayType，授权后这里会自动继续。",
          openSettings: "打开麦克风设置",
        },
        ax: {
          title: "让文字替你打出来",
          granted: "辅助功能已就绪",
        },
        key: {
          title: "连接你的转写服务",
          lead: "SayType 不内置额度——用你自己的 API key，数据和账单都归你自己。",
          titleLocalFirst: "选择转写引擎",
          leadLocalFirst: "直接在这台 Mac 上转写——免费、离线、无需注册账号；也可以用自己的 key 连接云端服务。",
          localName: "本地 · Qwen3",
          localTag: "推荐 · 免费 · 离线",
          localAbsent: "完全在这台 Mac 上运行。一次性下载 {total}——点击开始。",
          localResume: "下载中断了——点击从断点继续。",
          localDownloading: "下载中… {done} / {total}。可以先继续后面的设置，稍后自动完成。",
          localReady: "已下载就绪——点击启用本地引擎。",
          localSelected: "已选择本地引擎——听写全程在这台 Mac 上完成。",
          localError: "下载失败：{reason}点击重试。",
          cloudToggle: "或连接云端服务（Groq / OpenAI）▸",
          cloudToggleHide: "收起云端选项 ▾",
          groqTag: "推荐 · 免费",
          groqDesc: "免费额度非常宽松，日常听写对绝大多数人来说等于免费随便用",
          openaiDesc: "gpt-4o-transcribe / whisper-1，按量付费",
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
          title: "就绪！说你的第一句话",
          lead: "以后在任何应用里，都是同样的动作。",
          placeholder: "把光标放在这里，按住 {keys} 说：今天天气不错",
          hint: "按住 {keys} 说话 → 松手 → 文字出现在这里",
          tip: "进阶：按住 {keys} 说中文，出来的是英文。",
        },
        tryPending: {
          title: "还差一点",
          lead: "补齐下面几项就能用了；也可以先进入主界面，首页的就绪卡会随时提醒你。",
        },
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
        punctuationTitle: "中文标点自动优化",
        punctuationDesc:
          "使用 Whisper 模型转录中文时，SayType 会在你的词典之后自动追加下面这句固定示例，让标点稳定输出。它不含任何隐私内容；gpt-4o 模型和其它语言不会追加。",
        saveError: "保存词典出错：{message}",
      },
      activity: {
        copyTitle: "复制文本",
        deleteTitle: "删除",
        playTitle: "播放录音（调试）",
        pendingAudio: "转录卡住了 — 点击重试",
        retranscribeTitle: "重新转录",
        retranscribeFailed: "重新转录失败 — 请再试一次",
      },
      settings: {
        title: "设置 - SayType",
        pageTitle: "设置",
        pageSubtitle: "语音输入、转写和应用偏好",
        tabsAria: "设置分类",
        section: {
          voiceInput: "语音输入",
          transcription: "转写",
          app: "应用",
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
          auto: "自动（系统）",
          english: "English",
          chinese: "中文（简体）",
        },
        theme: {
          title: "主题风格",
          description: "浅色、深色，或跟随系统外观。",
          selectTitle: "选择界面主题",
          option: {
            auto: "自动（跟随系统外观）",
            midnight: "深色",
            elegant: "浅色",
          },
        },
        transcriptionLanguage: {
          title: "设置默认语言",
          description: "选择语音转录的默认语言。",
          auto: "自动检测",
          selectTitle: "选择转录默认语言",
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
          title: "API 服务商",
          description: "选择转录 API 服务。",
          selectTitle: "选择 API 服务商",
        },
        apiKey: {
          title: "API 密钥",
          description: "仅保存在本机，默认隐藏显示。",
          groqPlaceholder: "Groq API 密钥",
          openaiPlaceholder: "OpenAI API 密钥",
          reveal: "显示密钥",
          hide: "隐藏密钥",
        },
        model: {
          title: "模型选择",
          description: "选择转录模型。",
          selectTitle: "选择转录模型",
          recommendedTag: "★ 推荐",
          options: {
            whisper1: "Whisper-1（经典） — $0.006/分钟 ($0.36/小时)",
            gpt4oTranscribe:
              "GPT-4o 转录（高质量） — $0.006/分钟 ($0.36/小时)",
            gpt4oMiniTranscribe:
              "GPT-4o Mini 转录（快速） — $0.003/分钟 ($0.18/小时)",
            gpt4oTranscribeDiarize:
              "GPT-4o 转录（说话人分离） — $0.006/分钟 ($0.36/小时)",
            whisperLargeV3:
              "Whisper Large V3（标准） — $0.00185/分钟 ($0.111/小时)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo（更快） — $0.000667/分钟 ($0.04/小时)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B（本地）— 免费、离线",
          },
        },
        localModel: {
          title: "本地模型",
          statusAbsent: "未下载 — 磁盘占用约 {total}，一次性下载。",
          statusPartial: "下载中断 — 可从断点继续。",
          statusDownloading: "下载中… {done} / {total}",
          statusReady: "已就绪 · 磁盘占用 {size}",
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
        discard: "放弃更改",
        discardConfirm: "要放弃尚未保存的设置更改吗？",
        save: "保存",
        saved: "已保存",
        unsaved: "有未保存的更改",
        saveError: "保存设置失败，请重试。",
      },
      axCloud: {
        hint: "把我拖进列表",
        close: "关闭",
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
        noApiKeyTitle: "需要 API Key",
        noApiKey: "请先在设置中填写 API Key",
        invalidApiKey: "API Key 无效或未授权，请检查设置",
        recordingFailed: "录音失败",
        permissionDenied: "麦克风权限被拒绝",
        noMicrophone: "未发现麦克风",
        microphoneBusy: "麦克风正被占用",
        microphoneUnsupported: "麦克风设置不受支持",
        checkMicrophone: "请检查麦克风设置",
        textInserted: "文本已插入",
        insertFailed: "插入失败，可在历史记录中复制",
        insertFailedTitle: "插入失败",
        insertFailedHint: "点「复制」，自己粘贴一下",
        copyButton: "复制",
        copied: "已复制",
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

  window.SayTypeI18n = {
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
