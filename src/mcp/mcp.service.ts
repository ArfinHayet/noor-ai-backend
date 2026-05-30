import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { RagService, HadithSearchResult, QuranSurahRaw } from '../rag/rag.service';
import { GeminiKeyService } from '../rag/services/gemini-key.service';

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
}

interface QuranRecitationResult {
  reply: string;
  media?: QuranRecitationMedia;
}

type ToolResult =
  | QuranResult[]
  | HadithResult[]
  | Record<string, string>
  | HijriCalendarResult
  | QuranRecitationResult
  | NotFoundResult
  | ErrorResult;

const QURAN_AUDIO_RECITER = {
  edition: 'ar.alafasy',
  name: 'Mishary Rashid Alafasy',
  source: 'AlQuran.cloud CDN',
  bitrate: 128,
};

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

  /**
   * Embed text with automatic key rotation on 429 errors.
   * Tries each available key once before giving up.
   */
  private async embedWithRotation(text: string): Promise<number[]> {
    const stats = await this.geminiKeyService.getStats();
    const maxAttempts = (stats.total || 1) + 1;
    let lastError: Error = new Error('No keys tried');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let row;
      try {
        row = await this.geminiKeyService.getNextKey();
      } catch (error) {
        this.logger.warn(`Unable to read DB Gemini key, using fallback key if available: ${(error as Error).message}`);
        row = null;
      }

      const apiKey = row?.apiKey ?? this.configService.get<string>('gemini.apiKey');
      if (!apiKey) throw new Error('No Gemini API keys available');

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
        if (this.isRateLimitError(err) && row?.id) {
          this.logger.warn(`MCP embed key ${row.id.slice(0, 8)}… rate-limited, rotating...`);
          await this.geminiKeyService.markRateLimited(row.id);
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
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
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

  private async getQuranRecitation(input: Record<string, string>): Promise<QuranRecitationResult | ErrorResult> {
    try {
      const rawNumber = input.surahNumber?.trim();
      const numberValue = Number(rawNumber);

      if (rawNumber && Number.isInteger(numberValue) && numberValue >= 1 && numberValue <= 114) {
        const surah = await this.ragService.getQuranSurahByNumber(numberValue);
        return surah ? this.buildQuranRecitationResult(surah) : this.getQuranRecitationNotFoundReply();
      }

      if (rawNumber) {
        return this.getQuranRecitationNotFoundReply();
      }

      const rawName = input.surahName?.trim();
      if (!rawName) {
        return this.getQuranRecitationClarificationReply();
      }

      const nameMatch = await this.ragService.findQuranSurahByName(rawName);
      if (nameMatch) {
        return this.buildQuranRecitationResult(nameMatch);
      }

      const embedding = await this.embedWithRotation(rawName);
      const matches = await this.ragService.searchQuranSurah(embedding, 1);
      const surah = matches[0];

      if (!surah) {
        return this.getQuranRecitationNotFoundReply();
      }

      return this.buildQuranRecitationResult(surah);
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

      return verses.map((v) => ({
        reference: `Surah ${v.chapter_name} (${v.chapter_number}:${v.verse_number})`,
        arabicName: v.chapter_name,
        text_ar: v.text_ar,
        translation: v.translation ?? v.text_ar,
      }));
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
}
