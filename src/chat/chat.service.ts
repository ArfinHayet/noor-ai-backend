import { Injectable, Logger } from '@nestjs/common';
import { GeminiService, GeminiMessage, IntentResult, MessageIntent, sanitizeModelOutput } from '../gemini/gemini.service';
import { RagService } from '../rag/rag.service';
import { ISLAMIC_TOOLS } from '../mcp/tools/islamic.tools';
import { McpService } from '../mcp/mcp.service';
import { QURAN_AUDIO_RECITER } from '../mcp/quran-audio.constants';
import { GeoLocation } from '../common/services/geo.service';

const BASE_SYSTEM_PROMPT = `You are an Islamic scholar assistant. You ONLY answer questions related to Islam, including:
- Quran, Hadith, Fiqh, Aqeedah, Islamic history
- Halal/Haram rulings, worship (salah, sawm, zakat, hajj)
- Islamic ethics, family matters, daily life from an Islamic perspective
- Prophets, companions, Islamic scholars

DOMAIN RULE:
Answer questions from an Islamic perspective. ANY question that has a plausible Islamic angle
— including the afterlife, Jannah, Jahannam, the soul, ethics, human rights, the purpose of
life, historical figures, social matters, or human nature — MUST be answered using Quran and
Hadith evidence via the search tools.

Only respond with "I'm only able to answer Islamic questions. Please ask something related to
Islam." when the question has ABSOLUTELY NO conceivable Islamic dimension, such as:
"What is 2+2?", "Write me Python code", "Who won the football match?", or "What is the weather?"

When in doubt, answer from an Islamic lens. Cite Quran and Hadith via the search tools for Islamic subject-matter questions. Pure questions about Noor AI's supported reciters are capability questions and use the RECITER AVAILABILITY guidance below.

RECITER AVAILABILITY:
Noor AI currently supports Quran audio by ${QURAN_AUDIO_RECITER.name}.
If asked which reciter is available or for a reciter recommendation, state that this is the currently supported reciter and do not claim that other reciters are available. A reciter availability or recommendation question by itself is informational: do not call Quran/Hadith search tools or the audio tool for it. Listening style is subjective; present the supported reciter as an available option, not a guaranteed preference.

IDENTITY & GREETINGS:
If the user greets you (hello, hi, salam, السلام عليكم, আস্সালামু আলাইকুম, merhaba, etc.)
OR asks a simple identity question ("who are you?", "what are you?", "what is your name?",
"introduce yourself"), respond warmly in the user's language, matching any requested tone,
style, or poetic expression, weaving these facts naturally:
- Name: Noor AI
- Created by: A dedicated team of developers — NOT Google, NOT OpenAI, NOT any specific company
- Purpose: An Islamic assistant that answers based on the Quran and authentic Hadith
- Capabilities: Prayer times, Hijri calendar, Quran recitation, Islamic rulings & history
Do NOT refuse these as off-topic. Do NOT call any search tools for a pure greeting.

META-QUESTIONS (about Noor AI's knowledge, accuracy, or how it works):
If the user asks "where does your knowledge come from?", "what is your knowledge source?",
"how do you know this?", "can you make mistakes?", "what are your limitations?",
"are you always accurate?", "how were you trained?", "are you better than ChatGPT?",
or similar in ANY language — answer honestly and specifically, adapting to any requested style,
tone, or poetic expression, WITHOUT calling search tools. Weave the following facts naturally:
- My knowledge comes from the Quran and authentic Hadith collections (Sahih Bukhari, Sahih Muslim,
  Abu Dawud, Tirmidhi, Nasai, Ibn Majah, and others).
- For every Islamic question I search these sources in real time — I do not rely on general
  internet knowledge, personal opinion, or fabricated references.
- I can make mistakes. Always verify important rulings with a qualified Islamic scholar.
- I do not issue personal fatwas.
- I cannot help with topics unrelated to Islam (weather, programming, sports, etc.).
Respond conversationally in the user's language. Do NOT call any search tools for meta-questions.

LANGUAGE DETECTION:
- Detect the language the user is writing in.
- Map it to one of these supported codes: ar (Arabic), bn (Bengali), en (English), es (Spanish), fr (French), id (Indonesian), ru (Russian), tr (Turkish), zh (Chinese).
- If the user's language is not in the list, use "en" as the fallback.
- Pass this language code as the "language" parameter when calling "search_quran_by_topic".
- CRITICAL: ALWAYS write your ENTIRE response in the same language the user used — this includes explanations, Quran translations, AND hadith text. Tool results are only raw data; you must translate any English or Arabic content from tools into the user's language before including it in the response. Never output English sentences to a user who wrote in Bengali, Turkish, or any other language.

MANDATORY TOOL USAGE — FOLLOW THESE EVERY TIME:
For ANY Islamic teaching, ruling, worship, history, Quran, or Hadith question — even if the user does NOT explicitly mention Quran or Hadith — you MUST call BOTH search tools before composing your answer. The user asking "নিসাব পরিমাণ সম্পদ কত?" or "What is the ruling on fasting?" is the same as asking for Quran and Hadith evidence. Always search both. This does not apply to a pure Noor AI capability question about which reciter its audio system supports; answer that from RECITER AVAILABILITY without search tools.

For real-time utility questions like prayer times, current Hijri date, Islamic calendar dates, Gregorian/Hijri conversion, Ramadan/Eid dates, or "when will Eid be?", call the specialized time/calendar tool first. Quran and Hadith searches are not required for these utility lookups unless the user also asks for evidence, rulings, virtues, or explanation.

For Quran audio requests in ANY language, call "get_quran_recitation" when the user asks to play, hear, or recite an identified passage. Targets include Surahs, Ayahs/ranges, named verses such as Ayatul Kursi, and recognizable Quranic dua names or phrases. Do not use Quran/Hadith search for pure audio playback requests unless the user also asks for explanation, translation, virtues, ruling, or evidence. Pass the user's passage phrase exactly as written in "surahName" unless the user gave a clear numeric Surah/chapter number, in which case pass "surahNumber". If the user asks to play Quran but does not identify a passage, call "get_quran_recitation" without passage arguments and ask for clarification. A question about available/recommended reciters without a passage is informational and must not call the audio tool.

1. QURAN VERSES:
   - NEVER quote or reference a Quran verse from memory
   - ALWAYS call "search_quran_by_topic" for every Islamic subject-matter question that needs Quranic evidence, regardless of whether the user mentions the Quran
   - Do not call it for a pure Noor AI reciter-availability question; answer using RECITER AVAILABILITY
   - Pass the detected language code as the "language" parameter so you get the correct translation
   - Only include a verse in your answer AFTER the tool returns it
   - If tool returns nothing, say "I couldn't find a relevant Quran verse on this topic"
   - Always cite each verse in this format:
       Surah [Name] ([surah]:[ayah]):
       Arabic: [text_ar from tool result]
       Translation: [translation from tool result]
       Tafsir: [tafsir from tool result if available]
   - Translate the Tafsir text into the user's language if they are writing in a non-English language (e.g. Bengali, Turkish, Indonesian, etc.).
   - If multiple verses are relevant, include up to 5, each with its own reference

2. HADITH:
   - NEVER quote or reference a Hadith from memory
   - ALWAYS call "search_hadith_by_topic" for every Islamic subject-matter question that needs Hadith evidence, regardless of whether the user mentions Hadith
   - Do not call it for a pure Noor AI reciter-availability question; answer using RECITER AVAILABILITY
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
   - Call "get_quran_recitation" for actual audio requests with an identified Quranic passage: a Surah, Ayah/range, named verse (e.g. Ayatul Kursi), or recognizable Quranic dua title/phrase
   - A question asking which reciter is supported or recommended is informational; answer that Noor AI currently supports ${QURAN_AUDIO_RECITER.name} and do not call the audio tool unless the user also requests playback
   - Do not correct or normalize passage names yourself; pass the user's phrase as "surahName" so the resolver can map named verses and dua phrases to their source Ayahs
   - Pass "surahNumber" only when the user gave an explicit Surah/chapter number
   - If the user requests audio but does not identify a passage, ask which passage they want rather than treating the rest of their sentence as a Surah name
   - If the tool cannot resolve a named passage, ask the user to clarify the passage name or reference
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

// ---------------------------------------------------------------------------
// Pre-written localised responses (bypasses the agentic loop entirely)
// ---------------------------------------------------------------------------

const GREETING_RESPONSES: Record<string, string> = {
  en: `As-salāmu ʿalaykum! 🌙 I'm **Noor AI** — your Islamic assistant.\n\nI can help you with:\n• Questions based on the **Quran** and **authentic Hadith**\n• **Prayer times** for your location\n• **Hijri calendar**, Ramadan & Eid dates\n• **Quran recitation** — just ask me to recite any Surah\n• Any Islamic ruling, history, or guidance\n\nFeel free to ask anything Islamic — in any language!`,
  bn: `আস্সালামু আলাইকুম! 🌙 আমি **Noor AI** — আপনার ইসলামিক সহকারী।\n\nআমি যেসব বিষয়ে সাহায্য করতে পারি:\n• **কুরআন** ও **সহীহ হাদীস**-ভিত্তিক প্রশ্নের উত্তর\n• আপনার অবস্থান অনুযায়ী **নামাজের সময়**\n• **হিজরি ক্যালেন্ডার**, রমজান ও ঈদের তারিখ\n• **সূরা তেলাওয়াত** — যেকোনো সূরা শুনতে চাইলেই বলুন\n• যেকোনো ইসলামিক বিধি-বিধান, ইতিহাস বা গাইডেন্স\n\nযেকোনো ইসলামিক প্রশ্ন করুন — যেকোনো ভাষায়!`,
  ar: `وعليكم السلام ورحمة الله وبركاته! 🌙 أنا **Noor AI** — مساعدك الإسلامي.\n\nيمكنني مساعدتك في:\n• الأسئلة المبنية على **القرآن الكريم** و**الحديث الصحيح**\n• **أوقات الصلاة** لموقعك\n• **التقويم الهجري** ومواعيد رمضان والعيد\n• **تلاوة القرآن** — فقط اطلب أي سورة\n• أي حكم إسلامي أو تاريخ أو توجيه\n\nاسأل ما تشاء بأي لغة!`,
  tr: `Aleykümselam! 🌙 Ben **Noor AI** — İslami asistanınız.\n\nYardımcı olabileceklerim:\n• **Kuran** ve **sahih hadis** kaynaklı sorular\n• Konumunuza göre **namaz vakitleri**\n• **Hicri takvim**, Ramazan ve Bayram tarihleri\n• **Sure tilaveti** — istediğiniz sureyi okuyabilirim\n• Her türlü İslami hüküm, tarih veya rehberlik\n\nHerhangi bir dilde İslami sorularınızı sorabilirsiniz!`,
  id: `Wa'alaikumsalam! 🌙 Saya **Noor AI** — asisten Islam Anda.\n\nSaya bisa membantu:\n• Pertanyaan berdasarkan **Al-Quran** dan **Hadis sahih**\n• **Jadwal sholat** sesuai lokasi Anda\n• **Kalender Hijriyah**, tanggal Ramadan & Idul Fitri/Adha\n• **Tilawah surah** — minta saja surah apa pun\n• Hukum Islam, sejarah, atau panduan apa pun\n\nSilakan tanya apa saja seputar Islam — dalam bahasa apa pun!`,
  es: `¡Wa alaykum as-salam! 🌙 Soy **Noor AI** — tu asistente islámico.\n\nPuedo ayudarte con:\n• Preguntas basadas en el **Corán** y el **hadiz auténtico**\n• **Horarios de oración** según tu ubicación\n• **Calendario hijri**, fechas de Ramadán y ʿId\n• **Recitación de suras** — sólo pide cualquier sura\n• Cualquier norma islámica, historia o guía\n\n¡Pregunta lo que quieras en cualquier idioma!`,
  fr: `Wa alaykum as-salam ! 🌙 Je suis **Noor AI** — votre assistant islamique.\n\nJe peux vous aider avec :\n• Des questions basées sur le **Coran** et les **hadiths authentiques**\n• Les **horaires de prière** selon votre localisation\n• Le **calendrier hijri**, les dates du Ramadan et de l’Aïd\n• La **récitation de sourates** — demandez n’importe quelle sourate\n• Toute règle islamique, histoire ou guidance\n\nPosez librement vos questions islamiques — dans n’importe quelle langue !`,
  ru: `Ва-алейкум ас-салям! 🌙 Я **Noor AI** — ваш исламский помощник.\n\nЯ могу помочь с:\n• Вопросами на основе **Корана** и **достоверных хадисов**\n• **Временем намаза** для вашего местоположения\n• **Исламским календарём**, датами Рамадана и Ид\n• **Чтением сур** — просто попросите любую суру\n• Любым исламским положением, историей или руководством\n\nЗадавайте любые исламские вопросы на любом языке!`,
  zh: `وعليكم السلام！🌙 我是 **Noor AI** — 您的伊斯兰助手。\n\n我可以帮助您：\n• 基于**古兰经**和**可靠圣训**的问题解答\n• 根据您所在位置的**礼拜时间**\n• **伊斯兰历**、斋月和开斋节日期\n• **古兰经诵读** — 随时请求任何章节\n• 任何伊斯兰律例、历史或指导\n\n欢迎用任何语言提问！`,
};

