import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly chatModel: string;
  private readonly embeddingModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpService: McpService,
    private readonly geminiKeyService: GeminiKeyService,
  ) {
    this.chatModel = this.configService.get<string>('gemini.chatModel') ?? 'gemini-2.5-flash';
    this.embeddingModel =
      this.configService.get<string>('gemini.embeddingModel') ?? 'gemini-embedding-001';
  }

  /** Fetch next available key from DB; fall back to .env */
  private async nextKey(): Promise<{ id: string | null; apiKey: string }> {
    const row = await this.geminiKeyService.getNextKey();
    if (row) return row;
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

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: this.chatModel,
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
    });

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
      const functionCallPart = parts.find((p) => 'functionCall' in p && p.functionCall);

      if (!functionCallPart?.functionCall) {
        return { text: result.response.text(), media: media.length ? media : undefined };
      }

      const { name, args } = functionCallPart.functionCall;
      this.logger.log(`Tool call: ${name}(${JSON.stringify(args)})`);

      const toolResult = await this.mcpService.executeTool(
        name,
        args as Record<string, string>,
      );
      this.logger.log(`Tool result [${name}]: ${JSON.stringify(toolResult)}`);
      const toolMedia = this.extractToolMedia(toolResult);
      if (toolMedia) media.push(toolMedia);

      result = await chatSession.sendMessage([
        {
          functionResponse: {
            name,
            response: { result: JSON.stringify(toolResult) },
          },
        },
      ]);
    }

    return { text: result.response.text(), media: media.length ? media : undefined };
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

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: this.chatModel,
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
    });

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

      // Iterate stream chunks immediately — yield text as it arrives (true streaming).
      // If a function-call chunk is detected, break and handle it synchronously.
      let isFunctionCallTurn = false;
      for await (const chunk of streamResult.stream) {
        const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
        if (chunkParts.some((p) => 'functionCall' in p && p.functionCall)) {
          isFunctionCallTurn = true;
          break;
        }
        const text = chunk.text();
        if (text) yield { type: 'chunk', text };
      }

      if (!isFunctionCallTurn) {
        return; // Text turn fully streamed
      }

      // Resolve full response to get complete function call args
      const response = await streamResult.response;
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const funcCallPart = parts.find((p) => 'functionCall' in p && p.functionCall);
      if (!funcCallPart?.functionCall) return;

      const { name, args } = funcCallPart.functionCall;
      this.logger.log(`Tool call: ${name}(${JSON.stringify(args)})`);

      const toolResult = await this.mcpService.executeTool(
        name,
        args as Record<string, string>,
      );
      this.logger.log(`Tool result [${name}]: ${JSON.stringify(toolResult)}`);
      const toolMedia = this.extractToolMedia(toolResult);
      if (toolMedia) yield { type: 'media', media: toolMedia };

      pendingMessage = [
        { functionResponse: { name, response: { result: JSON.stringify(toolResult) } } },
      ];
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
