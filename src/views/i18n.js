(() => {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-i18n-ran", "1");
  }

  const translations = {
    en: {
      app: {
        plan: {
          basic: "Basic",
        },
      },
      sidebar: {
        home: "Home",
        dictionary: "Dictionary",
        notes: "Notes",
        settings: "Settings",
        addTeam: "Add your team",
        referFriend: "Refer a friend",
        help: "Help",
      },
      upgrade: {
        title: "Upgrade to pro",
        description: "Upgrade for unlimited dictation and other pro features",
        learnMore: "Learn more",
      },
      home: {
        featureTitle: "Voice dictation in any app",
        recordHint: "Hold down {shortcut} and speak into any textbox.",
        translateHint: "Hold down {shortcut} to translate spoken text to English.",
        explore: "Explore use cases",
        recentActivity: "Recent activity",
        recentHeader: "RECENT",
        noActivity: "No recent activity",
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
        saveError: "Error saving dictionary: {message}",
      },
      activity: {
        copyTitle: "Copy text",
      },
      settings: {
        title: "Settings - SayType",
        sidebarTitle: "Settings",
        section: {
          general: "General",
          models: "Models",
        },
        recordingShortcut: {
          title: "Recording shortcut",
          description:
            "Choose your preferred hold-to-record shortcut. Translation stays Shift + Alt.",
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
          description: "Choose the visual style of the app.",
          selectTitle: "Select interface theme",
          option: {
            midnight: "Midnight",
            elegant: "Elegant",
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
        keepMicWarm: {
          title: "Keep microphone warm",
          description:
            "After a recording, keep the mic ready for a few seconds so the next one starts instantly. The mic indicator stays on briefly.",
          aria: "Keep microphone warm",
        },
        apiProvider: {
          title: "API Provider",
          description: "Choose transcription API service.",
          selectTitle: "Select API provider",
        },
        apiKey: {
          title: "API Key",
          description: "Enter your API key for selected provider.",
          groqPlaceholder: "Groq API key",
          openaiPlaceholder: "OpenAI API key",
        },
        model: {
          title: "Model Selection",
          description: "Select transcription model.",
          selectTitle: "Select transcription model",
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
          },
        },
        cancel: "Cancel",
        save: "Save",
        saveError: "Failed to save settings. Please try again.",
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
        textInsertedAuto: "Text inserted automatically",
        textInsertedPartial:
          "Text inserted automatically (clipboard may be partially restored)",
        textCopied: "Text copied - Press {shortcut} to paste",
        textProcessingFailed: "Text processing failed - trying clipboard fallback",
        textCopiedFallback: "Text copied to clipboard - Press {shortcut} to paste",
        errorCouldNotProcess: "Error: Could not process text",
      },
    },
    zh: {
      app: {
        plan: {
          basic: "基础版",
        },
      },
      sidebar: {
        home: "首页",
        dictionary: "词典",
        notes: "笔记",
        settings: "设置",
        addTeam: "添加团队",
        referFriend: "推荐好友",
        help: "帮助",
      },
      upgrade: {
        title: "升级到专业版",
        description: "升级后可享不限量听写等专业功能",
        learnMore: "了解更多",
      },
      home: {
        featureTitle: "在任何应用中语音听写",
        recordHint: "按住 {shortcut} 并对任意文本框讲话。",
        translateHint: "按住 {shortcut} 将语音翻译成英文。",
        explore: "探索使用场景",
        recentActivity: "最近活动",
        recentHeader: "最近",
        noActivity: "暂无最近活动",
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
        saveError: "保存词典出错：{message}",
      },
      activity: {
        copyTitle: "复制文本",
      },
      settings: {
        title: "设置 - SayType",
        sidebarTitle: "设置",
        section: {
          general: "常规",
          models: "模型",
        },
        recordingShortcut: {
          title: "录音快捷键",
          description:
            "选择你偏好的按住录音快捷键。翻译快捷键保持为 Shift + Alt。",
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
          description: "选择应用界面的视觉风格。",
          selectTitle: "选择界面主题",
          option: {
            midnight: "午夜",
            elegant: "雅致",
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
        keepMicWarm: {
          title: "保持麦克风热启动",
          description: "录音结束后让麦克风再保持几秒,下次按下立即开始、避免开头丢字。其间麦克风指示灯会短暂亮着。",
          aria: "保持麦克风热启动",
        },
        apiProvider: {
          title: "API 服务商",
          description: "选择转录 API 服务。",
          selectTitle: "选择 API 服务商",
        },
        apiKey: {
          title: "API 密钥",
          description: "请输入所选服务商的 API 密钥。",
          groqPlaceholder: "Groq API 密钥",
          openaiPlaceholder: "OpenAI API 密钥",
        },
        model: {
          title: "模型选择",
          description: "选择转录模型。",
          selectTitle: "选择转录模型",
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
          },
        },
        cancel: "取消",
        save: "保存",
        saveError: "保存设置失败，请重试。",
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
        textInsertedAuto: "文本已自动插入",
        textInsertedPartial: "文本已自动插入（剪贴板可能仅部分恢复）",
        textCopied: "文本已复制 - 按 {shortcut} 粘贴",
        textProcessingFailed: "文本处理失败，正在尝试剪贴板回退",
        textCopiedFallback: "文本已复制到剪贴板 - 按 {shortcut} 粘贴",
        errorCouldNotProcess: "错误：无法处理文本",
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
