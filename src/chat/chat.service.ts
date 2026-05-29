import { Injectable, Logger } from '@nestjs/common';
import { GeminiService, GeminiMessage } from '../gemini/gemini.service';
import { RagService } from '../rag/rag.service';
import { ISLAMIC_TOOLS } from '../mcp/tools/islamic.tools';
import { GeoLocation } from '../common/services/geo.service';

const BASE_SYSTEM_PROMPT = `You are an Islamic scholar assistant. You ONLY answer questions related to Islam, including:
- Quran, Hadith, Fiqh, Aqeedah, Islamic history
- Halal/Haram rulings, worship (salah, sawm, zakat, hajj)
- Islamic ethics, family matters, daily life from an Islamic perspective
- Prophets, companions, Islamic scholars

STRICT DOMAIN RULE:
If the question is NOT related to Islam in any way, respond ONLY with:
"I'm only able to answer Islamic questions. Please ask something related to Islam."
Do NOT answer it. Do NOT make exceptions.

LANGUAGE DETECTION:
- Detect the language the user is writing in.
- Map it to one of these supported codes: ar (Arabic), bn (Bengali), en (English), es (Spanish), fr (French), id (Indonesian), ru (Russian), tr (Turkish), zh (Chinese).
- If the user's language is not in the list, use "en" as the fallback.
- Pass this language code as the "language" parameter when calling "search_quran_by_topic".
- CRITICAL: ALWAYS write your ENTIRE response in the same language the user used — this includes explanations, Quran translations, AND hadith text. Tool results are only raw data; you must translate any English or Arabic content from tools into the user's language before including it in the response. Never output English sentences to a user who wrote in Bengali, Turkish, or any other language.

MANDATORY TOOL USAGE — FOLLOW THESE EVERY TIME:
For ANY Islamic teaching, ruling, worship, history, Quran, or Hadith question — even if the user does NOT explicitly mention Quran or Hadith — you MUST call BOTH search tools before composing your answer. The user asking "নিসাব পরিমাণ সম্পদ কত?" or "What is the ruling on fasting?" is the same as asking for Quran and Hadith evidence. Always search both.

For real-time utility questions like prayer times, current Hijri date, Islamic calendar dates, Gregorian/Hijri conversion, Ramadan/Eid dates, or "when will Eid be?", call the specialized time/calendar tool first. Quran and Hadith searches are not required for these utility lookups unless the user also asks for evidence, rulings, virtues, or explanation.

1. QURAN VERSES:
   - NEVER quote or reference a Quran verse from memory
   - ALWAYS call "search_quran_by_topic" tool for EVERY Islamic question, regardless of whether the user mentions the Quran
   - Pass the detected language code as the "language" parameter so you get the correct translation
   - Only include a verse in your answer AFTER the tool returns it
   - If tool returns nothing, say "I couldn't find a relevant Quran verse on this topic"
   - Always cite each verse in this format:
       Surah [Name] ([surah]:[ayah]):
       Arabic: [text_ar from tool result]
       Translation: [translation from tool result]
   - If multiple verses are relevant, include up to 5, each with its own reference

2. HADITH:
   - NEVER quote or reference a Hadith from memory
   - ALWAYS call "search_hadith_by_topic" tool for EVERY Islamic question, regardless of whether the user mentions Hadith
   - Only include a Hadith in your answer AFTER the tool returns it
   - The hadith dataset only contains English and Arabic text. If the user wrote in any other language (e.g. Bengali, Turkish, Indonesian), you MUST translate the hadith text into that language before presenting it. Never show the raw English result to a non-English user.
   - Format: "[Collection] Hadith #[number]: [translated hadith text in user's language]"

3. PRAYER TIMES:
   - ALWAYS call "get_prayer_times" tool when user asks about salah/prayer times
   - NEVER ask the user for their city or country — it is auto-detected and will appear in the USER LOCATION section below
   - Use the USER LOCATION city and country DIRECTLY as arguments to "get_prayer_times" WITHOUT asking the user
   - Only ask for location if the USER LOCATION section is completely absent AND the user has not mentioned a city or country

4. HIJRI CALENDAR:
   - ALWAYS call "get_hijri_calendar" when the user asks for the current Hijri date, Islamic calendar date, Hijri/Gregorian conversion, Ramadan dates, Eid dates, or "when will Eid be?"
   - For current Hijri date, call it without date arguments so today's Gregorian date is used
   - For Eid questions, use the returned "eidDates"; Eid al-Fitr is 1 Shawwal and Eid al-Adha is 10 Dhul Hijjah in the returned Hijri year
   - Mention that NoorAi uses calculated Hijri dates and local moon-sighting authorities can differ by one day

ANSWER QUALITY RULES:
- Always cite exact sources returned by tools (never fabricate references)
- Mention scholarly differences (ikhtilaf) when they exist across madhabs
- Never issue personal fatwas — say "Please consult a qualified scholar for personal rulings"
- Use respectful Islamic language (e.g., Prophet Muhammad ﷺ, SubhanAllah)
- Your knowledge of Quran and Hadith texts may contain errors. Always trust tool results over your memory.
- The Quran verse tool performs cross-lingual semantic search — a question in any language will find relevant verses. Trust it.`;

