import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  GoogleGenerativeAI,
  Content,
  FunctionDeclaration,
  FunctionCallingMode,
} from '@google/generative-ai';
import { McpService } from '../mcp/mcp.service';
import { GeminiKeyService } from '../rag/services/gemini-key.service';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: { result: string } };
  }>;
}

export interface GeminiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgenticLoopResult {
  text: string;
  media?: unknown[];
}

export type AgenticStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'media'; media: unknown };

/**
 * Represents the detected intent of a user's message.
 * - `quran_recitation` — user requests audio for an identified Quranic passage
 * - `prayer_time`      — user asks for salah/namaz/prayer times
 * - `hijri_calendar`   — user asks about Hijri dates, Ramadan, Eid, or Islamic calendar
 * - `greeting`         — greetings, introductions, "how are you", "what can you do"
 * - `off_topic`        — questions with zero plausible Islamic angle (weather, code, sports scores…)
 * - `general`          — any Islamic question incl. borderline ones; also the safe fallback on error
 */
export type MessageIntent =
  | 'quran_recitation'
  | 'prayer_time'
  | 'hijri_calendar'
  | 'greeting'
  | 'off_topic'
  | 'general';

/** The supported language codes — mirrors the codes in the main system prompt. */
export type SupportedLanguage = 'ar' | 'bn' | 'en' | 'es' | 'fr' | 'id' | 'ru' | 'tr' | 'zh';

/**
 * The structured result returned by `classifyIntent()`.
 * Both fields are always present; `language` defaults to `'en'` on any parse failure.
 */
export interface IntentResult {
  intent: MessageIntent;
  language: SupportedLanguage;
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
}

/**
 * Sanitizes Gemini model text output by stripping internal thinking artifacts
 * (`tool_code` blocks, `thought` monologues, Python print statements, etc.).
 */
