const GroqTranscriptionService = require('./groq-transcription');
const OpenAITranscriptionService = require('./openai-transcription');
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const os = require("os");

const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

class TranscriptionService {
  constructor(provider, apiKey) {
    this.provider = provider;
    
    switch (provider) {
      case 'groq':
        this.service = new GroqTranscriptionService(apiKey);
        break;
      case 'openai':
        this.service = new OpenAITranscriptionService(apiKey);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async transcribeAudio(audioBuffer, options = {}) {
    const {
      model,
      language = 'auto',
      prompt = '',
      translateMode = false,
      mimeType = 'audio/webm', // Default format
      signal
    } = options;

    // Determine file extension based on actual audio format
    let fileExtension = '.webm'; // Default
    if (mimeType.includes('mp4')) {
      fileExtension = '.m4a';
    } else if (mimeType.includes('webm')) {
      fileExtension = '.webm';
    } else if (mimeType.includes('wav')) {
      fileExtension = '.wav';
    }

    // Guard against excessively large recordings
    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      throw new Error(`Audio too large: ${audioBuffer.length} bytes (max ${MAX_AUDIO_SIZE_BYTES})`);
    }

    // Save audio buffer to temporary file with correct extension
    const tempFile = path.join(os.tmpdir(), `audio_${Date.now()}${fileExtension}`);
    await fsPromises.writeFile(tempFile, audioBuffer);

    try {
      // Determine the actual model to use
      const actualModel = translateMode 
        ? (this.provider === 'openai' ? 'whisper-1' : 'whisper-large-v3')
        : model;

      console.log(`🎙️  Provider: ${this.provider} | Using model: ${actualModel} | Language: ${language} | Translate mode: ${translateMode}`);

      // Call the appropriate service
      const result = await this.service.transcribe(tempFile, {
        model: actualModel,
        language,
        prompt,
        translateMode,
        signal
      });

      console.log(`✅ ${translateMode ? 'Translation' : 'Transcription'} completed: "${result.text}"`);
      
      return result.text;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        console.warn('Failed to cleanup temp file:', error);
      }
    }
  }

  static getSupportedModels(provider) {
    switch (provider) {
      case 'groq':
        return GroqTranscriptionService.getSupportedModels();
      case 'openai':
        return OpenAITranscriptionService.getSupportedModels();
      default:
        return [];
    }
  }

  static getSupportedProviders() {
    return ['groq', 'openai'];
  }
}

module.exports = TranscriptionService;