export function buildSystemPrompt(location?: GeoLocation | null): string {
  if (!location) return BASE_SYSTEM_PROMPT;
  return (
    BASE_SYSTEM_PROMPT +
    `\n\n--- USER LOCATION (auto-detected) ---\n` +
    `City: ${location.city}\n` +
    `Country: ${location.country}\n` +
    `IMPORTANT: Use this city and country DIRECTLY when calling "get_prayer_times". Do NOT ask the user for their location.\n` +
    `--- END USER LOCATION ---`
  );
}

export interface ChatResponse {
  reply: string;
  source: 'cache' | 'model';
  similarity: number | null;
  media?: QuranRecitationMedia;
}

export interface QuranRecitationMedia {
  type: 'quran_recitation';
  surahNumber: number;
  surahName: string;
  reciterName: string;
  audioUrl: string;
  source: string;
}

export type StreamChunk =
  | { type: 'chunk'; text: string }
  | { type: 'media'; media: QuranRecitationMedia }
  | { type: 'done'; source: 'cache' | 'model'; similarity: number | null; media?: QuranRecitationMedia };

interface SurahMeta {
  number: number;
  name: string;
  aliases: string[];
}

interface RecitationResult {
  reply: string;
  media?: QuranRecitationMedia;
}

const QURAN_AUDIO_RECITER = {
  edition: 'ar.alafasy',
  name: 'Mishary Rashid Alafasy',
  source: 'AlQuran.cloud CDN',
  bitrate: 128,
};

