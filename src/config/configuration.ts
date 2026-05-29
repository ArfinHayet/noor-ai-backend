export default () => ({
  database: {
    url: process.env.DATABASE_URL,
  },
  privateKey: process.env.PRIVATE_KEY,
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    chatModel: 'gemini-2.5-flash',
    embeddingModel: 'gemini-embedding-001',
  },
  hadith: {
    apiKey: process.env.HADITH_API_KEY,
  },
  location: {
    defaultCity: process.env.DEFAULT_CITY ?? '',
    defaultCountry: process.env.DEFAULT_COUNTRY ?? '',
  },
  rag: {
    similarityThreshold: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.85'),
    maxCacheSearch: parseInt(process.env.MAX_CACHE_SEARCH || '500'),
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL || '60000'),
    limit: parseInt(process.env.THROTTLE_LIMIT || '20'),
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    adminEmails: (process.env.SUPABASE_ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },
});
