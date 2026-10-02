import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ChatMedia, ChatService, QuranRecitationMedia, StreamChunk } from '../chat/chat.service';
import { GeminiKeyService } from '../rag/services/gemini-key.service';
import { RagService } from '../rag/rag.service';
import { GeminiService, MessageIntent } from '../gemini/gemini.service';
import { McpService } from '../mcp/mcp.service';
import { QURAN_AUDIO_RECITER } from '../mcp/quran-audio.constants';

interface ExpectedMedia {
  surahNumber: number;
  startAyah?: number;
  endAyah?: number;
}

interface RecitationCase {
  name: string;
  question: string;
  expectedIntent: MessageIntent;
  expectedMedia?: ExpectedMedia;
  expectedReciter?: string;
  expectClarification?: boolean;
}

interface ToolCallRecord {
  caseName: string;
  toolName: string;
  input: Record<string, string>;
}

interface CaseResult {
  reply: string;
  media?: ChatMedia;
  errors: string[];
}

const CASES: RecitationCase[] = [
  {
    name: 'reciter recommendation without a passage',
    question: 'Recommend a reciter I can listen to regularly and memorize with',
    expectedIntent: 'general',
    expectedReciter: QURAN_AUDIO_RECITER.name,
  },
  {
    name: 'Surah Yasin audio',
    question: 'Play Surah Yasin',
    expectedIntent: 'quran_recitation',
    expectedMedia: { surahNumber: 36 },
  },
  {
    name: 'Ayatul Kursi audio',
    question: 'Recite Ayatul Kursi',
    expectedIntent: 'quran_recitation',
    expectedMedia: { surahNumber: 2, startAyah: 255, endAyah: 255 },
  },
  {
    name: 'named Quranic dua audio',
    question: "Play the Quranic dua 'Rabbana atina fid-dunya hasanah'",
    expectedIntent: 'quran_recitation',
    expectedMedia: { surahNumber: 2, startAyah: 201, endAyah: 201 },
  },
  {
    name: 'generic recitation request needs clarification',
    question: 'Can you recite Quran for me?',
    expectedIntent: 'general',
    expectClarification: true,
  },
];

function mediaFromResult(media?: ChatMedia): QuranRecitationMedia | undefined {
  return media?.type === 'quran_recitation' ? media : undefined;
}

function assertCaseResult(
  testCase: RecitationCase,
  observedIntent: MessageIntent | undefined,
  result: CaseResult,
  toolCalls: ToolCallRecord[],
): void {
  assert.equal(
    observedIntent,
    testCase.expectedIntent,
    `expected intent ${testCase.expectedIntent}, received ${String(observedIntent)}`,
  );
  assert.deepEqual(result.errors, [], `stream returned errors: ${result.errors.join('; ')}`);

  const recitationMedia = mediaFromResult(result.media);
  const recitationCalls = toolCalls.filter((call) => call.toolName === 'get_quran_recitation');

  if (testCase.expectedMedia) {
    assert.ok(recitationMedia, 'expected Quran recitation media');
    assert.equal(recitationMedia.surahNumber, testCase.expectedMedia.surahNumber);
    assert.equal(recitationMedia.reciterName, QURAN_AUDIO_RECITER.name);
    assert.ok(recitationMedia.audioUrl, 'expected an audio URL');
    if (testCase.expectedMedia.startAyah !== undefined) {
      assert.equal(recitationMedia.startAyah, testCase.expectedMedia.startAyah);
    }
    if (testCase.expectedMedia.endAyah !== undefined) {
      assert.equal(recitationMedia.endAyah, testCase.expectedMedia.endAyah);
    }
    assert.equal(recitationCalls.length, 1, 'expected exactly one recitation tool call');
  }

  if (testCase.expectedReciter) {
    assert.match(result.reply, new RegExp(testCase.expectedReciter, 'i'));
    assert.equal(recitationMedia, undefined, 'reciter recommendation must not emit audio media');
    assert.equal(toolCalls.length, 0, 'reciter availability question must not call MCP tools');
  }

  if (testCase.expectClarification) {
    assert.equal(recitationMedia, undefined, 'generic request must not emit audio media');
    assert.doesNotMatch(result.reply, /could not find that surah/i);
    assert.match(result.reply, /which|what|specify|tell me|would you like/i);
    assert.match(result.reply, /surah|ayah|verse|passage|quran/i);
    for (const call of recitationCalls) {
      assert.ok(!call.input.surahName && !call.input.surahNumber, 'clarification tool call must not invent a passage');
    }
  }
}