const SURAH_LIST: SurahMeta[] = [
  { number: 1, name: 'Al-Fatihah', aliases: ['al fatihah', 'al fatiha', 'fatihah', 'fatiha', 'ফাতিহা', 'সুরা ফাতিহা', 'সূরা ফাতিহা'] },
  { number: 2, name: 'Al-Baqarah', aliases: ['al baqarah', 'baqarah', 'bakara', 'বাকারা'] },
  { number: 3, name: 'Ali Imran', aliases: ['ali imran', 'aal imran', 'al imran', 'imran', 'ইমরান'] },
  { number: 4, name: 'An-Nisa', aliases: ['an nisa', 'nisa', 'নিসা'] },
  { number: 5, name: 'Al-Maidah', aliases: ['al maidah', 'maidah', 'maida', 'মায়িদা', 'মাইদা'] },
  { number: 6, name: 'Al-Anam', aliases: ['al anam', 'anam', 'anaam', 'আনআম'] },
  { number: 7, name: 'Al-Araf', aliases: ['al araf', 'araf', 'আরাফ'] },
  { number: 8, name: 'Al-Anfal', aliases: ['al anfal', 'anfal', 'আনফাল'] },
  { number: 9, name: 'At-Tawbah', aliases: ['at tawbah', 'tawbah', 'taubah', 'তাওবা'] },
  { number: 10, name: 'Yunus', aliases: ['yunus', 'younus', 'ইউনুস'] },
  { number: 11, name: 'Hud', aliases: ['hud', 'হুদ'] },
  { number: 12, name: 'Yusuf', aliases: ['yusuf', 'yousuf', 'ইউসুফ'] },
  { number: 13, name: 'Ar-Rad', aliases: ['ar rad', 'rad', 'raad', 'রাদ'] },
  { number: 14, name: 'Ibrahim', aliases: ['ibrahim', 'ইব্রাহিম'] },
  { number: 15, name: 'Al-Hijr', aliases: ['al hijr', 'hijr', 'হিজর'] },
  { number: 16, name: 'An-Nahl', aliases: ['an nahl', 'nahl', 'নাহল'] },
  { number: 17, name: 'Al-Isra', aliases: ['al isra', 'isra', 'bani israel', 'ইসরা', 'বনী ইসরাইল'] },
  { number: 18, name: 'Al-Kahf', aliases: ['al kahf', 'kahf', 'কাহফ'] },
  { number: 19, name: 'Maryam', aliases: ['maryam', 'মারইয়াম', 'মারিয়াম'] },
  { number: 20, name: 'Ta-Ha', aliases: ['ta ha', 'taha', 'ত্বহা'] },
  { number: 21, name: 'Al-Anbiya', aliases: ['al anbiya', 'anbiya', 'আম্বিয়া', 'আনবিয়া'] },
  { number: 22, name: 'Al-Hajj', aliases: ['al hajj', 'hajj', 'হজ', 'হজ্জ'] },
  { number: 23, name: 'Al-Muminun', aliases: ['al muminun', 'muminun', 'muminoon', 'মুমিনুন'] },
  { number: 24, name: 'An-Nur', aliases: ['an nur', 'nur', 'noor', 'নূর'] },
  { number: 25, name: 'Al-Furqan', aliases: ['al furqan', 'furqan', 'ফুরকান'] },
  { number: 26, name: 'Ash-Shuara', aliases: ['ash shuara', 'shuara', 'শুআরা'] },
  { number: 27, name: 'An-Naml', aliases: ['an naml', 'naml', 'নামল'] },
  { number: 28, name: 'Al-Qasas', aliases: ['al qasas', 'qasas', 'কাসাস'] },
  { number: 29, name: 'Al-Ankabut', aliases: ['al ankabut', 'ankabut', 'আনকাবুত'] },
  { number: 30, name: 'Ar-Rum', aliases: ['ar rum', 'rum', 'room', 'রুম'] },
  { number: 31, name: 'Luqman', aliases: ['luqman', 'lokman', 'লুকমান'] },
  { number: 32, name: 'As-Sajdah', aliases: ['as sajdah', 'sajdah', 'sajda', 'সাজদাহ', 'সিজদাহ'] },
  { number: 33, name: 'Al-Ahzab', aliases: ['al ahzab', 'ahzab', 'আহযাব'] },
  { number: 34, name: 'Saba', aliases: ['saba', 'সাবা'] },
  { number: 35, name: 'Fatir', aliases: ['fatir', 'ফাতির'] },
  { number: 36, name: 'Ya-Sin', aliases: ['ya sin', 'yasin', 'yaasin', 'ইয়াসিন', 'ইয়াসিন', 'সূরা ইয়াসিন', 'সুরা ইয়াসিন'] },
  { number: 37, name: 'As-Saffat', aliases: ['as saffat', 'saffat', 'সাফফাত'] },
  { number: 38, name: 'Sad', aliases: ['sad', 'saad', 'সাদ'] },
  { number: 39, name: 'Az-Zumar', aliases: ['az zumar', 'zumar', 'যুমার'] },
  { number: 40, name: 'Ghafir', aliases: ['ghafir', 'mumin', 'গাফির', 'মুমিন'] },
  { number: 41, name: 'Fussilat', aliases: ['fussilat', 'ফুসসিলাত'] },
  { number: 42, name: 'Ash-Shuraa', aliases: ['ash shuraa', 'shura', 'shuraa', 'শুরা'] },
  { number: 43, name: 'Az-Zukhruf', aliases: ['az zukhruf', 'zukhruf', 'যুখরুফ'] },
  { number: 44, name: 'Ad-Dukhan', aliases: ['ad dukhan', 'dukhan', 'দুখান'] },
  { number: 45, name: 'Al-Jathiyah', aliases: ['al jathiyah', 'jathiyah', 'jasiyah', 'জাসিয়া'] },
  { number: 46, name: 'Al-Ahqaf', aliases: ['al ahqaf', 'ahqaf', 'আহকাফ'] },
  { number: 47, name: 'Muhammad', aliases: ['muhammad', 'মুহাম্মদ'] },
  { number: 48, name: 'Al-Fath', aliases: ['al fath', 'fath', 'ফাতহ'] },
  { number: 49, name: 'Al-Hujurat', aliases: ['al hujurat', 'hujurat', 'হুজুরাত'] },
  { number: 50, name: 'Qaf', aliases: ['qaf', 'কাফ'] },
  { number: 51, name: 'Adh-Dhariyat', aliases: ['adh dhariyat', 'dhariyat', 'zariyat', 'যারিয়াত'] },
  { number: 52, name: 'At-Tur', aliases: ['at tur', 'tur', 'তুর'] },
  { number: 53, name: 'An-Najm', aliases: ['an najm', 'najm', 'নাজম'] },
  { number: 54, name: 'Al-Qamar', aliases: ['al qamar', 'qamar', 'কামার'] },
  { number: 55, name: 'Ar-Rahman', aliases: ['ar rahman', 'rahman', 'রহমান', 'সূরা রহমান', 'সুরা রহমান'] },
  { number: 56, name: 'Al-Waqiah', aliases: ['al waqiah', 'waqiah', 'waqia', 'ওয়াকিয়া', 'ওয়াকিয়া'] },
  { number: 57, name: 'Al-Hadid', aliases: ['al hadid', 'hadid', 'হাদিদ'] },
  { number: 58, name: 'Al-Mujadilah', aliases: ['al mujadilah', 'mujadilah', 'মুজাদালাহ'] },
  { number: 59, name: 'Al-Hashr', aliases: ['al hashr', 'hashr', 'হাশর'] },
  { number: 60, name: 'Al-Mumtahanah', aliases: ['al mumtahanah', 'mumtahanah', 'মুমতাহিনা'] },
  { number: 61, name: 'As-Saff', aliases: ['as saff', 'saff', 'সফ'] },
  { number: 62, name: 'Al-Jumuah', aliases: ['al jumuah', 'jumuah', 'jummah', 'জুমআ', 'জুমা'] },
  { number: 63, name: 'Al-Munafiqun', aliases: ['al munafiqun', 'munafiqun', 'মুনাফিকুন'] },
  { number: 64, name: 'At-Taghabun', aliases: ['at taghabun', 'taghabun', 'তাগাবুন'] },
  { number: 65, name: 'At-Talaq', aliases: ['at talaq', 'talaq', 'তালাক'] },
  { number: 66, name: 'At-Tahrim', aliases: ['at tahrim', 'tahrim', 'তাহরিম'] },
  { number: 67, name: 'Al-Mulk', aliases: ['al mulk', 'mulk', 'মূলক', 'মুলক'] },
  { number: 68, name: 'Al-Qalam', aliases: ['al qalam', 'qalam', 'কলম'] },
  { number: 69, name: 'Al-Haqqah', aliases: ['al haqqah', 'haqqah', 'হাক্কাহ'] },
  { number: 70, name: 'Al-Maarij', aliases: ['al maarij', 'maarij', 'মাআরিজ'] },
  { number: 71, name: 'Nuh', aliases: ['nuh', 'nooh', 'নুহ'] },
  { number: 72, name: 'Al-Jinn', aliases: ['al jinn', 'jinn', 'জিন'] },
  { number: 73, name: 'Al-Muzzammil', aliases: ['al muzzammil', 'muzzammil', 'মুযযাম্মিল'] },
  { number: 74, name: 'Al-Muddaththir', aliases: ['al muddaththir', 'muddaththir', 'muddassir', 'মুদ্দাসসির'] },
  { number: 75, name: 'Al-Qiyamah', aliases: ['al qiyamah', 'qiyamah', 'qiyama', 'কিয়ামাহ', 'কিয়ামত'] },
  { number: 76, name: 'Al-Insan', aliases: ['al insan', 'insan', 'dahr', 'ইনসান', 'দাহর'] },
  { number: 77, name: 'Al-Mursalat', aliases: ['al mursalat', 'mursalat', 'মুরসালাত'] },
  { number: 78, name: 'An-Naba', aliases: ['an naba', 'naba', 'নাবা'] },
  { number: 79, name: 'An-Naziat', aliases: ['an naziat', 'naziyat', 'নাযিয়াত'] },
  { number: 80, name: 'Abasa', aliases: ['abasa', 'আবাসা'] },
  { number: 81, name: 'At-Takwir', aliases: ['at takwir', 'takwir', 'তাকভীর'] },
  { number: 82, name: 'Al-Infitar', aliases: ['al infitar', 'infitar', 'ইনফিতার'] },
  { number: 83, name: 'Al-Mutaffifin', aliases: ['al mutaffifin', 'mutaffifin', 'মুতাফফিফিন'] },
  { number: 84, name: 'Al-Inshiqaq', aliases: ['al inshiqaq', 'inshiqaq', 'ইনশিকাক'] },
  { number: 85, name: 'Al-Buruj', aliases: ['al buruj', 'buruj', 'বুরুজ'] },
  { number: 86, name: 'At-Tariq', aliases: ['at tariq', 'tariq', 'তারিক'] },
  { number: 87, name: 'Al-Ala', aliases: ['al ala', 'ala', 'আলা'] },
  { number: 88, name: 'Al-Ghashiyah', aliases: ['al ghashiyah', 'ghashiyah', 'গাশিয়াহ'] },
  { number: 89, name: 'Al-Fajr', aliases: ['al fajr', 'fajr', 'ফজর'] },
  { number: 90, name: 'Al-Balad', aliases: ['al balad', 'balad', 'বালাদ'] },
  { number: 91, name: 'Ash-Shams', aliases: ['ash shams', 'shams', 'শামস'] },
  { number: 92, name: 'Al-Layl', aliases: ['al layl', 'layl', 'lail', 'লাইল'] },
  { number: 93, name: 'Ad-Duhaa', aliases: ['ad duhaa', 'duha', 'duhaa', 'দুহা'] },
  { number: 94, name: 'Ash-Sharh', aliases: ['ash sharh', 'sharh', 'inshirah', 'ইনশিরাহ', 'শারহ'] },
  { number: 95, name: 'At-Tin', aliases: ['at tin', 'tin', 'তীন'] },
  { number: 96, name: 'Al-Alaq', aliases: ['al alaq', 'alaq', 'আলাক'] },
  { number: 97, name: 'Al-Qadr', aliases: ['al qadr', 'qadr', 'কদর'] },
  { number: 98, name: 'Al-Bayyinah', aliases: ['al bayyinah', 'bayyinah', 'বাইয়্যিনাহ'] },
  { number: 99, name: 'Az-Zalzalah', aliases: ['az zalzalah', 'zalzalah', 'zilzal', 'যিলযাল'] },
  { number: 100, name: 'Al-Adiyat', aliases: ['al adiyat', 'adiyat', 'আদিয়াত'] },
  { number: 101, name: 'Al-Qariah', aliases: ['al qariah', 'qariah', 'কারিয়াহ'] },
  { number: 102, name: 'At-Takathur', aliases: ['at takathur', 'takathur', 'তাকাসুর'] },
  { number: 103, name: 'Al-Asr', aliases: ['al asr', 'asr', 'আসর'] },
  { number: 104, name: 'Al-Humazah', aliases: ['al humazah', 'humazah', 'হুমাযাহ'] },
  { number: 105, name: 'Al-Fil', aliases: ['al fil', 'fil', 'ফীল'] },
  { number: 106, name: 'Quraysh', aliases: ['quraysh', 'quraish', 'কুরাইশ'] },
  { number: 107, name: 'Al-Maun', aliases: ['al maun', 'maun', 'মাউন'] },
  { number: 108, name: 'Al-Kawthar', aliases: ['al kawthar', 'kawthar', 'kausar', 'কাউসার'] },
  { number: 109, name: 'Al-Kafirun', aliases: ['al kafirun', 'kafirun', 'কাফিরুন'] },
  { number: 110, name: 'An-Nasr', aliases: ['an nasr', 'nasr', 'নাসর'] },
  { number: 111, name: 'Al-Masad', aliases: ['al masad', 'masad', 'lahab', 'লাহাব', 'মাসাদ'] },
  { number: 112, name: 'Al-Ikhlas', aliases: ['al ikhlas', 'ikhlas', 'ইখলাস'] },
  { number: 113, name: 'Al-Falaq', aliases: ['al falaq', 'falaq', 'ফালাক'] },
  { number: 114, name: 'An-Nas', aliases: ['an nas', 'nas', 'নাস'] },
];