const OFF_TOPIC_RESPONSES: Record<string, string> = {
  en: `I'm **Noor AI**, an Islamic assistant. I can only help with questions related to Islam — the Quran, Hadith, prayer times, Hijri dates, and Islamic guidance. Please feel free to ask an Islamic question!`,
  bn: `আমি **Noor AI**, একটি ইসলামিক সহকারী। আমি শুধুমাত্র ইসলাম, কুরআন, হাদীস, নামাজের সময়, হিজরি তারিখ এবং ইসলামিক বিষয়ে সাহায্য করতে পারি। ইসলামিক কোনো প্রশ্ন করুন!`,
  ar: `أنا **Noor AI**، مساعد إسلامي. لا أستطيع إلا المساعدة في الأسئلة المتعلقة بالإسلام — القرآن، الحديث، أوقات الصلاة، التاريخ الهجري، والتوجيه الإسلامي. لا تتردد في طرح سؤال إسلامي!`,
  tr: `Ben **Noor AI**, bir İslami asistanım. Yalnızca İslam'a ilişkin sorularda yardımcı olabiliyorum — Kuran, hadis, namaz vakitleri, hicri tarih ve İslami rehberlik. Lütfen bir İslami soru sorun!`,
  id: `Saya **Noor AI**, asisten Islam. Saya hanya bisa membantu pertanyaan seputar Islam — Al-Quran, Hadis, jadwal sholat, tanggal Hijriyah, dan panduan Islam. Silakan ajukan pertanyaan Islam!`,
  es: `Soy **Noor AI**, un asistente islámico. Solo puedo ayudar con preguntas relacionadas con el Islam — el Corán, el hadís, los horarios de oración, las fechas hijri y la orientación islámica. ¡Siéntete libre de hacer una pregunta islámica!`,
  fr: `Je suis **Noor AI**, un assistant islamique. Je ne peux aider qu'avec des questions liées à l'Islam — le Coran, les hadiths, les horaires de prière, les dates hijri et les conseils islamiques. N'hésitez pas à poser une question islamique !`,
  ru: `Я **Noor AI**, исламский помощник. Я могу помочь только с вопросами, связанными с исламом — Кораном, хадисами, временем намаза, датами хиджры и исламским руководством. Пожалуйста, задайте исламский вопрос!`,
  zh: `我是 **Noor AI**，一个伊斯兰助手。我只能帮助回答与伊斯兰相关的问题 — 古兰经、圣训、礼拜时间、伊斯兰历日期和伊斯兰指导。请随时提问伊斯兰问题！`,
};

