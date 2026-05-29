import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { RagService, HadithSearchResult } from '../rag/rag.service';
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

interface SurahMeta {
  number: number;
  name: string;
  aliases: string[];
}

const QURAN_AUDIO_RECITER = {
  edition: 'ar.alafasy',
  name: 'Mishary Rashid Alafasy',
  source: 'AlQuran.cloud CDN',
  bitrate: 128,
};

const SURAH_LIST: SurahMeta[] = [
  { number: 1, name: 'Al-Fatihah', aliases: ['fatihah', 'fatiha', 'ফাতিহা'] },
  { number: 2, name: 'Al-Baqarah', aliases: ['baqarah', 'bakara', 'বাকারা'] },
  { number: 3, name: 'Ali Imran', aliases: ['aal imran', 'imran', 'ইমরান'] },
  { number: 4, name: 'An-Nisa', aliases: ['nisa', 'নিসা'] },
  { number: 5, name: 'Al-Maidah', aliases: ['maidah', 'maida', 'মায়িদা'] },
  { number: 6, name: 'Al-Anam', aliases: ['anam', 'anaam', 'আনআম'] },
  { number: 7, name: 'Al-Araf', aliases: ['araf', 'আরাফ'] },
  { number: 8, name: 'Al-Anfal', aliases: ['anfal', 'আনফাল'] },
  { number: 9, name: 'At-Tawbah', aliases: ['tawbah', 'taubah', 'তাওবা'] },
  { number: 10, name: 'Yunus', aliases: ['younus', 'ইউনুস'] },
  { number: 11, name: 'Hud', aliases: ['হুদ'] },
  { number: 12, name: 'Yusuf', aliases: ['yousuf', 'ইউসুফ'] },
  { number: 13, name: 'Ar-Rad', aliases: ['rad', 'raad', 'রাদ'] },
  { number: 14, name: 'Ibrahim', aliases: ['ইব্রাহিম'] },
  { number: 15, name: 'Al-Hijr', aliases: ['hijr', 'হিজর'] },
  { number: 16, name: 'An-Nahl', aliases: ['nahl', 'নাহল'] },
  { number: 17, name: 'Al-Isra', aliases: ['isra', 'bani israel', 'ইসরা', 'বনী ইসরাইল'] },
  { number: 18, name: 'Al-Kahf', aliases: ['kahf', 'কাহফ'] },
  { number: 19, name: 'Maryam', aliases: ['মারইয়াম', 'মারিয়াম'] },
  { number: 20, name: 'Ta-Ha', aliases: ['taha', 'ত্বহা'] },
  { number: 21, name: 'Al-Anbiya', aliases: ['anbiya', 'আম্বিয়া', 'আনবিয়া'] },
  { number: 22, name: 'Al-Hajj', aliases: ['hajj', 'হজ', 'হজ্জ'] },
  { number: 23, name: 'Al-Muminun', aliases: ['muminun', 'muminoon', 'মুমিনুন'] },
  { number: 24, name: 'An-Nur', aliases: ['nur', 'noor', 'নূর'] },
  { number: 25, name: 'Al-Furqan', aliases: ['furqan', 'ফুরকান'] },
  { number: 26, name: 'Ash-Shuara', aliases: ['shuara', 'শুআরা'] },
  { number: 27, name: 'An-Naml', aliases: ['naml', 'নামল'] },
  { number: 28, name: 'Al-Qasas', aliases: ['qasas', 'কাসাস'] },
  { number: 29, name: 'Al-Ankabut', aliases: ['ankabut', 'আনকাবুত'] },
  { number: 30, name: 'Ar-Rum', aliases: ['rum', 'room', 'রুম'] },
  { number: 31, name: 'Luqman', aliases: ['lokman', 'লুকমান'] },
  { number: 32, name: 'As-Sajdah', aliases: ['sajdah', 'sajda', 'সাজদাহ', 'সিজদাহ'] },
  { number: 33, name: 'Al-Ahzab', aliases: ['ahzab', 'আহযাব'] },
  { number: 34, name: 'Saba', aliases: ['সাবা'] },
  { number: 35, name: 'Fatir', aliases: ['ফাতির'] },
  { number: 36, name: 'Ya-Sin', aliases: ['yasin', 'yaasin', 'ইয়াসিন', 'ইয়াসিন'] },
  { number: 37, name: 'As-Saffat', aliases: ['saffat', 'সাফফাত'] },
  { number: 38, name: 'Sad', aliases: ['saad', 'সাদ'] },
  { number: 39, name: 'Az-Zumar', aliases: ['zumar', 'যুমার'] },
  { number: 40, name: 'Ghafir', aliases: ['mumin', 'গাফির', 'মুমিন'] },
  { number: 41, name: 'Fussilat', aliases: ['ফুসসিলাত'] },
  { number: 42, name: 'Ash-Shuraa', aliases: ['shura', 'shuraa', 'শুরা'] },
  { number: 43, name: 'Az-Zukhruf', aliases: ['zukhruf', 'যুখরুফ'] },
  { number: 44, name: 'Ad-Dukhan', aliases: ['dukhan', 'দুখান'] },
  { number: 45, name: 'Al-Jathiyah', aliases: ['jathiyah', 'jasiyah', 'জাসিয়া'] },
  { number: 46, name: 'Al-Ahqaf', aliases: ['ahqaf', 'আহকাফ'] },
  { number: 47, name: 'Muhammad', aliases: ['মুহাম্মদ'] },
  { number: 48, name: 'Al-Fath', aliases: ['fath', 'ফাতহ'] },
  { number: 49, name: 'Al-Hujurat', aliases: ['hujurat', 'হুজুরাত'] },
  { number: 50, name: 'Qaf', aliases: ['কাফ'] },
  { number: 51, name: 'Adh-Dhariyat', aliases: ['dhariyat', 'zariyat', 'যারিয়াত'] },
  { number: 52, name: 'At-Tur', aliases: ['tur', 'তুর'] },
  { number: 53, name: 'An-Najm', aliases: ['najm', 'নাজম'] },
  { number: 54, name: 'Al-Qamar', aliases: ['qamar', 'কামার'] },
  { number: 55, name: 'Ar-Rahman', aliases: ['rahman', 'রহমান'] },
  { number: 56, name: 'Al-Waqiah', aliases: ['waqiah', 'waqia', 'ওয়াকিয়া', 'ওয়াকিয়া'] },
  { number: 57, name: 'Al-Hadid', aliases: ['hadid', 'হাদিদ'] },
  { number: 58, name: 'Al-Mujadilah', aliases: ['mujadilah', 'মুজাদালাহ'] },
  { number: 59, name: 'Al-Hashr', aliases: ['hashr', 'হাশর'] },
  { number: 60, name: 'Al-Mumtahanah', aliases: ['mumtahanah', 'মুমতাহিনা'] },
  { number: 61, name: 'As-Saff', aliases: ['saff', 'সফ'] },
  { number: 62, name: 'Al-Jumuah', aliases: ['jumuah', 'jummah', 'জুমআ', 'জুমা'] },
  { number: 63, name: 'Al-Munafiqun', aliases: ['munafiqun', 'মুনাফিকুন'] },
  { number: 64, name: 'At-Taghabun', aliases: ['taghabun', 'তাগাবুন'] },
  { number: 65, name: 'At-Talaq', aliases: ['talaq', 'তালাক'] },
  { number: 66, name: 'At-Tahrim', aliases: ['tahrim', 'তাহরিম'] },
  { number: 67, name: 'Al-Mulk', aliases: ['mulk', 'মূলক', 'মুলক'] },
  { number: 68, name: 'Al-Qalam', aliases: ['qalam', 'কলম'] },
  { number: 69, name: 'Al-Haqqah', aliases: ['haqqah', 'হাক্কাহ'] },
  { number: 70, name: 'Al-Maarij', aliases: ['maarij', 'মাআরিজ'] },
  { number: 71, name: 'Nuh', aliases: ['nooh', 'নুহ'] },
  { number: 72, name: 'Al-Jinn', aliases: ['jinn', 'জিন'] },
  { number: 73, name: 'Al-Muzzammil', aliases: ['muzzammil', 'মুযযাম্মিল'] },
  { number: 74, name: 'Al-Muddaththir', aliases: ['muddaththir', 'muddassir', 'মুদ্দাসসির'] },
  { number: 75, name: 'Al-Qiyamah', aliases: ['qiyamah', 'qiyama', 'কিয়ামাহ', 'কিয়ামত'] },
  { number: 76, name: 'Al-Insan', aliases: ['insan', 'dahr', 'ইনসান', 'দাহর'] },
  { number: 77, name: 'Al-Mursalat', aliases: ['mursalat', 'মুরসালাত'] },
  { number: 78, name: 'An-Naba', aliases: ['naba', 'নাবা'] },
  { number: 79, name: 'An-Naziat', aliases: ['naziyat', 'নাযিয়াত'] },
  { number: 80, name: 'Abasa', aliases: ['আবাসা'] },
  { number: 81, name: 'At-Takwir', aliases: ['takwir', 'তাকভীর'] },
  { number: 82, name: 'Al-Infitar', aliases: ['infitar', 'ইনফিতার'] },
  { number: 83, name: 'Al-Mutaffifin', aliases: ['mutaffifin', 'মুতাফফিফিন'] },
  { number: 84, name: 'Al-Inshiqaq', aliases: ['inshiqaq', 'ইনশিকাক'] },
  { number: 85, name: 'Al-Buruj', aliases: ['buruj', 'বুরুজ'] },
  { number: 86, name: 'At-Tariq', aliases: ['tariq', 'তারিক'] },
  { number: 87, name: 'Al-Ala', aliases: ['ala', 'আলা'] },
  { number: 88, name: 'Al-Ghashiyah', aliases: ['ghashiyah', 'গাশিয়াহ'] },
  { number: 89, name: 'Al-Fajr', aliases: ['fajr', 'ফজর'] },
  { number: 90, name: 'Al-Balad', aliases: ['balad', 'বালাদ'] },
  { number: 91, name: 'Ash-Shams', aliases: ['shams', 'শামস'] },
  { number: 92, name: 'Al-Layl', aliases: ['layl', 'lail', 'লাইল'] },
  { number: 93, name: 'Ad-Duhaa', aliases: ['duha', 'duhaa', 'দুহা'] },
  { number: 94, name: 'Ash-Sharh', aliases: ['sharh', 'inshirah', 'ইনশিরাহ', 'শারহ'] },
  { number: 95, name: 'At-Tin', aliases: ['tin', 'তীন'] },
  { number: 96, name: 'Al-Alaq', aliases: ['alaq', 'আলাক'] },
  { number: 97, name: 'Al-Qadr', aliases: ['qadr', 'কদর'] },
  { number: 98, name: 'Al-Bayyinah', aliases: ['bayyinah', 'বাইয়্যিনাহ'] },
  { number: 99, name: 'Az-Zalzalah', aliases: ['zalzalah', 'zilzal', 'যিলযাল'] },
  { number: 100, name: 'Al-Adiyat', aliases: ['adiyat', 'আদিয়াত'] },
  { number: 101, name: 'Al-Qariah', aliases: ['qariah', 'কারিয়াহ'] },
  { number: 102, name: 'At-Takathur', aliases: ['takathur', 'তাকাসুর'] },
  { number: 103, name: 'Al-Asr', aliases: ['asr', 'আসর'] },
  { number: 104, name: 'Al-Humazah', aliases: ['humazah', 'হুমাযাহ'] },
  { number: 105, name: 'Al-Fil', aliases: ['fil', 'ফীল'] },
  { number: 106, name: 'Quraysh', aliases: ['quraish', 'কুরাইশ'] },
  { number: 107, name: 'Al-Maun', aliases: ['maun', 'মাউন'] },
  { number: 108, name: 'Al-Kawthar', aliases: ['kawthar', 'kausar', 'কাউসার'] },
  { number: 109, name: 'Al-Kafirun', aliases: ['kafirun', 'কাফিরুন'] },
  { number: 110, name: 'An-Nasr', aliases: ['nasr', 'নাসর'] },
  { number: 111, name: 'Al-Masad', aliases: ['masad', 'lahab', 'লাহাব', 'মাসাদ'] },
  { number: 112, name: 'Al-Ikhlas', aliases: ['ikhlas', 'ইখলাস'] },
  { number: 113, name: 'Al-Falaq', aliases: ['falaq', 'ফালাক'] },
  { number: 114, name: 'An-Nas', aliases: ['nas', 'নাস'] },
];