async function collectChatStream(chatService: ChatService, userId: string, question: string): Promise<CaseResult> {
  const result: CaseResult = { reply: '', errors: [] };

  for await (const event of chatService.chatStream(userId, question)) {
    const chunk: StreamChunk = event;
    if (chunk.type === 'chunk') result.reply += chunk.text;
    if (chunk.type === 'media') result.media = chunk.media;
    if (chunk.type === 'error') result.errors.push(chunk.message);
    if (chunk.type === 'done' && chunk.media) result.media = chunk.media;
  }

  return result;
}

async function main(): Promise<void> {
  const originalRagOnModuleInit = RagService.prototype.onModuleInit;
  const originalKeyOnModuleInit = GeminiKeyService.prototype.onModuleInit;
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;

  // Avoid AppModule's startup DDL; this runner uses existing Quran data and only needs reads.
  RagService.prototype.onModuleInit = async () => undefined;
  GeminiKeyService.prototype.onModuleInit = async () => undefined;

  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  } finally {
    RagService.prototype.onModuleInit = originalRagOnModuleInit;
    GeminiKeyService.prototype.onModuleInit = originalKeyOnModuleInit;
  }

  if (!app) throw new Error('Nest application context was not created');

  const failures: string[] = [];

  try {
    const chatService = app.get(ChatService);
    const geminiService = app.get(GeminiService);
    const mcpService = app.get(McpService);
    const ragService = app.get(RagService);
    const geminiKeyService = app.get(GeminiKeyService);

    // Use the local GEMINI_API_KEY fallback and avoid DB key-status/last-used writes.
    geminiKeyService.getNextKey = async () => null;
    geminiKeyService.getStats = async () => ({ total: 0, active: 0, rateLimited: 0 });
    geminiKeyService.markRateLimited = async () => undefined;

    // Prevent cache hits and writes so each question exercises the live chat path without persistence.
    ragService.searchSimilar = async () => null;
    ragService.saveToCache = async () => undefined;

    const intents = new Map<string, MessageIntent>();
    const originalClassifyIntent = geminiService.classifyIntent.bind(geminiService);
    geminiService.classifyIntent = async (question: string) => {
      const result = await originalClassifyIntent(question);
      intents.set(question, result.intent);
      return result;
    };

    const toolCalls: ToolCallRecord[] = [];
    let activeCaseName = '';
    const originalExecuteTool = mcpService.executeTool.bind(mcpService);
    mcpService.executeTool = async (toolName, input) => {
      toolCalls.push({ caseName: activeCaseName, toolName, input: { ...input } });
      return originalExecuteTool(toolName, input);
    };

    let caseFailures = 0;
    for (const testCase of CASES) {
      activeCaseName = testCase.name;
      const callsBefore = toolCalls.length;
      try {
        const userId = `quran-recitation-smoke-${Date.now()}-${caseFailures}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await collectChatStream(chatService, userId, testCase.question);
        const caseToolCalls = toolCalls.slice(callsBefore);
        assertCaseResult(testCase, intents.get(testCase.question), result, caseToolCalls);
        console.log(`PASS ${testCase.name}`);
        console.log(`  question: ${testCase.question}`);
        console.log(`  reply: ${result.reply.replace(/\s+/g, ' ').slice(0, 220)}`);
        if (result.media?.type === 'quran_recitation') {
          console.log(`  media: Surah ${result.media.surahNumber}, reciter ${result.media.reciterName}`);
        }
      } catch (error) {
        caseFailures++;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${testCase.name}: ${message}`);
        console.error(`FAIL ${testCase.name}: ${message}`);
      }
    }

    if (failures.length > 0) {
      console.error(`\n${failures.length} of ${CASES.length} recitation smoke cases failed.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nAll ${CASES.length} Quran recitation smoke cases passed.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Quran recitation smoke test could not complete:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