export interface QuranTafsirMedia {
  type: 'quran_tafsir';
  surahNumber: number;
  surahName: string;
  startAyah?: number | null;
  endAyah?: number | null;
  isLarge: boolean;
}

export type ChatMedia = QuranRecitationMedia | QuranTafsirMedia;

export interface ChatResponse {
  reply: string;
  source: 'cache' | 'model';
  similarity: number | null;
  media?: ChatMedia;
}

export interface QuranRecitationMedia {
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

export type StreamChunk =
  | { type: 'chunk'; text: string }
  | { type: 'media'; media: ChatMedia }
  | { type: 'error'; message: string }
  | { type: 'done'; source: 'cache' | 'model'; similarity: number | null; media?: ChatMedia };

function isQuranRecitationMedia(value: unknown): value is QuranRecitationMedia {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as QuranRecitationMedia).type === 'quran_recitation' &&
    typeof (value as QuranRecitationMedia).audioUrl === 'string'
  );
}

function isQuranTafsirMedia(value: unknown): value is QuranTafsirMedia {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as QuranTafsirMedia).type === 'quran_tafsir' &&
    typeof (value as QuranTafsirMedia).surahNumber === 'number'
  );
}

function isChatMedia(value: unknown): value is ChatMedia {
  return isQuranRecitationMedia(value) || isQuranTafsirMedia(value);
}

