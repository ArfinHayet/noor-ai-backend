export const ISLAMIC_TOOLS = [
  {
    name: 'search_quran_by_topic',
    description: `Search the Quran by topic or keyword using semantic search across all languages. ALWAYS use this tool when the user asks about any Quranic topic, verse, or teaching. NEVER pick surah/ayah from memory. Returns top matching verses with Arabic text and translation in the specified language.`,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Topic or concept to search for, e.g. patience, prayer, forgiveness, justice. Use a keyword in any language — the search is cross-lingual.',
        },
        language: {
          type: 'string',
          description: 'Language code for the translation to return alongside the Arabic text. Detect from the user message. Supported: ar, bn, en, es, fr, id, ru, tr, zh. Default: en',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'search_hadith_by_topic',
    description: `Search authentic Hadith collections by topic. ALWAYS use this tool for any Hadith reference. NEVER quote Hadith from memory. Returns top 3 matching hadiths with references.`,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Topic to search e.g. patience, fasting, charity',
        },
        collection: {
          type: 'string',
          description: 'Collection: bukhari | muslim | abudawud | tirmidhi | ibnmajah',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_prayer_times',
    description: 'Get Islamic prayer times for a specific city and country. If the user does not mention a location, use the auto-detected city and country from the USER LOCATION context. Always return time in 12-hour format with am/pm.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name. Use the auto-detected city if the user did not specify one.' },
        country: { type: 'string', description: 'Country name. Use the auto-detected country if the user did not specify one.' },
      },
      required: ['city', 'country'],
    },
  },
  {
    name: 'get_hijri_calendar',
    description: 'Get Hijri calendar information from NoorAi. ALWAYS use this tool when the user asks for the current Hijri date, Islamic calendar date, Hijri/Gregorian conversion, a Hijri month calendar, Ramadan/Eid dates, or when Eid will be. For current Hijri date, call without dates so today is used. For Eid, pass the relevant Hijri year if known; otherwise omit it and use the returned current Hijri year.',
    parameters: {
      type: 'object',
      properties: {
        gregorianDate: {
          type: 'string',
          description: 'Optional Gregorian date to convert to Hijri in DD-MM-YYYY format. Omit for today.',
        },
        hijriDate: {
          type: 'string',
          description: 'Optional Hijri date to convert to Gregorian in DD-MM-YYYY format.',
        },
        hijriMonth: {
          type: 'string',
          description: 'Optional Hijri month number, 1-12, for a full Hijri month calendar.',
        },
        hijriYear: {
          type: 'string',
          description: 'Optional Hijri year, e.g. 1447. Use this for Eid/Ramadan calendar questions when the user mentions a Hijri year.',
        },
        adjustment: {
          type: 'string',
          description: 'Optional day adjustment for moon-sighting differences, e.g. -1, 0, or 1. Default: 0.',
        },
      },
    },
  },
  {
    name: 'get_quran_recitation',
    description: 'Get audio for a specific Quranic passage, including a Surah, Ayah/range, named verse such as Ayatul Kursi, or recognizable Quranic dua phrase. Use for actual play/listen/recite requests, not for questions asking which reciter Noor AI supports. Pass the user-provided passage phrase exactly as written in surahName so the resolver can map named verses and dua phrases to their source Ayahs; use surahNumber only when the user gave a clear number. If the user requests audio but gives no passage, call without passage arguments so it can ask for clarification.',
    parameters: {
      type: 'object',
      properties: {
        surahNumber: {
          type: 'string',
          description: 'Optional Quran surah number from 1 to 114, e.g. 1 for Al-Fatihah or 36 for Ya-Sin.',
        },
        surahName: {
          type: 'string',
          description: 'Optional raw Quranic passage name or phrase from the user in any language or transliteration, including named verses and Quranic dua phrases. Do not normalize or correct it before passing it.',
        },
        startAyah: {
          type: 'string',
          description: 'Optional start ayah number (1-based index).',
        },
        endAyah: {
          type: 'string',
          description: 'Optional end ayah number (1-based index).',
        },
        language: {
          type: 'string',
          description: 'Optional language code for the response. Detect from the user message. Supported: ar, bn, en, es, fr, id, ru, tr, zh. Default: en',
        },
      },
    },
  },
  {
    name: 'get_tafsir',
    description: 'Retrieve the Tafsir (exegesis/explanation) for a specific Surah, a single Ayah, or a range of Ayahs. Use this tool whenever the user asks for explanation, commentary, meaning, or Tafsir of Quran verses. Do NOT make up Tafsir from memory.',
    parameters: {
      type: 'object',
      properties: {
        surahNumber: {
          type: 'string',
          description: 'Optional Quran surah number from 1 to 114, e.g. 1 for Al-Fatihah or 36 for Ya-Sin.',
        },
        surahName: {
          type: 'string',
          description: 'Optional raw surah name or phrase from the user in any language. Do not normalize it.',
        },
        startAyah: {
          type: 'string',
          description: 'Optional start ayah number (1-based index).',
        },
        endAyah: {
          type: 'string',
          description: 'Optional end ayah number (1-based index).',
        },
        language: {
          type: 'string',
          description: 'Optional language code for the response. Detect from the user message. Supported: ar, bn, en, es, fr, id, ru, tr, zh. Default: en',
        },
      },
    },
  },
];