const SURAH_ALIASES = SURAH_LIST.flatMap((surah) =>
  [surah.name, ...surah.aliases].map((alias) => ({ alias, surah })),
).sort((a, b) => b.alias.length - a.alias.length);

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
      const row = await this.geminiKeyService.getNextKey();
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

  private normalizeSurahText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9\u0980-\u09ff\u0600-\u06ff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private resolveSurah(input: Record<string, string>): SurahMeta | null {
    const numberValue = Number(input.surahNumber);

    if (Number.isInteger(numberValue)) {
      const surah = SURAH_LIST.find((item) => item.number === numberValue);
      if (surah) return surah;
    }

    const rawName = input.surahName?.trim();
    if (!rawName) return null;

    const normalizedName = this.normalizeSurahText(rawName);
    const directNumber = Number(normalizedName);

    if (Number.isInteger(directNumber)) {
      const surah = SURAH_LIST.find((item) => item.number === directNumber);
      if (surah) return surah;
    }

    const aliasMatch = SURAH_ALIASES.find(({ alias }) => {
      const normalizedAlias = this.normalizeSurahText(alias);
      return normalizedName === normalizedAlias || normalizedName.includes(normalizedAlias);
    });

    return aliasMatch?.surah ?? null;
  }

  private buildQuranAudioUrl(surahNumber: number): string {
    return `https://cdn.islamic.network/quran/audio-surah/${QURAN_AUDIO_RECITER.bitrate}/${QURAN_AUDIO_RECITER.edition}/${surahNumber}.mp3`;
  }

  private getQuranRecitation(input: Record<string, string>): QuranRecitationResult {
    const surah = this.resolveSurah(input);

    if (!surah) {
      return {
        reply:
          'Which surah would you like me to recite? For example: Al-Fatihah, Ya-Sin, Ar-Rahman, or Al-Mulk.',
      };
    }

    return {
      reply: `Here is Surah ${surah.name} recited by ${QURAN_AUDIO_RECITER.name}.`,
      media: {
        type: 'quran_recitation',
        surahNumber: surah.number,
        surahName: surah.name,
        reciterName: QURAN_AUDIO_RECITER.name,
        audioUrl: this.buildQuranAudioUrl(surah.number),
        source: QURAN_AUDIO_RECITER.source,
      },
    };
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