export function sanitizeModelOutput(text: string): string {
  if (!text) return '';
  let cleaned = text;

  // 1. Fenced tool_code / python blocks
  cleaned = cleaned.replace(/```(?:tool_code|python)?[\s\S]*?```/gi, '');

  // 2. Un-fenced tool_code blocks & lines
  cleaned = cleaned.replace(/(?:^|\n)tool_code\s*\n\s*print\(default_api[\s\S]*?(?=\bthought\b|\n[A-Z\u00C0-\u024F\u0980-\u09FF\u0600-\u06FF\u0400-\u04FF]|$)/gi, '');
  cleaned = cleaned.replace(/(?:^|\n)tool_code\s*\n[^\n]*/gi, '');

  // 3. Thought monologue: if text starts with thought, strip thought lines & internal monologues
  if (/^\s*(?:tool_code\s*\n)*thought\b/i.test(cleaned)) {
    // Remove "thought" keyword
    cleaned = cleaned.replace(/^\s*(?:tool_code\s*\n)*thought\s*\n?/i, '');

    // Strip internal monologue sentences until the answer transition
    cleaned = cleaned.replace(
      /^[\s\S]*?\b(?:Indonesian|Bengali|Arabic|Turkish|English|Spanish|French|Russian|Chinese|language)\.\s*/i,
      '',
    );

    // If double newline separates thought from answer
    cleaned = cleaned.replace(/^(?:The user|I need|I also|After getting|I will|I must|Let's|First|Next|I should)[\s\S]*?\n\n/gi, '');
  }

  // Cleanup leftover header lines
  cleaned = cleaned.replace(/^\s*(?:tool_code|thought)\s*\n?/gi, '');

  return cleaned.trim();
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly chatModel: string;
  private readonly ttsModel: string;
  private readonly embeddingModel: string;
  private readonly intentModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpService: McpService,
    private readonly geminiKeyService: GeminiKeyService,
  ) {
    this.chatModel = this.configService.get<string>('gemini.chatModel') ?? 'gemini-2.5-flash';
    this.ttsModel =
      this.configService.get<string>('gemini.ttsModel') ?? 'gemini-2.5-flash-preview-tts';
    this.embeddingModel =
      this.configService.get<string>('gemini.embeddingModel') ?? 'gemini-embedding-001';
    this.intentModel =
      this.configService.get<string>('gemini.intentModel') ?? 'gemini-2.5-flash';
  }

  /** Fetch next available key from DB; fall back to .env */
  private async nextKey(): Promise<{ id: string | null; apiKey: string }> {
    try {
      const row = await this.geminiKeyService.getNextKey();
      if (row) return row;
    } catch (error) {
      this.logger.warn(`Unable to read DB Gemini key — falling back to .env GEMINI_API_KEY: ${(error as Error).message}`);
    }

    const envKey = this.configService.get<string>('gemini.apiKey');
    if (envKey) {
      this.logger.warn('All DB keys exhausted — falling back to .env GEMINI_API_KEY');
      return { id: null, apiKey: envKey };
    }
    throw new HttpException('No Gemini API keys available', HttpStatus.SERVICE_UNAVAILABLE);
  }

  private isRateLimitError(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota');
  }

  /**
   * Classifies the intent of a user message using the main Gemini model (`gemini-2.5-flash`).
   * Using the full model ensures robust multilingual understanding — lightweight models
   * were found to misclassify greetings and identity questions in non-English languages.
   *
   * Returns an `IntentResult` with:
   *   - `intent`   — one of 6 labels (see `MessageIntent`)
   *   - `language` — ISO-639-1 code of the detected message language (one of the 9 supported codes)
   *
   * On any error (network, rate-limit, parse failure) it logs a warning and returns
   * `{ intent: 'general', language: 'en' }` so the main chat path is never blocked.
   */
  async classifyIntent(message: string): Promise<IntentResult> {
    const VALID_INTENTS: MessageIntent[] = [
      'quran_recitation',
      'prayer_time',
      'hijri_calendar',
      'greeting',
      'off_topic',
      'general',
    ];
    const VALID_LANGUAGES: SupportedLanguage[] = ['ar', 'bn', 'en', 'es', 'fr', 'id', 'ru', 'tr', 'zh'];
    const FALLBACK: IntentResult = { intent: 'general', language: 'en' };

    const systemPrompt = [
      'You are an intent classification engine for an Islamic assistant chatbot called Noor AI.',
      'Given the user message, return a JSON object with two fields: "intent" and "language".',
      '',
      'INTENT — choose exactly one:',
      '  - quran_recitation : ONLY when the user asks to play, hear, or recite an identified Quranic passage (tilawah/qirat/قراءة).',
      '                       A target may be a Surah, Ayah/range, named verse such as Ayatul Kursi,',
      '                       or a recognizable Quranic dua title/phrase. Do not require the words "Surah" or "Ayah".',
      '                       Examples: "Play Surah Yasin", "Recite Ayatul Kursi", or "Play the dua of Yunus".',
      '                       Reciter recommendations, supported-reciter questions, or listening/memorization preferences',
      '                       without a specific passage are general, even if they mention hearing Quran often.',
      '                       A generic request to play Quran without identifying a passage is general.',
      '  - prayer_time      : user asks for salah, namaz, or prayer times in any language',
      '  - hijri_calendar   : user asks about Hijri dates, Ramadan, Eid, Shawwal, Dhul Hijjah, or calendar conversion',
      '  - greeting         : ONLY pure social greetings and simple opener questions.',
      '                       INCLUDES: hello, hi, hey, salam, السلام عليكم, আস্সালামু আলাইকুম,',
      '                       merhaba, bonjour, hola, привет, 你好, and equivalents in any language.',
      '                       INCLUDES: "who are you?", "what is your name?", "introduce yourself",',
      '                       "how are you?", "how are you doing?", "what\'s up?", small talk.',
      '                       Bengali: "তুমি কে?", "কেমন আছেন?", "আপনার নাম কি?"',
      '                       Arabic: "من أنت؟", "ما اسمك؟", "كيف حالك؟"',
      '                       DOES NOT include questions needing a real answer:',
      '                       "where does your knowledge come from?", "what are your limitations?",',
      '                       "how do you work?", "what can you NOT do?", "are you accurate?",',
      '                       "কোথা থেকে তোমার জ্ঞান আসে?", "তুমি কী কী পারো না?" — these are general.',
      '  - off_topic        : question has ZERO plausible Islamic angle — e.g. "What is 2+2?",',
      '                       "Write Python code", "Who won the football match?", "What is the weather?",',
      '                       "Tell me a joke", "Write a movie script"',
      '  - general          : EVERYTHING ELSE — including:',
      '                       • Any question with a plausible Islamic dimension (afterlife, Jannah, ethics, history)',
      '                       • Questions about Noor AI that need a real answer beyond a simple intro:',
      '                         "where does your knowledge come from?", "what are your limitations?",',
      '                         "how do you work?", "what is your knowledge source?", "can you make mistakes?",',
      '                         "are you always accurate?", "what topics can you help with?"',
      '                       • "ki kora jai ekhane?", "what can I ask you?", capability deep-dives',
      '                       • Reciter availability or recommendation questions without a requested passage are general.',
      '                       • ANY borderline case — when in doubt, use general.',
      '',
      'LANGUAGE — detect the language the user wrote in and map it to one of:',
      '  ar (Arabic), bn (Bengali), en (English), es (Spanish), fr (French),',
      '  id (Indonesian/Malay), ru (Russian), tr (Turkish), zh (Chinese).',
      '  If it does not match any, use "en".',
      '',
      'Rules:',
      '  • Return ONLY: { "intent": "<label>", "language": "<code>" }',
      '  • No explanation, no markdown, no extra keys.',
    ].join('\n');

    const totalKeys = (await this.geminiKeyService.getStats()).total || 1;

    for (let attempt = 0; attempt < totalKeys + 1; attempt++) {
      let id: string | null = null;
      try {
        const key = await this.nextKey();
        id = key.id;

        const model = new GoogleGenerativeAI(key.apiKey).getGenerativeModel({
          model: this.intentModel,
          systemInstruction: systemPrompt,
          generationConfig: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseMimeType: 'application/json' as any,
            responseSchema: {
              type: 'object' as any,
              properties: {
                intent: {
                  type: 'string' as any,
                  enum: VALID_INTENTS,
                },
                language: {
                  type: 'string' as any,
                  enum: VALID_LANGUAGES,
                },
              },
              required: ['intent', 'language'],
            } as any,
            temperature: 0,
          },
        });

        const result = await model.generateContent(message);
        const raw = result.response.text().trim();
        const parsed = JSON.parse(raw) as { intent?: string; language?: string };

        const intent = (VALID_INTENTS as string[]).includes(parsed?.intent ?? '')
          ? (parsed.intent as MessageIntent)
          : null;
        const language = (VALID_LANGUAGES as string[]).includes(parsed?.language ?? '')
          ? (parsed.language as SupportedLanguage)
          : 'en';

        if (!intent) {
          this.logger.warn(`classifyIntent: unexpected intent "${String(parsed?.intent)}" — falling back to general`);
          return { intent: 'general', language };
        }

        return { intent, language };
      } catch (err) {
        if (this.isRateLimitError(err) && id) {
          this.logger.warn(`Intent key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
          continue;
        }
        this.logger.warn(`classifyIntent failed: ${(err as Error).message} — falling back to general`);
        return FALLBACK;
      }
    }

    this.logger.warn('classifyIntent: all keys exhausted — falling back to general');
    return FALLBACK;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const totalKeys = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < totalKeys + 1; attempt++) {
      const { id, apiKey } = await this.nextKey();

      try {
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: this.embeddingModel,
        });
        const result = await model.embedContent({
          content: { parts: [{ text }], role: 'user' },
          outputDimensionality: 768,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return result.embedding.values;
      } catch (err) {
        lastError = err as Error;
        if (this.isRateLimitError(err) && id) {
          this.logger.warn(`Embedding key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    this.logger.error(`Embedding generation failed: ${lastError.message}`);
    throw new HttpException('Embedding service unavailable', HttpStatus.SERVICE_UNAVAILABLE);
  }

  async generateSpeech(text: string): Promise<Buffer> {
    const totalKeys = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < totalKeys + 1; attempt++) {
      const { id, apiKey } = await this.nextKey();

      try {
        return await this.generateSpeechWithKey(text, apiKey);
      } catch (err) {
        lastError = err as Error;
        if (this.isRateLimitError(err) && id) {
          this.logger.warn(`TTS key ${id.slice(0, 8)}... rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    this.logger.error(`Speech generation failed: ${lastError.message}`);
    throw new HttpException('Speech service unavailable', HttpStatus.BAD_GATEWAY);
  }

  private async generateSpeechWithKey(text: string, apiKey: string): Promise<Buffer> {
    const isBengali = /[\u0980-\u09FF]/.test(text);
    const voiceName = isBengali ? 'Kore' : 'Puck';
    const languageInstruction = isBengali
      ? 'Read aloud in a warm, natural Bangladeshi Bengali voice. Do not read Markdown symbols or formatting.'
      : 'Read aloud in a clear, natural English voice. Do not read Markdown symbols or formatting.';

    const response = await axios.post<GeminiTtsResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.ttsModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        contents: [
          {
            parts: [
              {
                text: `${languageInstruction}\n\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );

    const inlineData = response.data.candidates?.[0]?.content?.parts?.find(
      (part) => part.inlineData?.data,
    )?.inlineData;

    if (!inlineData?.data) {
      throw new Error('Gemini TTS response did not include audio data');
    }

    const audioBuffer = Buffer.from(inlineData.data, 'base64');
    if (inlineData.mimeType?.includes('wav')) return audioBuffer;

    return this.wrapPcmInWav(audioBuffer);
  }

  private wrapPcmInWav(
    pcmBuffer: Buffer,
    sampleRate = 24000,
    channels = 1,
    bitsPerSample = 16,
  ): Buffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  async runAgenticLoop(
    systemPrompt: string,
    history: GeminiMessage[],
    tools: GeminiTool[],
  ): Promise<AgenticLoopResult> {
    const totalKeys = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < totalKeys + 1; attempt++) {
      const { id, apiKey } = await this.nextKey();
      try {
        return await this.runLoopWithKey(systemPrompt, history, tools, apiKey);
      } catch (err) {
        lastError = err as Error;
        if (this.isRateLimitError(err) && id) {
          this.logger.warn(`Chat key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    this.logger.error(`Agentic loop failed: ${lastError.message}`);
    throw new HttpException('Chat service unavailable', HttpStatus.BAD_GATEWAY);
  }

  private async runLoopWithKey(
    systemPrompt: string,
    history: GeminiMessage[],
    tools: GeminiTool[],
    apiKey: string,
  ): Promise<AgenticLoopResult> {
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })) as unknown as FunctionDeclaration[];

    const modelOptions: any = {
      model: this.chatModel,
      systemInstruction: systemPrompt,
    };

    if (functionDeclarations.length > 0) {
      modelOptions.tools = [{ functionDeclarations }];
      modelOptions.toolConfig = { functionCallingConfig: { mode: FunctionCallingMode.AUTO } };
    }

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel(modelOptions);

    // Exclude the last user message from history — it will be sent via sendMessage
    const sdkHistory: Content[] = history.slice(0, -1).map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => {
        if (p.functionCall) return { functionCall: p.functionCall };
        if (p.functionResponse)
          return {
            functionResponse: {
              name: p.functionResponse.name,
              response: p.functionResponse.response,
            },
          };
        return { text: p.text ?? '' };
      }),
    }));

    const chatSession = model.startChat({ history: sdkHistory });
    const maxIterations = 10;

    // Send only the current (last) user message
    const lastUserMessage = history[history.length - 1];
    const userText = lastUserMessage?.parts.find((p) => p.text)?.text ?? '';
    let result = await chatSession.sendMessage(userText);
    const media: unknown[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      const functionCallParts = parts.filter((p) => 'functionCall' in p && p.functionCall);

      if (functionCallParts.length === 0) {
        return { text: sanitizeModelOutput(result.response.text()), media: media.length ? media : undefined };
      }

      const responses = await Promise.all(
        functionCallParts.map(async (part) => {
          const { name, args } = part.functionCall!;
          this.logger.log(`Tool call: ${name}(${JSON.stringify(args)})`);
          const toolResult = await this.mcpService.executeTool(
            name,
            args as Record<string, string>,
          );
          this.logger.log(`Tool result [${name}]: ${JSON.stringify(toolResult)}`);
          const toolMedia = this.extractToolMedia(toolResult);
          return { name, toolResult, toolMedia };
        }),
      );

      for (const res of responses) {
        if (res.toolMedia) {
          media.push(res.toolMedia);
        }
      }

      result = await chatSession.sendMessage(
        responses.map((res) => ({
          functionResponse: {
            name: res.name,
            response: { result: JSON.stringify(res.toolResult) },
          },
        })),
      );
    }

    return { text: sanitizeModelOutput(result.response.text()), media: media.length ? media : undefined };
  }

  async *runAgenticLoopStream(
    systemPrompt: string,
    history: GeminiMessage[],
    tools: GeminiTool[],
  ): AsyncGenerator<AgenticStreamEvent> {
    const totalKeys = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < totalKeys + 1; attempt++) {
      const { id, apiKey } = await this.nextKey();
      try {
        yield* this.runStreamWithKey(systemPrompt, history, tools, apiKey);
        return;
      } catch (err) {
        lastError = err as Error;
        if (this.isRateLimitError(err) && id) {
          this.logger.warn(`Stream key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    this.logger.error(`Agentic loop stream failed: ${lastError.message}`);
    throw new HttpException('Chat service unavailable', HttpStatus.BAD_GATEWAY);
  }

  private async *runStreamWithKey(
    systemPrompt: string,
    history: GeminiMessage[],
    tools: GeminiTool[],
    apiKey: string,
  ): AsyncGenerator<AgenticStreamEvent> {
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })) as unknown as FunctionDeclaration[];

    const modelOptions: any = {
      model: this.chatModel,
      systemInstruction: systemPrompt,
    };

    if (functionDeclarations.length > 0) {
      modelOptions.tools = [{ functionDeclarations }];
      modelOptions.toolConfig = { functionCallingConfig: { mode: FunctionCallingMode.AUTO } };
    }

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel(modelOptions);

    const sdkHistory: Content[] = history.slice(0, -1).map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => {
        if (p.functionCall) return { functionCall: p.functionCall };
        if (p.functionResponse)
          return {
            functionResponse: {
              name: p.functionResponse.name,
              response: p.functionResponse.response,
            },
          };
        return { text: p.text ?? '' };
      }),
    }));

    const chatSession = model.startChat({ history: sdkHistory });
    const maxIterations = 10;
    const lastUserMessage = history[history.length - 1];
    const userText = lastUserMessage?.parts.find((p) => p.text)?.text ?? '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pendingMessage: any = userText;

    for (let i = 0; i < maxIterations; i++) {
      const streamResult = await chatSession.sendMessageStream(pendingMessage);

      let isFunctionCallTurn = false;
      let turnTextBuffer = '';
      const turnChunks: string[] = [];

      for await (const chunk of streamResult.stream) {
        const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
        if (
          chunkParts.some(
            (p) =>
              ('functionCall' in p && p.functionCall) ||
              (p as { thought?: boolean }).thought === true,
          )
        ) {
          isFunctionCallTurn = true;
          break;
        }
        const text = chunk.text();
        if (text) {
          turnTextBuffer += text;
          turnChunks.push(text);
        }
      }

      if (!isFunctionCallTurn) {
        if (!turnTextBuffer) {
          try {
            const response = await streamResult.response;
            const text = response.text();
            if (text) turnTextBuffer = text;
          } catch {
            // Ignore response fetch error if stream was empty
          }
        }

        let inThinkingHeader = true;
        let accumulatedHeaderBuffer = '';

        for (const rawChunk of turnChunks) {
          if (!inThinkingHeader) {
            yield { type: 'chunk', text: rawChunk };
            continue;
          }

          accumulatedHeaderBuffer += rawChunk;
          const cleaned = sanitizeModelOutput(accumulatedHeaderBuffer);
          if (cleaned) {
            yield { type: 'chunk', text: cleaned };
            inThinkingHeader = false;
          }
        }

        if (turnChunks.length === 0 && turnTextBuffer) {
          const cleaned = sanitizeModelOutput(turnTextBuffer);
          if (cleaned) {
            yield { type: 'chunk', text: cleaned };
          }
        }

        return; // Text turn fully processed and streamed
      }

      // Resolve full response to get complete function call args
      const response = await streamResult.response;
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const functionCallParts = parts.filter((p) => 'functionCall' in p && p.functionCall);
      if (functionCallParts.length === 0) return;

      const responses = await Promise.all(
        functionCallParts.map(async (part) => {
          const { name, args } = part.functionCall!;
          this.logger.log(`Tool call: ${name}(${JSON.stringify(args)})`);
          const toolResult = await this.mcpService.executeTool(
            name,
            args as Record<string, string>,
          );
          this.logger.log(`Tool result [${name}]: ${JSON.stringify(toolResult)}`);
          const toolMedia = this.extractToolMedia(toolResult);
          return { name, toolResult, toolMedia };
        }),
      );

      for (const res of responses) {
        if (res.toolMedia) {
          yield { type: 'media', media: res.toolMedia };
        }
      }

      pendingMessage = responses.map((res) => ({
        functionResponse: {
          name: res.name,
          response: { result: JSON.stringify(res.toolResult) },
        },
      }));
    }

    throw new Error('Max tool iterations reached');
  }

  private extractToolMedia(toolResult: unknown): unknown | null {
    if (
      toolResult &&
      typeof toolResult === 'object' &&
      'media' in toolResult &&
      (toolResult as { media?: unknown }).media
    ) {
      return (toolResult as { media: unknown }).media;
    }

    return null;
  }
}