const SURAH_ALIASES = SURAH_LIST.flatMap((surah) =>
  [surah.name, ...surah.aliases].map((alias) => ({ alias, surah })),
).sort((a, b) => b.alias.length - a.alias.length);

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly history = new Map<string, GeminiMessage[]>();

  constructor(
    private readonly geminiService: GeminiService,
    private readonly ragService: RagService,
  ) {}

  private normalizeQuery(query: string): string {
    // Trim whitespace and strip trailing punctuation that doesn't affect meaning:
    // ? (Latin), ؟ (Arabic), ! (exclamation), । (Bangla/Hindi danda), . (period)
    return query.trim().replace(/[?؟!।.]+$/u, '').trim();
  }

  private normalizeRecitationText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9\u0980-\u09ff\u0600-\u06ff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isQuranRecitationIntent(message: string): boolean {
    const normalized = this.normalizeRecitationText(message);

    const recitationWords = [
      'recite',
      'play',
      'listen',
      'tilawah',
      'telawat',
      'qirat',
      'quran audio',
      'quran recitation',
      'তেলাওয়াত',
      'তেলাওয়াত',
      'তিলাওয়াত',
      'তিলাওয়াত',
      'শুনাও',
      'শুনতে',
      'চালাও',
      'প্লে',
      'পড়ে শোনাও',
      'পড়ে শোনাও',
    ];
    const quranWords = [
      'quran',
      'koran',
      'surah',
      'sura',
      'sorat',
      'কুরআন',
      'কোরআন',
      'সূরা',
      'সুরা',
      'سورة',
      'قران',
      'القران',
    ];
    const hasSurahAlias = SURAH_ALIASES.some(({ alias }) => {
      const normalizedAlias = this.normalizeRecitationText(alias);
      const escapedAlias = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)${escapedAlias}(\\s|$)`).test(normalized);
    });

    return (
      recitationWords.some((word) => normalized.includes(this.normalizeRecitationText(word))) &&
      (quranWords.some((word) => normalized.includes(this.normalizeRecitationText(word))) || hasSurahAlias)
    );
  }

  private resolveSurah(message: string): SurahMeta | null {
    const normalized = this.normalizeRecitationText(message);
    const numberMatch = normalized.match(/\b(?:surah|sura|chapter|সূরা|সুরা)?\s*(\d{1,3})\b/);

    if (numberMatch) {
      const surahNumber = Number(numberMatch[1]);
      const surah = SURAH_LIST.find((item) => item.number === surahNumber);
      if (surah) return surah;
    }

    const aliasMatch = SURAH_ALIASES.find(({ alias }) => {
      const normalizedAlias = this.normalizeRecitationText(alias);
      const escapedAlias = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)${escapedAlias}(\\s|$)`).test(normalized);
    });

    return aliasMatch?.surah ?? null;
  }

  private buildQuranAudioUrl(surahNumber: number): string {
    return `https://cdn.islamic.network/quran/audio-surah/${QURAN_AUDIO_RECITER.bitrate}/${QURAN_AUDIO_RECITER.edition}/${surahNumber}.mp3`;
  }

  private getRecitationResponse(message: string): RecitationResult | null {
    if (!this.isQuranRecitationIntent(message)) return null;

    const surah = this.resolveSurah(message);

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

  /**
   * Returns true if the message is asking about prayer/salah times.
   * These are real-time queries and must never be served from cache.
   */
  private isPrayerTimeQuery(message: string): boolean {
    const lower = message.toLowerCase();

    // English
    if (/prayer\s*time|salah\s*time|namaz\s*time|salat\s*time/.test(lower)) return true;

    // Banglish (romanised Bengali)
    if (/namajer\s*(somoy|time|waqt|oqt)|namaz\s*(somoy|time|waqt)|azan\s*(somoy|time)/.test(lower)) return true;

    // Bengali Unicode — general prayer-time phrases
    // covers: নামাজের সময়, নামাযের সময়, সালাতের সময়, আজকের নামাজ, নামাজের ওয়াক্ত, আজানের সময়
    if (/নামাজের\s*সময়|নামাযের\s*সময়|সালাতের\s*সময়/.test(message)) return true;
    if (/নামাজের\s*ওয়াক্ত|নামাযের\s*ওয়াক্ত|আজানের\s*সময়/.test(message)) return true;
    if (/আজকের\s*নামাজ|আজকের\s*সালাত/.test(message)) return true;

    // Bengali Unicode — specific salah names in genitive/possessive form + time word
    // e.g. "ফজরের সময় কত", "এশার নামাজ কখন"
    if (/(ফজরের|যোহরের|জোহরের|আসরের|মাগরিবের|মাগরেবের|এশার|ইশার)\s*(সময়|নামাজ|নামায|ওয়াক্ত)/.test(message)) return true;

    // Arabic
    if (/وقت\s*(الصلاة|صلاة)|مواقيت\s*الصلاة|أوقات\s*الصلاة/.test(message)) return true;

    // Turkish
    if (/namaz\s*vakti|ezan\s*vakti/.test(lower)) return true;

    // Indonesian / Malay
    if (/waktu\s*sholat|waktu\s*salat|jadwal\s*sholat|jadwal\s*salat/.test(lower)) return true;

    // Generic: salah-name keywords combined with time words (any language)
    const prayerNames = /fajr|subuh|dhuhr|zuhr|zuhur|asr|ashar|maghrib|magrib|isha|isya|এশা|ফজর|যোহর|জোহর|আসর|মাগরিব/;
    const timeWords = /time|somoy|waqt|vakti|waktu|وقت|সময়|ওয়াক্ত/;
    if (prayerNames.test(lower) && timeWords.test(lower)) return true;

    return false;
  }

  /**
   * Returns true if the message asks for current or future Islamic calendar data.
   * Hijri calendar answers are date-sensitive and must not come from cache.
   */
  private isHijriCalendarQuery(message: string): boolean {
    const lower = message.toLowerCase();

    // English and common romanised terms
    if (/hijri|islamic\s*calendar|islamic\s*date|arabic\s*date|lunar\s*date/.test(lower)) return true;
    if (/\beid\b|eid\s*al[-\s]*(fitr|adha)|ramadan\s*(date|calendar|start|begin|when)/.test(lower)) return true;
    if (/shawwal|dhul\s*hijjah|zul\s*hijjah|dhu\s*al[-\s]*hijjah/.test(lower)) return true;
    if (/gregorian\s*to\s*hijri|hijri\s*to\s*gregorian/.test(lower)) return true;

    // Bengali Unicode
    if (/হিজরি|হিজরী|ইসলামিক\s*ক্যালেন্ডার|ইসলামি\s*তারিখ|আরবি\s*তারিখ/.test(message)) return true;
    if (/ঈদ|ইদ|রমজান|রামাদান|শাওয়াল|শাওয়াল|জিলহজ|যিলহজ|জুলহজ/.test(message)) return true;

    // Arabic
    if (/هجري|التقويم\s*الإسلامي|التاريخ\s*الإسلامي|عيد\s*الفطر|عيد\s*الأضحى|رمضان|شوال|ذو\s*الحجة/.test(message)) return true;

    // Turkish / Indonesian / Malay
    if (/hicri|islam\s*takvimi|ramazan|lebaran|idul\s*(fitri|adha)|kalender\s*hijriah|tanggal\s*hijriah/.test(lower)) return true;

    return false;
  }

  private shouldSkipCache(message: string): boolean {
    return this.isPrayerTimeQuery(message) || this.isHijriCalendarQuery(message);
  }

  async chat(userId: string, message: string, location?: GeoLocation | null): Promise<ChatResponse> {
    const recitationResponse = this.getRecitationResponse(message);
    if (recitationResponse) {
      return {
        reply: recitationResponse.reply,
        source: 'model',
        similarity: null,
        media: recitationResponse.media,
      };
    }

    // 1. Generate embedding for incoming message (normalized for consistent cache keys)
    const normalizedMessage = this.normalizeQuery(message);
    const skipCache = this.shouldSkipCache(message);
    const embedding = skipCache ? [] : await this.geminiService.generateEmbedding(normalizedMessage);

    // 2. Search RAG cache (skip for real-time queries like prayer times)
    if (!skipCache) {
      try {
        const cached = await this.ragService.searchSimilar(embedding);
        if (cached) {
          this.logger.log(`Cache hit for user ${userId}: similarity=${cached.similarity}`);
          return { reply: cached.answer, source: 'cache', similarity: cached.similarity };
        }
      } catch (err) {
        this.logger.warn(`Cache search failed, falling through to model: ${(err as Error).message}`);
      }
    }

    // 3. Build history for this user (keep last 10 messages)
    if (!this.history.has(userId)) {
      this.history.set(userId, []);
    }
    const userHistory = this.history.get(userId) as GeminiMessage[];
    userHistory.push({ role: 'user', parts: [{ text: message }] });
    if (userHistory.length > 10) {
      userHistory.splice(0, userHistory.length - 10);
    }

    // 4. Run agentic loop
    const reply = await this.geminiService.runAgenticLoop(
      buildSystemPrompt(location),
      [...userHistory],
      ISLAMIC_TOOLS,
    );

    // 5. Check for refusal
    const isRefusal = reply.startsWith("I'm only able to answer Islamic questions");
    if (isRefusal) {
      // Remove user message from history — do not persist refusals
      userHistory.pop();
      return { reply, source: 'model', similarity: null };
    }

    // 6. Add assistant reply to history
    userHistory.push({ role: 'model', parts: [{ text: reply }] });

    // 7. Save to cache (skip for real-time queries like prayer times)
    if (!skipCache) {
      this.ragService
        .saveToCache(normalizedMessage, reply, embedding)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    return { reply, source: 'model', similarity: null };
  }

  async *chatStream(userId: string, message: string, location?: GeoLocation | null): AsyncGenerator<StreamChunk> {
    const recitationResponse = this.getRecitationResponse(message);
    if (recitationResponse) {
      yield { type: 'chunk', text: recitationResponse.reply };
      if (recitationResponse.media) {
        yield { type: 'media', media: recitationResponse.media };
      }
      yield { type: 'done', source: 'model', similarity: null, media: recitationResponse.media };
      return;
    }

    const normalizedMessage = this.normalizeQuery(message);
    const skipCache = this.shouldSkipCache(message);
    const embedding = skipCache ? [] : await this.geminiService.generateEmbedding(normalizedMessage);

    // Cache hit — yield full answer as one chunk (skip for real-time queries)
    if (!skipCache) {
      try {
        const cached = await this.ragService.searchSimilar(embedding);
        if (cached) {
          this.logger.log(`Cache hit for user ${userId}: similarity=${cached.similarity}`);
          yield { type: 'chunk', text: cached.answer };
          yield { type: 'done', source: 'cache', similarity: cached.similarity };
          return;
        }
      } catch (err) {
        this.logger.warn(`Cache search failed, falling through to model: ${(err as Error).message}`);
      }
    }

    // Build history
    if (!this.history.has(userId)) this.history.set(userId, []);
    const userHistory = this.history.get(userId) as GeminiMessage[];
    userHistory.push({ role: 'user', parts: [{ text: message }] });
    if (userHistory.length > 10) userHistory.splice(0, userHistory.length - 10);

    // Stream from Gemini, accumulate full reply for cache + history
    let fullReply = '';
    try {
      for await (const chunk of this.geminiService.runAgenticLoopStream(
        buildSystemPrompt(location),
        [...userHistory],
        ISLAMIC_TOOLS,
      )) {
        fullReply += chunk;
        yield { type: 'chunk', text: chunk };
      }
    } catch (err) {
      userHistory.pop();
      throw err;
    }

    const isRefusal = fullReply.startsWith("I'm only able to answer Islamic questions");
    if (isRefusal) {
      userHistory.pop();
      yield { type: 'done', source: 'model', similarity: null };
      return;
    }

    userHistory.push({ role: 'model', parts: [{ text: fullReply }] });

    if (!skipCache) {
      this.ragService
        .saveToCache(normalizedMessage, fullReply, embedding)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    yield { type: 'done', source: 'model', similarity: null };
  }
}