function getMediaFallbackReply(media: ChatMedia): string {
  if (media.type === 'quran_recitation') {
    return `Here is Surah ${media.surahName} recited by ${media.reciterName}.`;
  }
  return `Here is the Tafsir for Surah ${media.surahName}.`;
}

function isQuranRecitationToolResult(value: unknown): value is { reply: string; media?: QuranRecitationMedia } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { reply?: unknown }).reply === 'string'
  );
}

/**
 * Maximum number of messages (user + model) to keep in conversation history.
 * Each Islamic Q&A response can be 3,000–8,000 tokens (Quran Arabic + translation +
 * tafsir + hadith). Keeping too many rounds causes context overflow → empty responses
 * or 'Chat service unavailable'. 6 messages = 3 Q&A pairs is a safe balance.
 */
const MAX_HISTORY_MESSAGES = 6;

/**
 * Maximum character length for model responses stored in conversation history.
 * Full responses are already streamed to the user and cached in RAG — the history
 * only needs enough context for the model to understand what was previously discussed.
 */
const MAX_HISTORY_RESPONSE_LENGTH = 800;

function truncateForHistory(text: string): string {
  if (text.length <= MAX_HISTORY_RESPONSE_LENGTH) return text;
  return text.slice(0, MAX_HISTORY_RESPONSE_LENGTH) + '… [truncated]';
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly history = new Map<string, GeminiMessage[]>();

  constructor(
    private readonly geminiService: GeminiService,
    private readonly ragService: RagService,
    private readonly mcpService: McpService,
  ) { }

  private normalizeQuery(query: string): string {
    // Trim whitespace and strip trailing punctuation that doesn't affect meaning:
    // ? (Latin), ؟ (Arabic), ! (exclamation), । (Bangla/Hindi danda), . (period)
    return query.trim().replace(/[?؟!।.]+$/u, '').trim();
  }

  private addToHistory(userId: string, userText: string, modelText: string): void {
    if (!this.history.has(userId)) {
      this.history.set(userId, []);
    }
    const userHistory = this.history.get(userId) as GeminiMessage[];
    userHistory.push({ role: 'user', parts: [{ text: userText }] });
    userHistory.push({ role: 'model', parts: [{ text: truncateForHistory(modelText) }] });
    if (userHistory.length > MAX_HISTORY_MESSAGES) {
      userHistory.splice(0, userHistory.length - MAX_HISTORY_MESSAGES);
    }
  }

  private async getDirectQuranRecitation(message: string, language = 'en'): Promise<ChatResponse> {
    const result = await this.mcpService.executeTool('get_quran_recitation', {
      surahName: message,
      language,
    });

    if (isQuranRecitationToolResult(result)) {
      const media = isQuranRecitationMedia(result.media) ? result.media : undefined;
      const reply = result.reply.trim() || (media ? getMediaFallbackReply(media) : result.reply);
      return { reply, source: 'model', similarity: null, media };
    }

    const error = result && typeof result === 'object' && 'error' in result
      ? String((result as { error: unknown }).error)
      : 'Failed to get Quran recitation.';

    return { reply: error, source: 'model', similarity: null };
  }

  private buildPromptForIntent(
    intent: MessageIntent,
    language: string,
    location?: GeoLocation | null,
  ): string {
    const base = buildSystemPrompt(location);

    if (intent === 'greeting') {
      const template = GREETING_RESPONSES[language] ?? GREETING_RESPONSES['en'];
      return [
        base,
        '',
        '--- INTENT CONTEXT: GREETING ---',
        'The user message has been classified as a greeting or simple identity query.',
        "Greet the user warmly and introduce yourself, adapting naturally to the user's language, tone, style, or poetic requests.",
        'You MUST incorporate the core facts from this reference template naturally into your response — do not just copy-paste it literally:',
        template,
        'Do NOT call any search tools.',
        '--------------------------------',
      ].join('\n');
    }

    if (intent === 'off_topic') {
      const template = OFF_TOPIC_RESPONSES[language] ?? OFF_TOPIC_RESPONSES['en'];
      return [
        base,
        '',
        '--- INTENT CONTEXT: OFF_TOPIC ---',
        'The user message has been classified as off-topic (unrelated to Islam or Noor AI).',
        'You MUST politely refuse to answer any non-Islamic topics and redirect the user back to Islamic questions.',
        "Adapt naturally to the user's language, tone, and style requests, keeping your response polite and professional.",
        'Use this reference template as your guidelines:',
        template,
        'Do NOT answer the off-topic question. Do NOT call any search tools.',
        '---------------------------------',
      ].join('\n');
    }

    return base;
  }

  async chat(userId: string, message: string, location?: GeoLocation | null): Promise<ChatResponse> {
    // 1. Classify intent with AI (works for any language; falls back to general on error)
    const { intent, language }: IntentResult = await this.geminiService.classifyIntent(message);
    const normalizedMessage = this.normalizeQuery(message);

    // 2. Short-circuit: Quran recitation — fetch audio directly without the full agentic loop
    if (intent === 'quran_recitation') {
      const result = await this.getDirectQuranRecitation(message, language);
      this.addToHistory(userId, message, result.reply);
      return result;
    }

    // 3. Determine whether to skip the RAG cache (real-time or media intents)
    const skipCache = intent === 'prayer_time' || intent === 'hijri_calendar';
    const embedding = skipCache ? [] : await this.geminiService.generateEmbedding(normalizedMessage);

    // 4. Search RAG cache
    if (!skipCache) {
      try {
        const cached = await this.ragService.searchSimilar(embedding);
        if (cached) {
          this.logger.log(`Cache hit for user ${userId}: similarity=${cached.similarity}`);
          return { reply: cached.answer, source: 'cache', similarity: cached.similarity, media: cached.media };
        }
      } catch (err) {
        this.logger.warn(`Cache search failed, falling through to model: ${(err as Error).message}`);
      }
    }

    // 5. Build history for this user
    if (!this.history.has(userId)) {
      this.history.set(userId, []);
    }
    const userHistory = this.history.get(userId) as GeminiMessage[];
    userHistory.push({ role: 'user', parts: [{ text: message }] });
    if (userHistory.length > MAX_HISTORY_MESSAGES) {
      userHistory.splice(0, userHistory.length - MAX_HISTORY_MESSAGES);
    }

    // 6. Select tools & build custom system prompt
    const useTools = (intent === 'greeting' || intent === 'off_topic') ? [] : ISLAMIC_TOOLS;
    const systemPrompt = this.buildPromptForIntent(intent, language, location);

    // 7. Run agentic loop
    const agentResult = await this.geminiService.runAgenticLoop(
      systemPrompt,
      [...userHistory],
      useTools,
    );
    const media = agentResult.media?.find(isChatMedia);
    const reply = agentResult.text.trim() || (media ? getMediaFallbackReply(media) : agentResult.text);

    // 8. Add assistant reply to history (truncated to save context budget)
    userHistory.push({ role: 'model', parts: [{ text: truncateForHistory(reply) }] });

    // 9. Save to cache
    if (!skipCache && (reply.trim() || media)) {
      this.ragService
        .saveToCache(normalizedMessage, reply, embedding, media)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    return { reply, source: 'model', similarity: null, media };
  }

  async *chatStream(userId: string, message: string, location?: GeoLocation | null): AsyncGenerator<StreamChunk> {
    // 1. Classify intent with AI (works for any language; falls back to general on error)
    const { intent, language }: IntentResult = await this.geminiService.classifyIntent(message);
    const normalizedMessage = this.normalizeQuery(message);


    // Build history
    if (!this.history.has(userId)) this.history.set(userId, []);
    const userHistory = this.history.get(userId) as GeminiMessage[];
    userHistory.push({ role: 'user', parts: [{ text: message }] });
    if (userHistory.length > MAX_HISTORY_MESSAGES) userHistory.splice(0, userHistory.length - MAX_HISTORY_MESSAGES);


    // 2. Short-circuit: Quran recitation
    if (intent === 'quran_recitation') {
      const result = await this.getDirectQuranRecitation(message, language);
      this.addToHistory(userId, message, result.reply);
      if (result.media) yield { type: 'media', media: result.media };
      yield { type: 'chunk', text: result.reply };
      yield { type: 'done', source: result.source, similarity: result.similarity, media: result.media };
      return;
    }

    // 3. Determine whether to skip the RAG cache
    const skipCache = intent === 'prayer_time' || intent === 'hijri_calendar';
    const embedding = skipCache ? [] : await this.geminiService.generateEmbedding(normalizedMessage);

    // Cache hit — yield full answer as one chunk
    if (!skipCache) {
      try {
        const cached = await this.ragService.searchSimilar(embedding);
        if (cached) {
          this.logger.log(`Cache hit for user ${userId}: similarity=${cached.similarity}`);
          if (cached.media) {
            yield { type: 'media', media: cached.media };
          }
          yield { type: 'chunk', text: cached.answer };
          yield { type: 'done', source: 'cache', similarity: cached.similarity, media: cached.media };
          return;
        }
      } catch (err) {
        this.logger.warn(`Cache search failed, falling through to model: ${(err as Error).message}`);
      }
    }

    // Select tools & build custom system prompt
    const useTools = (intent === 'greeting' || intent === 'off_topic') ? [] : ISLAMIC_TOOLS;
    const systemPrompt = this.buildPromptForIntent(intent, language, location);

    // Stream from Gemini, accumulate full reply for cache + history.
    // If the agentic loop fails (e.g. context too large after several Q&A rounds),
    // retry once with cleared history so the user gets an answer instead of an error.
    let fullReply = '';
    let media: ChatMedia | undefined;
    let retried = false;

    const runStream = async function* (self: ChatService, history: GeminiMessage[]): AsyncGenerator<StreamChunk> {
      for await (const event of self.geminiService.runAgenticLoopStream(
        systemPrompt,
        [...history],
        useTools,
      )) {
        if (event.type === 'media' && isChatMedia(event.media)) {
          media = event.media;
          yield { type: 'media', media };
          continue;
        }

        if (event.type === 'chunk') {
          fullReply += event.text;
          yield { type: 'chunk', text: event.text };
        }
      }
    };

    try {
      yield* runStream(this, userHistory);
    } catch (err) {
      // ── Fallback: retry with cleared history ─────────────────────────────
      // Context overflow from accumulated history is the most common cause.
      // Clear this user's history and retry with just the current message.
      this.logger.warn(
        `Agentic stream failed for user ${userId}, retrying with cleared history: ${(err as Error).message}`,
      );
      retried = true;
      this.history.set(userId, [{ role: 'user', parts: [{ text: message }] }]);
      const freshHistory = this.history.get(userId) as GeminiMessage[];

      try {
        fullReply = '';
        media = undefined;
        yield* runStream(this, freshHistory);
      } catch (retryErr) {
        freshHistory.pop();
        yield { type: 'error', message: (retryErr as Error).message };
        return;
      }
    }

    if (!fullReply.trim() && media) {
      fullReply = getMediaFallbackReply(media);
      yield { type: 'chunk', text: fullReply };
    }

    const cleanReply = sanitizeModelOutput(fullReply);
    const currentHistory = this.history.get(userId) as GeminiMessage[];
    currentHistory.push({ role: 'model', parts: [{ text: truncateForHistory(cleanReply) }] });

    if (!skipCache && (cleanReply.trim() || media)) {
      this.ragService
        .saveToCache(normalizedMessage, cleanReply, embedding, media)
        .catch((err) => this.logger.warn(`Cache save failed: ${(err as Error).message}`));
    }

    yield { type: 'done', source: retried ? 'model' : 'model', similarity: null, media };
  }

  async getRawTafsir(
    surahNumber: number,
    startAyah: number,
    endAyah: number,
  ): Promise<Array<{ verse_number: number; verse_key: string; text_html: string }>> {
    const records = await this.ragService.getQuranTafsir(surahNumber, startAyah, endAyah);
    return records.map((r) => ({
      verse_number: r.verse_number,
      verse_key: r.verse_key,
      text_html: r.text_html,
    }));
  }
}
