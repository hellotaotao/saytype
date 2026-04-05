const OpenAI = require("openai");
const fs = require("fs");

class OpenAITranscriptionService {
  constructor(apiKey) {
    this.client = new OpenAI({ 
      apiKey,
      dangerouslyAllowBrowser: false,
      baseURL: 'https://api.openai.com/v1'
    });
  }

  async transcribe(tempFile, options = {}) {
    const {
      model = 'whisper-1',
      language = 'auto',
      prompt = '',
      translateMode = false,
      signal
    } = options;

    if (translateMode) {
      // OpenAI translations API currently supports only whisper-1
      const translationOptions = {
        file: fs.createReadStream(tempFile),
        model: 'whisper-1',
        response_format: 'text',
      };
      
      const translationResponse = await this.client.audio.translations.create(translationOptions, { signal });
      return typeof translationResponse === 'string' ? { text: translationResponse } : translationResponse;
    } else {
      // OpenAI transcriptions - support multiple models now
      const transcriptionOptions = {
        file: fs.createReadStream(tempFile),
        model: model, // Use the selected model (whisper-1, gpt-4o-transcribe, etc.)
        response_format: 'text',
      };
      
      if (language !== 'auto') transcriptionOptions.language = language;
      if (prompt.trim()) transcriptionOptions.prompt = prompt;
      
      const transcription = await this.client.audio.transcriptions.create(transcriptionOptions, { signal });
      return typeof transcription === 'string' ? { text: transcription } : transcription;
    }
  }

  static getSupportedModels() {
    return [
      'whisper-1',
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe'
    ];
  }
}

module.exports = OpenAITranscriptionService;
