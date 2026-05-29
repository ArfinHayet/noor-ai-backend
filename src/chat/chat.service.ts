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

For Quran recitation requests in ANY language, such as "recite Surah Yasin", "play Al-Fatihah", "সূরা রহমান তেলাওয়াত শুনাও", or "listen to Quran chapter 67", call "get_quran_recitation". Do not use Quran/Hadith search for pure audio playback requests unless the user also asks for explanation, translation, virtues, ruling, or evidence. If the user asks for recitation but does not specify a surah, call "get_quran_recitation" without arguments and use its clarification response.

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

5. QURAN RECITATION:
   - ALWAYS call "get_quran_recitation" when the user asks to recite, play, listen to, hear, or perform tilawah/qirat of a surah
   - Extract the surah name or number from the user's message in any language and pass it as "surahName" or "surahNumber"
   - If the tool returns media, briefly introduce the recitation in the user's language and do not invent another audio source

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

function isQuranRecitationMedia(value: unknown): value is QuranRecitationMedia {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as QuranRecitationMedia).type === 'quran_recitation' &&
    typeof (value as QuranRecitationMedia).audioUrl === 'string'
  );
}

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
    const agentResult = await this.geminiService.runAgenticLoop(
      buildSystemPrompt(location),
      [...userHistory],
      ISLAMIC_TOOLS,
    );
    const reply = agentResult.text;
    const media = agentResult.media?.find(isQuranRecitationMedia);

    // 5. Check for refusal
    const isRefusal = reply.startsWith("I'm only able to answer Islamic questions");
    if (isRefusal) {
      // Remove user message from history — do not persist refusals
      userHistory.pop();
      return { reply, source: 'model', similarity: null, media };
    }

    // 6. Add assistant reply to history
    userHistory.push({ role: 'model', parts: [{ text: reply }] });

    // 7. Save to cache (skip for real-time queries like prayer times)
    if (!skipCache) {
      this.ragService
        .saveToCache(normalizedMessage, reply, embedding)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    return { reply, source: 'model', similarity: null, media };
  }

  async *chatStream(userId: string, message: string, location?: GeoLocation | null): AsyncGenerator<StreamChunk> {
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
    let media: QuranRecitationMedia | undefined;
    try {
      for await (const event of this.geminiService.runAgenticLoopStream(
        buildSystemPrompt(location),
        [...userHistory],
        ISLAMIC_TOOLS,
      )) {
        if (event.type === 'media' && isQuranRecitationMedia(event.media)) {
          media = event.media;
          yield { type: 'media', media };
          continue;
        }

        if (event.type === 'chunk') {
          fullReply += event.text;
          yield { type: 'chunk', text: event.text };
        }
      }
    } catch (err) {
      userHistory.pop();
      throw err;
    }

    const isRefusal = fullReply.startsWith("I'm only able to answer Islamic questions");
    if (isRefusal) {
      userHistory.pop();
      yield { type: 'done', source: 'model', similarity: null, media };
      return;
    }

    userHistory.push({ role: 'model', parts: [{ text: fullReply }] });

    if (!skipCache && !media) {
      this.ragService
        .saveToCache(normalizedMessage, fullReply, embedding)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    yield { type: 'done', source: 'model', similarity: null, media };
  }
}
