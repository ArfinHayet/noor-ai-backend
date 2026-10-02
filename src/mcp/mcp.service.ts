import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import {
  RagService,
  HadithSearchResult,
  QuranSurahRaw,
  QuranSurahSearchResult,
} from '../rag/rag.service';
import { GeminiKeyService } from '../rag/services/gemini-key.service';
import { QURAN_AUDIO_RECITER } from './quran-audio.constants';

interface PrayerTimesResponse {
  data: {
    timings: Record<string, string>;
  };
}

interface AladhanDate {
  date: string;
  format: string;
  day: string;
  weekday: {
    en: string;
    ar: string;
  };
  month: {
    number: number;
    en: string;
    ar: string;
  };
  year: string;
  designation: {
    abbreviated: string;
    expanded: string;
  };
  holidays?: string[];
}

interface AladhanDatePair {
  readable: string;
  timestamp: string;
  gregorian: AladhanDate;
  hijri: AladhanDate;
}

interface HijriCalendarResponse {
  data: AladhanDatePair | AladhanDatePair[];
}

interface HijriCalendarResult {
  source: string;
  note: string;
  today?: AladhanDatePair;
  gregorianToHijri?: AladhanDatePair;
  hijriToGregorian?: AladhanDatePair;
  hijriMonthCalendar?: Array<{
    gregorian: AladhanDate;
    hijri: AladhanDate;
  }>;
  eidDates?: {
    hijriYear: string;
    eidAlFitr: AladhanDatePair;
    eidAlAdha: AladhanDatePair;
  };
}

interface QuranResult {
  reference: string;
  arabicName: string;
  text_ar: string;
  translation: string;
  tafsir?: string;
}

interface HadithResult {
  reference: string;
  narrator: string | null;
  text_ar: string;
  text_en: string | null;
  grade: string | null;
}

interface NotFoundResult {
  found: false;
  message: string;
}

interface ErrorResult {
  error: string;
}

interface QuranRecitationMedia {
  type: 'quran_recitation';
  surahNumber: number;
  surahName: string;
  reciterName: string;
  audioUrl: string;
  source: string;
  startAyah?: number | null;
  endAyah?: number | null;
  audioUrls?: string[];
}

interface QuranRecitationResult {
  reply: string;
  media?: QuranRecitationMedia;
}

interface QuranTafsirMedia {
  type: 'quran_tafsir';
  surahNumber: number;
  surahName: string;
  startAyah?: number | null;
  endAyah?: number | null;
  isLarge: boolean;
}

interface QuranTafsirResult {
  reply: string;
  media?: QuranTafsirMedia;
}

interface QuranSurahRerankResult {
  surahNumber: number | null;
  confidence: 'high' | 'medium' | 'low';
}

interface ParsedQuranQuery {
  surahNumber: number | null;
  startAyah: number | null;
  endAyah: number | null;
}

type ToolResult =
  | QuranResult[]
  | HadithResult[]
  | Record<string, string>
  | HijriCalendarResult
  | QuranRecitationResult
  | QuranTafsirResult
  | NotFoundResult
  | ErrorResult;

const SURAH_VERSE_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
  123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
  34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
  60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
  28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
  15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
  5, 4, 5, 6
];

function getGlobalAyahNumber(surahNumber: number, ayahNumber: number): number {
  let globalNumber = 0;
  for (let i = 0; i < surahNumber - 1; i++) {
    globalNumber += SURAH_VERSE_COUNTS[i];
  }
  return globalNumber + ayahNumber;
}

function getRecitationReply(
  surahName: string,
  reciterName: string,
  startAyah: number | null,
  endAyah: number | null,
  language: string,
): string {
  const isRange = startAyah !== null && endAyah !== null && startAyah !== endAyah;
  const isSingle = startAyah !== null && (endAyah === null || startAyah === endAyah);

  const translations: Record<string, { full: string; single: string; range: string }> = {
    en: {
      full: `Here is Surah ${surahName} recited by ${reciterName}.`,
      single: `Here is Ayah ${startAyah} of Surah ${surahName} recited by ${reciterName}.`,
      range: `Here are Ayahs ${startAyah} to ${endAyah} of Surah ${surahName} recited by ${reciterName}.`,
    },
    bn: {
      full: `${reciterName}-এর কণ্ঠে সূরা ${surahName} তিলাওয়াত শুনুন।`,
      single: `${reciterName}-এর কণ্ঠে সূরা ${surahName}-এর ${startAyah} নং আয়াত তিলাওয়াত শুনুন।`,
      range: `${reciterName}-এর কণ্ঠে সূরা ${surahName}-এর ${startAyah} থেকে ${endAyah} নং আয়াত তিলাওয়াত শুনুন।`,
    },
    ar: {
      full: `إليك سورة ${surahName} بتلاوة ${reciterName}.`,
      single: `إليك الآية ${startAyah} من سورة ${surahName} بتلاوة ${reciterName}.`,
      range: `إليك الآيات من ${startAyah} إلى ${endAyah} من سورة ${surahName} بتلاوة ${reciterName}.`,
    },
    tr: {
      full: `İşte ${reciterName} tarafından okunan ${surahName} Suresi.`,
      single: `İşte ${reciterName} tarafından okunan ${surahName} Suresi ${startAyah}. ayet.`,
      range: `İşte ${reciterName} tarafından okunan ${surahName} Suresi ${startAyah} ile ${endAyah} arası ayetler.`,
    },
    id: {
      full: `Berikut Surah ${surahName} yang dilantunkan oleh ${reciterName}.`,
      single: `Berikut Ayat ${startAyah} dari Surah ${surahName} yang dilantunkan oleh ${reciterName}.`,
      range: `Berikut Ayat ${startAyah} hingga ${endAyah} dari Surah ${surahName} yang dilantunkan oleh ${reciterName}.`,
    },
    es: {
      full: `Aquí está la Sura ${surahName} recitada por ${reciterName}.`,
      single: `Aquí está la Aleya ${startAyah} de la Sura ${surahName} recitada por ${reciterName}.`,
      range: `Aquí están las Aleyas ${startAyah} a ${endAyah} de la Sura ${surahName} recitada por ${reciterName}.`,
    },
    fr: {
      full: `Voici la sourate ${surahName} récitée par ${reciterName}.`,
      single: `Voici le verset ${startAyah} de la sourate ${surahName} récité par ${reciterName}.`,
      range: `Voici les versets ${startAyah} à ${endAyah} de la sourate ${surahName} récités par ${reciterName}.`,
    },
    ru: {
      full: `Вот сура ${surahName} в чтении ${reciterName}.`,
      single: `Вот аят ${startAyah} суры ${surahName} в чтении ${reciterName}.`,
      range: `Вот аяты с ${startAyah} по ${endAyah} суры ${surahName} в чтении ${reciterName}.`,
    },
    zh: {
      full: `这是由 ${reciterName} 诵读的 ${surahName}。`,
      single: `这是由 ${reciterName} 诵读的 ${surahName} 第 ${startAyah} 节。`,
      range: `这是由 ${reciterName} 诵读的 ${surahName} 第 ${startAyah} 至 ${endAyah} 节。`,
    },
  };

  const t = translations[language] ?? translations['en'];
  if (isRange) return t.range;
  if (isSingle) return t.single;
  return t.full;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly embeddingModelName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly ragService: RagService,
    private readonly geminiKeyService: GeminiKeyService,
  ) {
    this.embeddingModelName =
      this.configService.get<string>('gemini.embeddingModel') ?? 'gemini-embedding-001';
  }

  private isRateLimitError(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota');
  }

  private async getGeminiApiKey(): Promise<{ id: string | null; apiKey: string }> {
    try {
      const row = await this.geminiKeyService.getNextKey();
      if (row) return row;
    } catch (error) {
      this.logger.warn(`Unable to read DB Gemini key, using fallback key if available: ${(error as Error).message}`);
    }

    const apiKey = this.configService.get<string>('gemini.apiKey');
    if (!apiKey) throw new Error('No Gemini API keys available');
    return { id: null, apiKey };
  }

  /**
   * Embed text with automatic key rotation on 429 errors.
   * Tries each available key once before giving up.
   */
  private async embedWithRotation(text: string): Promise<number[]> {
    const stats = await this.geminiKeyService.getStats();
    const maxAttempts = (stats.total || 1) + 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { id, apiKey } = await this.getGeminiApiKey();

      try {
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: this.embeddingModelName,
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
          this.logger.warn(`MCP embed key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  async executeTool(toolName: string, toolInput: Record<string, string>): Promise<ToolResult> {
    switch (toolName) {
      case 'search_quran_by_topic':
        return this.searchQuranByTopic(toolInput.keyword, toolInput.language);
      case 'search_hadith_by_topic':
        return this.searchHadithByTopic(toolInput.keyword, toolInput.collection);
      case 'get_prayer_times':
        return this.getPrayerTimes(toolInput.city, toolInput.country);
      case 'get_hijri_calendar':
        return this.getHijriCalendar(toolInput);
      case 'get_quran_recitation':
        return this.getQuranRecitation(toolInput);
      case 'get_tafsir':
        return this.getTafsir(toolInput);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  private async parseQuranRecitationQuery(
    query: string,
  ): Promise<ParsedQuranQuery> {
    const prompt =
      `You are an expert Quran recitation parser.\n` +
      `Your task is to parse a user's request for Quran audio and extract the source Surah number and any specific Ayah or range of Ayahs.\n` +
      `The target may be a Surah, an Ayah, a well-known named verse, or a recognizable Quranic dua phrase; it does not need to be called a Surah.\n` +
      `User request: ${JSON.stringify(query)}\n\n` +
      `Rules:\n` +
      `1. Identify the Surah number (1 to 114) from the request. If the name of the Surah is given, map it to its canonical number (e.g., Al-Fatihah is 1, Al-Baqarah is 2, Ya-Sin is 36, etc.).\n` +
      `2. Identify the start and end Ayah numbers (1-based indices) if specified. If only a single Ayah is requested (e.g. "ayah 255"), both startAyah and endAyah should be that number.\n` +
      `3. For famous verses and recognizable Quranic dua phrases, resolve them to their exact source Surah and Ayah range even if the user does not say "Surah" or "Ayah":\n` +
      `   - "Ayat al-Kursi" / "Ayatul Kursi" / "آية الكرسي" / "আয়াতুল কুরসি" -> Surah 2, Ayah 255 to 255\n` +
      `   - "Amanar Rasulu" / "আমানার রাসুলু" -> Surah 2, Ayah 285 to 286\n` +
      `   - "Last two verses of Surah Al-Baqarah" -> Surah 2, Ayah 285 to 286\n` +
      `   - "Last ten verses of Ali 'Imran" -> Surah 3, Ayah 190 to 200\n` +
      `4. For a recognizable Quranic dua title or quoted phrase, resolve the Quranic verse or range containing it. If the target is ambiguous or is not identifiable as Quranic, return null for surahNumber rather than guessing.\n` +
      `5. If no specific Ayah or range is requested, set startAyah and endAyah to null.\n` +
      `6. Return only strict JSON in this exact format:\n` +
      `   {"surahNumber": number | null, "startAyah": number | null, "endAyah": number | null}`;

    const modelName = this.configService.get<string>('gemini.chatModel') ?? 'gemini-2.5-flash';
    const maxAttempts = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
      const { id, apiKey } = await this.getGeminiApiKey();

      try {
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: modelName,
          generationConfig: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseMimeType: 'application/json' as any,
          },
        });
        const response = await model.generateContent(prompt);
        const text = response.response.text();
        const jsonText = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(jsonText) as Partial<ParsedQuranQuery>;

        const surahNumber =
          typeof parsed.surahNumber === 'number' && Number.isInteger(parsed.surahNumber) && parsed.surahNumber >= 1 && parsed.surahNumber <= 114
            ? parsed.surahNumber
            : null;

        const startAyah =
          typeof parsed.startAyah === 'number' && Number.isInteger(parsed.startAyah) && parsed.startAyah >= 1
            ? parsed.startAyah
            : null;

        const endAyah =
          typeof parsed.endAyah === 'number' && Number.isInteger(parsed.endAyah) && parsed.endAyah >= 1
            ? parsed.endAyah
            : null;

        return { surahNumber, startAyah, endAyah };
      } catch (error) {
        lastError = error as Error;
        if (this.isRateLimitError(error) && id) {
          this.logger.warn(`MCP query parser key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  private buildQuranAudioUrlForAyah(surahNumber: number, ayahNumber: number): string {
    const globalNumber = getGlobalAyahNumber(surahNumber, ayahNumber);
    return `https://cdn.islamic.network/quran/audio/${QURAN_AUDIO_RECITER.bitrate}/${QURAN_AUDIO_RECITER.edition}/${globalNumber}.mp3`;
  }

  private buildQuranAudioUrl(surahNumber: number): string {
    return `https://cdn.islamic.network/quran/audio-surah/${QURAN_AUDIO_RECITER.bitrate}/${QURAN_AUDIO_RECITER.edition}/${surahNumber}.mp3`;
  }

  private buildQuranRecitationResult(surah: QuranSurahRaw): QuranRecitationResult {
    return {
      reply: `Here is Surah ${surah.name_en} recited by ${QURAN_AUDIO_RECITER.name}.`,
      media: {
        type: 'quran_recitation',
        surahNumber: surah.surah_number,
        surahName: surah.name_en,
        reciterName: QURAN_AUDIO_RECITER.name,
        audioUrl: this.buildQuranAudioUrl(surah.surah_number),
        source: QURAN_AUDIO_RECITER.source,
      },
    };
  }

  private getQuranRecitationClarificationReply(): QuranRecitationResult {
    return {
      reply:
        'Which surah would you like me to recite? For example: Al-Fatihah, Ya-Sin, Ar-Rahman, or Al-Mulk.',
    };
  }

  private getQuranRecitationNotFoundReply(): QuranRecitationResult {
    return {
      reply:
        'I could not find that surah. Please clarify the surah name or provide the surah number.',
    };
  }

  private parseQuranSurahRerankResponse(text: string): QuranSurahRerankResult | null {
    const jsonText = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

    try {
      const parsed = JSON.parse(jsonText) as Partial<QuranSurahRerankResult>;
      const confidence = parsed.confidence;
      const surahNumber =
        typeof parsed.surahNumber === 'number' && Number.isInteger(parsed.surahNumber)
          ? parsed.surahNumber
          : null;

      if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null;

      return { surahNumber, confidence };
    } catch {
      return null;
    }
  }

  private async rerankQuranSurahCandidates(
    rawName: string,
    candidates: QuranSurahSearchResult[],
  ): Promise<QuranSurahRaw | null> {
    if (candidates.length === 0) return null;

    const candidateLines = candidates
      .map(
        (candidate) =>
          `- surahNumber=${candidate.surah_number}, name_en="${candidate.name_en}", name_bn="${candidate.name_bn}", similarity=${candidate.similarity.toFixed(4)}`,
      )
      .join('\n');

    const prompt =
      `You resolve Quran recitation requests to one of the provided candidate surahs only.\n` +
      `User request: ${JSON.stringify(rawName)}\n\n` +
      `Candidates:\n${candidateLines}\n\n` +
      `Rules:\n` +
      `- Use only the candidate list. Do not choose a surah number that is not in the candidates.\n` +
      `- The user may include command words such as recite/play/listen or Bangla equivalents; infer the intended surah name from the request.\n` +
      `- If the intended surah is clear, return high confidence.\n` +
      `- If the intended surah is ambiguous or absent, return null with low confidence.\n` +
      `- Return only strict JSON in this exact shape: {"surahNumber":114,"confidence":"high"} or {"surahNumber":null,"confidence":"low"}`;

    const modelName = this.configService.get<string>('gemini.chatModel') ?? 'gemini-2.5-flash';
    const maxAttempts = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
      const { id, apiKey } = await this.getGeminiApiKey();

      try {
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
        const response = await model.generateContent(prompt);
        const parsed = this.parseQuranSurahRerankResponse(response.response.text());

        if (!parsed || parsed.confidence === 'low' || parsed.surahNumber === null) return null;

        return candidates.find((candidate) => candidate.surah_number === parsed.surahNumber) ?? null;
      } catch (error) {
        lastError = error as Error;
        if (this.isRateLimitError(error) && id) {
          this.logger.warn(`MCP rerank key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  private async getQuranRecitation(input: Record<string, string>): Promise<QuranRecitationResult | ErrorResult> {
    try {
      const language = input.language?.trim() || 'en';

      let surahNumber: number | null = null;
      let startAyah: number | null = null;
      let endAyah: number | null = null;

      // 1. If startAyah and endAyah are passed directly (e.g. by agent tool call)
      if (input.startAyah) {
        startAyah = Number(input.startAyah);
      }
      if (input.endAyah) {
        endAyah = Number(input.endAyah);
      }

      // 2. Resolve surahNumber
      const rawNumber = input.surahNumber?.trim();
      const numberValue = Number(rawNumber);
      if (rawNumber && Number.isInteger(numberValue) && numberValue >= 1 && numberValue <= 114) {
        surahNumber = numberValue;
      }

      const rawName = input.surahName?.trim();

      // If we don't have surahNumber but we have rawName, try to find/parse it
      if (!surahNumber && rawName) {
        // Fast-path: Check exact/contained match in local DB
        const nameMatch = await this.ragService.findQuranSurahByName(rawName);
        if (nameMatch) {
          surahNumber = nameMatch.surah_number;
        } else {
          // Parser-path: Parse using Gemini
          const parsed = await this.parseQuranRecitationQuery(rawName);
          if (parsed.surahNumber) {
            surahNumber = parsed.surahNumber;
            if (parsed.startAyah && !startAyah) {
              startAyah = parsed.startAyah;
            }
            if (parsed.endAyah && !endAyah) {
              endAyah = parsed.endAyah;
            }
          }
        }
      }

      // If we STILL don't have surahNumber but we have rawName, try embedding search + rerank as fallback
      if (!surahNumber && rawName) {
        const embedding = await this.embedWithRotation(rawName);
        const candidates = await this.ragService.searchQuranSurahCandidates(embedding, 8);
        const reranked = await this.rerankQuranSurahCandidates(rawName, candidates);
        if (reranked) {
          surahNumber = reranked.surah_number;
        }
      }

      // If no surahName and no surahNumber, ask for clarification
      if (!surahNumber) {
        if (!rawName) {
          return this.getQuranRecitationClarificationReply();
        }
        return this.getQuranRecitationNotFoundReply();
      }

      // Retrieve the surah from DB
      const surah = await this.ragService.getQuranSurahByNumber(surahNumber);
      if (!surah) {
        return this.getQuranRecitationNotFoundReply();
      }

      // Validate ayah bounds
      const maxVerses = SURAH_VERSE_COUNTS[surah.surah_number - 1];
      if (startAyah && (startAyah < 1 || startAyah > maxVerses)) {
        const nameLocalized = language === 'bn' ? surah.name_bn : surah.name_en;
        const msg = language === 'bn'
          ? `সূরা ${nameLocalized}-এ কেবল ${maxVerses}টি আয়াত রয়েছে। অনুগ্রহ করে ১ থেকে ${maxVerses}-এর মধ্যে আয়াত নম্বর বলুন।`
          : `Surah ${nameLocalized} only has ${maxVerses} verses. Please request verses between 1 and ${maxVerses}.`;
        return { reply: msg };
      }

      if (endAyah) {
        if (endAyah < 1) endAyah = 1;
        if (endAyah > maxVerses) endAyah = maxVerses;
      }

      if (startAyah && endAyah && startAyah > endAyah) {
        const temp = startAyah;
        startAyah = endAyah;
        endAyah = temp;
      }

      // Build the recitation media result
      const nameLocalized = language === 'bn' ? surah.name_bn : surah.name_en;
      const reciterName = QURAN_AUDIO_RECITER.name;

      let reply = '';
      let media: QuranRecitationMedia;

      if (startAyah) {
        const actualEndAyah = endAyah || startAyah;
        const audioUrl = this.buildQuranAudioUrlForAyah(surah.surah_number, startAyah);
        const audioUrls: string[] = [];
        for (let a = startAyah; a <= actualEndAyah; a++) {
          audioUrls.push(this.buildQuranAudioUrlForAyah(surah.surah_number, a));
        }

        reply = getRecitationReply(nameLocalized, reciterName, startAyah, actualEndAyah, language);
        media = {
          type: 'quran_recitation',
          surahNumber: surah.surah_number,
          surahName: surah.name_en,
          reciterName,
          audioUrl,
          audioUrls,
          startAyah,
          endAyah: actualEndAyah,
          source: QURAN_AUDIO_RECITER.source,
        };
      } else {
        reply = getRecitationReply(nameLocalized, reciterName, null, null, language);
        media = {
          type: 'quran_recitation',
          surahNumber: surah.surah_number,
          surahName: surah.name_en,
          reciterName,
          audioUrl: this.buildQuranAudioUrl(surah.surah_number),
          source: QURAN_AUDIO_RECITER.source,
        };
      }

      return { reply, media };
    } catch (error) {
      this.logger.warn(`Quran recitation lookup failed: ${(error as Error).message}`);
      return {
        error: `Failed to get Quran recitation: ${(error as Error).message}`,
      };
    }
  }

  private async searchQuranByTopic(
    keyword: string,
    language = 'en',
  ): Promise<QuranResult[] | NotFoundResult | ErrorResult> {
    try {
      const embedding = await this.embedWithRotation(keyword);
      const verses = await this.ragService.searchQuranVerses(embedding, language, 5);

      if (verses.length === 0) {
        return { found: false, message: `No verses found in database for: ${keyword}` };
      }

      const results = await Promise.all(
        verses.map(async (v) => {
          let tafsirText: string | undefined;
          try {
            const tafsirs = await this.ragService.getQuranTafsir(v.chapter_number, v.verse_number, v.verse_number);
            if (tafsirs?.length > 0) {
              tafsirText = tafsirs[0].text_plain || tafsirs[0].text_html?.replace(/<[^>]+>/g, '')?.trim() || undefined;
            }
          } catch (dbErr) {
            this.logger.warn(
              `Failed to fetch tafsir for Surah ${v.chapter_number} Ayah ${v.verse_number}: ${(dbErr as Error).message}`,
            );
          }

          return {
            reference: `Surah ${v.chapter_name} (${v.chapter_number}:${v.verse_number})`,
            arabicName: v.chapter_name,
            text_ar: v.text_ar,
            translation: v.translation ?? v.text_ar,
            tafsir: tafsirText,
          };
        }),
      );

      return results;
    } catch (error) {
      this.logger.warn(`Quran search failed for "${keyword}": ${(error as Error).message}`);
      return { error: `Failed to search Quran: ${(error as Error).message}` };
    }
  }

  private async searchHadithByTopic(
    keyword: string,
    collection?: string,
  ): Promise<HadithResult[] | NotFoundResult | ErrorResult> {
    try {
      const embedding = await this.embedWithRotation(keyword);
      const results: HadithSearchResult[] = await this.ragService.searchHadiths(
        embedding,
        collection,
        5,
      );

      if (results.length === 0) {
        return { found: false, message: `No hadith found in local database for: ${keyword}` };
      }

      return results.map((h) => ({
        reference: `${h.collection_name} Hadith #${h.hadith_number}${
          h.chapter_name ? ` — ${h.chapter_name}` : ''
        }`,
        narrator: h.narrator_en,
        text_ar: h.text_ar,
        text_en: h.text_en,
        grade: h.grade,
      }));
    } catch (error) {
      this.logger.warn(`Hadith search failed for "${keyword}": ${(error as Error).message}`);
      return { error: `Failed to search Hadith: ${(error as Error).message}` };
    }
  }

  private async getPrayerTimes(
    city: string,
    country: string,
  ): Promise<Record<string, string> | ErrorResult> {
    try {
      const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&school=1`;
      const response = await axios.get<PrayerTimesResponse>(url);
      return response.data.data.timings;
    } catch (error) {
      this.logger.warn(
        `Prayer times lookup failed for ${city}, ${country}: ${(error as Error).message}`,
      );
      return { error: `Failed to get prayer times: ${(error as Error).message}` };
    }
  }

  private getTodayGregorianDate(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();

    return `${day}-${month}-${year}`;
  }

  private getApiAdjustmentParam(adjustment?: string): string {
    const numericAdjustment = Number(adjustment ?? 0);

    if (!Number.isInteger(numericAdjustment) || numericAdjustment < -2 || numericAdjustment > 2) {
      return '0';
    }

    return String(numericAdjustment);
  }

  private async convertGregorianToHijri(
    gregorianDate: string,
    adjustment: string,
  ): Promise<AladhanDatePair> {
    const response = await axios.get<HijriCalendarResponse>(
      `https://api.aladhan.com/v1/gToH?date=${encodeURIComponent(gregorianDate)}&adjustment=${encodeURIComponent(adjustment)}`,
    );

    return response.data.data as AladhanDatePair;
  }

  private async convertHijriToGregorian(
    hijriDate: string,
    adjustment: string,
  ): Promise<AladhanDatePair> {
    const response = await axios.get<HijriCalendarResponse>(
      `https://api.aladhan.com/v1/hToG?date=${encodeURIComponent(hijriDate)}&adjustment=${encodeURIComponent(adjustment)}`,
    );

    return response.data.data as AladhanDatePair;
  }

  private async getHijriMonthCalendar(
    hijriMonth: string,
    hijriYear: string,
    adjustment: string,
  ): Promise<HijriCalendarResult['hijriMonthCalendar']> {
    const response = await axios.get<HijriCalendarResponse>(
      `https://api.aladhan.com/v1/hToGCalendar/${encodeURIComponent(hijriMonth)}/${encodeURIComponent(hijriYear)}?adjustment=${encodeURIComponent(adjustment)}`,
    );
    const dates = response.data.data as AladhanDatePair[];

    return dates.map((date) => ({
      gregorian: date.gregorian,
      hijri: date.hijri,
    }));
  }

  private isValidDateString(date?: string): date is string {
    return Boolean(date && /^\d{2}-\d{2}-\d{4}$/.test(date));
  }

  private isValidNumberString(value?: string): value is string {
    return Boolean(value && /^\d+$/.test(value));
  }

  private async getHijriCalendar(
    input: Record<string, string>,
  ): Promise<HijriCalendarResult | ErrorResult> {
    const adjustment = this.getApiAdjustmentParam(input.adjustment);

    try {
      const gregorianDate = this.isValidDateString(input.gregorianDate)
        ? input.gregorianDate
        : this.getTodayGregorianDate();
      const gregorianToHijri = await this.convertGregorianToHijri(gregorianDate, adjustment);
      const result: HijriCalendarResult = {
        source: 'NoorAi Hijri Calendar',
        note: 'NoorAi Hijri dates are calculated mathematically. Local moon-sighting authorities may differ by one day.',
        gregorianToHijri,
      };

      if (!input.gregorianDate) {
        result.today = gregorianToHijri;
      }

      if (this.isValidDateString(input.hijriDate)) {
        result.hijriToGregorian = await this.convertHijriToGregorian(input.hijriDate, adjustment);
      }

      const hijriYear = this.isValidNumberString(input.hijriYear)
        ? input.hijriYear
        : gregorianToHijri.hijri.year;

      result.eidDates = {
        hijriYear,
        eidAlFitr: await this.convertHijriToGregorian(`01-10-${hijriYear}`, adjustment),
        eidAlAdha: await this.convertHijriToGregorian(`10-12-${hijriYear}`, adjustment),
      };

      if (this.isValidNumberString(input.hijriMonth)) {
        result.hijriMonthCalendar = await this.getHijriMonthCalendar(
          input.hijriMonth,
          hijriYear,
          adjustment,
        );
      }

      return result;
    } catch (error) {
      this.logger.warn(`Hijri calendar lookup failed: ${(error as Error).message}`);
      return { error: `Failed to get Hijri calendar: ${(error as Error).message}` };
    }
  }

  private async getTafsir(input: Record<string, string>): Promise<QuranTafsirResult | ErrorResult> {
    try {
      const language = input.language?.trim() || 'en';

      let surahNumber: number | null = null;
      let startAyah: number | null = null;
      let endAyah: number | null = null;

      // 1. If startAyah and endAyah are passed directly
      if (input.startAyah) {
        startAyah = Number(input.startAyah);
      }
      if (input.endAyah) {
        endAyah = Number(input.endAyah);
      }

      // 2. Resolve surahNumber
      const rawNumber = input.surahNumber?.trim();
      const numberValue = Number(rawNumber);
      if (rawNumber && Number.isInteger(numberValue) && numberValue >= 1 && numberValue <= 114) {
        surahNumber = numberValue;
      }

      const rawName = input.surahName?.trim();

      // If we don't have surahNumber but we have rawName, try to find/parse it
      if (!surahNumber && rawName) {
        const nameMatch = await this.ragService.findQuranSurahByName(rawName);
        if (nameMatch) {
          surahNumber = nameMatch.surah_number;
        } else {
          const parsed = await this.parseQuranRecitationQuery(rawName);
          if (parsed.surahNumber) {
            surahNumber = parsed.surahNumber;
            if (parsed.startAyah && !startAyah) {
              startAyah = parsed.startAyah;
            }
            if (parsed.endAyah && !endAyah) {
              endAyah = parsed.endAyah;
            }
          }
        }
      }

      // If we STILL don't have surahNumber but we have rawName, try embedding search + rerank as fallback
      if (!surahNumber && rawName) {
        const embedding = await this.embedWithRotation(rawName);
        const candidates = await this.ragService.searchQuranSurahCandidates(embedding, 8);
        const reranked = await this.rerankQuranSurahCandidates(rawName, candidates);
        if (reranked) {
          surahNumber = reranked.surah_number;
        }
      }

      if (!surahNumber) {
        return {
          reply: language === 'bn'
            ? 'আপনি কোন সূরার তাফসীর জানতে চাচ্ছেন? যেমন: সূরা ফাতিহা, সূরা ইয়াসিন, সূরা আল-বাকারাহ ইত্যাদি।'
            : 'Which surah would you like to view the Tafsir for? For example: Al-Fatihah, Ya-Sin, Al-Baqarah, or Al-Mulk.',
        };
      }

      // Retrieve the surah from DB to get names
      const surah = await this.ragService.getQuranSurahByNumber(surahNumber);
      if (!surah) {
        return {
          reply: language === 'bn'
            ? 'দুঃখিত, সূরাটি খুঁজে পাওয়া যায়নি।'
            : 'Sorry, I could not find that surah.',
        };
      }

      // Validate/normalize bounds
      const maxVerses = SURAH_VERSE_COUNTS[surah.surah_number - 1];
      if (startAyah && (startAyah < 1 || startAyah > maxVerses)) {
        startAyah = 1;
      }
      if (endAyah && (endAyah < 1 || endAyah > maxVerses)) {
        endAyah = maxVerses;
      }
      if (!startAyah) startAyah = 1;
      if (!endAyah) endAyah = maxVerses;

      if (startAyah > endAyah) {
        const temp = startAyah;
        startAyah = endAyah;
        endAyah = temp;
      }

      const count = endAyah - startAyah + 1;

      // Fetch Tafsir records
      const tafsirs = await this.ragService.getQuranTafsir(surahNumber, startAyah, endAyah);
      if (tafsirs.length === 0) {
        return {
          reply: language === 'bn'
            ? `সূরা ${surah.name_bn}-এর আয়াত ${startAyah} থেকে ${endAyah}-এর জন্য কোনো তাফসীর পাওয়া যায়নি।`
            : `No Tafsir found for Surah ${surah.name_en} (Ayahs ${startAyah}-${endAyah}) in the database.`,
        };
      }

      const isLarge = count >= 10;
      const nameLocalized = language === 'bn' ? surah.name_bn : surah.name_en;

      if (!isLarge) {
        // Return full Tafsir content directly (formatted simply as text)
        let fullContent = '';
        for (const t of tafsirs) {
          const plainText = t.text_plain || t.text_html.replace(/<[^>]+>/g, '').trim() || '';
          fullContent += `Ayah ${t.verse_number}:\n${plainText}\n\n`;
        }

        const intro = language === 'bn'
          ? `সূরা ${nameLocalized} (আয়াত ${startAyah}-${endAyah})-এর তাফসীর:\n\n`
          : `Tafsir of Surah ${nameLocalized} (Ayahs ${startAyah}-${endAyah}):\n\n`;

        return {
          reply: `${intro}${fullContent.trim()}`,
          media: {
            type: 'quran_tafsir',
            surahNumber: surah.surah_number,
            surahName: surah.name_en,
            startAyah,
            endAyah,
            isLarge: false,
          },
        };
      } else {
        // large surah or range: select 20 rows and summarize using AI in target language
        const L = tafsirs.length;
        const selectedTafsirs: typeof tafsirs = [];
        if (L <= 20) {
          selectedTafsirs.push(...tafsirs);
        } else {
          const step = (L - 1) / 19;
          for (let i = 0; i < 20; i++) {
            const idx = Math.round(i * step);
            if (tafsirs[idx]) {
              selectedTafsirs.push(tafsirs[idx]);
            }
          }
        }

        // Build summary input text
        const selectedTexts = selectedTafsirs
          .map((t) => `Ayah ${t.verse_number}: ${t.text_plain || t.text_html.replace(/<[^>]+>/g, '').trim()}`)
          .join('\n\n');

        // Summarize via Gemini
        const summary = await this.summarizeTafsir(
          surah.name_en,
          startAyah,
          endAyah,
          selectedTexts,
          language,
        );

        return {
          reply: summary,
          media: {
            type: 'quran_tafsir',
            surahNumber: surah.surah_number,
            surahName: surah.name_en,
            startAyah,
            endAyah,
            isLarge: true,
          },
        };
      }
    } catch (error) {
      this.logger.warn(`Tafsir lookup failed: ${(error as Error).message}`);
      return {
        error: `Failed to get Tafsir: ${(error as Error).message}`,
      };
    }
  }

  private async summarizeTafsir(
    surahName: string,
    startAyah: number,
    endAyah: number,
    text: string,
    language: string,
  ): Promise<string> {
    const prompt =
      `You are an expert Islamic scholar.\n` +
      `Below is a representative subset of Tafsir (commentary) text for Surah ${surahName} (Ayahs ${startAyah} to ${endAyah}).\n` +
      `Your task is to summarize the core themes, messages, lessons, and explanation of these verses in a clear, structured, and informative manner.\n` +
      `Generate the ENTIRE summary in the requested language: ${language}.\n\n` +
      `Representative Tafsir text:\n${text}`;

    const modelName = this.configService.get<string>('gemini.chatModel') ?? 'gemini-2.5-flash';
    const maxAttempts = (await this.geminiKeyService.getStats()).total || 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
      const { id, apiKey } = await this.getGeminiApiKey();

      try {
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
        const response = await model.generateContent(prompt);
        return response.response.text();
      } catch (error) {
        lastError = error as Error;
        if (this.isRateLimitError(error) && id) {
          this.logger.warn(`MCP Tafsir summarizer key ${id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(id);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }
}
