/**
 * Quran Surah Metadata Seeder
 *
 * Generates Gemini embeddings for canonical English + Bangla surah names and stores
 * them in quran_surahs for semantic recitation lookup.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register src/scripts/seed-quran-surahs.ts
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../app.module';
import { RagService, QuranSurahRaw } from '../rag/rag.service';
import { GeminiKeyService } from '../rag/services/gemini-key.service';

const logger = new Logger('SeedQuranSurahs');
const INTER_REQUEST_MS = 1200;
const MAX_RETRIES = 6;

const QURAN_SURAHS: QuranSurahRaw[] = [
  { surah_number: 1, name_en: 'Al-Fatihah', name_bn: 'আল-ফাতিহা' },
  { surah_number: 2, name_en: 'Al-Baqarah', name_bn: 'আল-বাকারা' },
  { surah_number: 3, name_en: 'Ali Imran', name_bn: 'আলে ইমরান' },
  { surah_number: 4, name_en: 'An-Nisa', name_bn: 'আন-নিসা' },
  { surah_number: 5, name_en: 'Al-Maidah', name_bn: 'আল-মায়িদাহ' },
  { surah_number: 6, name_en: 'Al-Anam', name_bn: 'আল-আনআম' },
  { surah_number: 7, name_en: 'Al-Araf', name_bn: 'আল-আরাফ' },
  { surah_number: 8, name_en: 'Al-Anfal', name_bn: 'আল-আনফাল' },
  { surah_number: 9, name_en: 'At-Tawbah', name_bn: 'আত-তাওবাহ' },
  { surah_number: 10, name_en: 'Yunus', name_bn: 'ইউনুস' },
  { surah_number: 11, name_en: 'Hud', name_bn: 'হুদ' },
  { surah_number: 12, name_en: 'Yusuf', name_bn: 'ইউসুফ' },
  { surah_number: 13, name_en: 'Ar-Rad', name_bn: 'আর-রাদ' },
  { surah_number: 14, name_en: 'Ibrahim', name_bn: 'ইবরাহিম' },
  { surah_number: 15, name_en: 'Al-Hijr', name_bn: 'আল-হিজর' },
  { surah_number: 16, name_en: 'An-Nahl', name_bn: 'আন-নাহল' },
  { surah_number: 17, name_en: 'Al-Isra', name_bn: 'আল-ইসরা' },
  { surah_number: 18, name_en: 'Al-Kahf', name_bn: 'আল-কাহফ' },
  { surah_number: 19, name_en: 'Maryam', name_bn: 'মারইয়াম' },
  { surah_number: 20, name_en: 'Ta-Ha', name_bn: 'ত্বহা' },
  { surah_number: 21, name_en: 'Al-Anbiya', name_bn: 'আল-আম্বিয়া' },
  { surah_number: 22, name_en: 'Al-Hajj', name_bn: 'আল-হজ্জ' },
  { surah_number: 23, name_en: 'Al-Muminun', name_bn: 'আল-মুমিনুন' },
  { surah_number: 24, name_en: 'An-Nur', name_bn: 'আন-নূর' },
  { surah_number: 25, name_en: 'Al-Furqan', name_bn: 'আল-ফুরকান' },
  { surah_number: 26, name_en: 'Ash-Shuara', name_bn: 'আশ-শুআরা' },
  { surah_number: 27, name_en: 'An-Naml', name_bn: 'আন-নামল' },
  { surah_number: 28, name_en: 'Al-Qasas', name_bn: 'আল-কাসাস' },
  { surah_number: 29, name_en: 'Al-Ankabut', name_bn: 'আল-আনকাবুত' },
  { surah_number: 30, name_en: 'Ar-Rum', name_bn: 'আর-রূম' },
  { surah_number: 31, name_en: 'Luqman', name_bn: 'লুকমান' },
  { surah_number: 32, name_en: 'As-Sajdah', name_bn: 'আস-সাজদাহ' },
  { surah_number: 33, name_en: 'Al-Ahzab', name_bn: 'আল-আহযাব' },
  { surah_number: 34, name_en: 'Saba', name_bn: 'সাবা' },
  { surah_number: 35, name_en: 'Fatir', name_bn: 'ফাতির' },
  { surah_number: 36, name_en: 'Ya-Sin', name_bn: 'ইয়াসিন' },
  { surah_number: 37, name_en: 'As-Saffat', name_bn: 'আস-সাফফাত' },
  { surah_number: 38, name_en: 'Sad', name_bn: 'সাদ' },
  { surah_number: 39, name_en: 'Az-Zumar', name_bn: 'আয-যুমার' },
  { surah_number: 40, name_en: 'Ghafir', name_bn: 'গাফির' },
  { surah_number: 41, name_en: 'Fussilat', name_bn: 'ফুসসিলাত' },
  { surah_number: 42, name_en: 'Ash-Shuraa', name_bn: 'আশ-শুরা' },
  { surah_number: 43, name_en: 'Az-Zukhruf', name_bn: 'আয-যুখরুফ' },
  { surah_number: 44, name_en: 'Ad-Dukhan', name_bn: 'আদ-দুখান' },
  { surah_number: 45, name_en: 'Al-Jathiyah', name_bn: 'আল-জাসিয়া' },
  { surah_number: 46, name_en: 'Al-Ahqaf', name_bn: 'আল-আহকাফ' },
  { surah_number: 47, name_en: 'Muhammad', name_bn: 'মুহাম্মদ' },
  { surah_number: 48, name_en: 'Al-Fath', name_bn: 'আল-ফাতহ' },
  { surah_number: 49, name_en: 'Al-Hujurat', name_bn: 'আল-হুজুরাত' },
  { surah_number: 50, name_en: 'Qaf', name_bn: 'কাফ' },
  { surah_number: 51, name_en: 'Adh-Dhariyat', name_bn: 'আয-যারিয়াত' },
  { surah_number: 52, name_en: 'At-Tur', name_bn: 'আত-তূর' },
  { surah_number: 53, name_en: 'An-Najm', name_bn: 'আন-নাজম' },
  { surah_number: 54, name_en: 'Al-Qamar', name_bn: 'আল-কামার' },
  { surah_number: 55, name_en: 'Ar-Rahman', name_bn: 'আর-রহমান' },
  { surah_number: 56, name_en: 'Al-Waqiah', name_bn: 'আল-ওয়াকিয়া' },
  { surah_number: 57, name_en: 'Al-Hadid', name_bn: 'আল-হাদীদ' },
  { surah_number: 58, name_en: 'Al-Mujadilah', name_bn: 'আল-মুজাদালাহ' },
  { surah_number: 59, name_en: 'Al-Hashr', name_bn: 'আল-হাশর' },
  { surah_number: 60, name_en: 'Al-Mumtahanah', name_bn: 'আল-মুমতাহিনা' },
  { surah_number: 61, name_en: 'As-Saff', name_bn: 'আস-সাফ' },
  { surah_number: 62, name_en: 'Al-Jumuah', name_bn: 'আল-জুমুআ' },
  { surah_number: 63, name_en: 'Al-Munafiqun', name_bn: 'আল-মুনাফিকুন' },
  { surah_number: 64, name_en: 'At-Taghabun', name_bn: 'আত-তাগাবুন' },
  { surah_number: 65, name_en: 'At-Talaq', name_bn: 'আত-তালাক' },
  { surah_number: 66, name_en: 'At-Tahrim', name_bn: 'আত-তাহরীম' },
  { surah_number: 67, name_en: 'Al-Mulk', name_bn: 'আল-মুলক' },
  { surah_number: 68, name_en: 'Al-Qalam', name_bn: 'আল-কলম' },
  { surah_number: 69, name_en: 'Al-Haqqah', name_bn: 'আল-হাক্কাহ' },
  { surah_number: 70, name_en: 'Al-Maarij', name_bn: 'আল-মাআরিজ' },
  { surah_number: 71, name_en: 'Nuh', name_bn: 'নূহ' },
  { surah_number: 72, name_en: 'Al-Jinn', name_bn: 'আল-জিন' },
  { surah_number: 73, name_en: 'Al-Muzzammil', name_bn: 'আল-মুযযাম্মিল' },
  { surah_number: 74, name_en: 'Al-Muddaththir', name_bn: 'আল-মুদ্দাসসির' },
  { surah_number: 75, name_en: 'Al-Qiyamah', name_bn: 'আল-কিয়ামাহ' },
  { surah_number: 76, name_en: 'Al-Insan', name_bn: 'আল-ইনসান' },
  { surah_number: 77, name_en: 'Al-Mursalat', name_bn: 'আল-মুরসালাত' },
  { surah_number: 78, name_en: 'An-Naba', name_bn: 'আন-নাবা' },
  { surah_number: 79, name_en: 'An-Naziat', name_bn: 'আন-নাযিয়াত' },
  { surah_number: 80, name_en: 'Abasa', name_bn: 'আবাসা' },
  { surah_number: 81, name_en: 'At-Takwir', name_bn: 'আত-তাকভীর' },
  { surah_number: 82, name_en: 'Al-Infitar', name_bn: 'আল-ইনফিতার' },
  { surah_number: 83, name_en: 'Al-Mutaffifin', name_bn: 'আল-মুতাফফিফিন' },
  { surah_number: 84, name_en: 'Al-Inshiqaq', name_bn: 'আল-ইনশিকাক' },
  { surah_number: 85, name_en: 'Al-Buruj', name_bn: 'আল-বুরুজ' },
  { surah_number: 86, name_en: 'At-Tariq', name_bn: 'আত-তারিক' },
  { surah_number: 87, name_en: 'Al-Ala', name_bn: 'আল-আলা' },
  { surah_number: 88, name_en: 'Al-Ghashiyah', name_bn: 'আল-গাশিয়াহ' },
  { surah_number: 89, name_en: 'Al-Fajr', name_bn: 'আল-ফজর' },
  { surah_number: 90, name_en: 'Al-Balad', name_bn: 'আল-বালাদ' },
  { surah_number: 91, name_en: 'Ash-Shams', name_bn: 'আশ-শামস' },
  { surah_number: 92, name_en: 'Al-Layl', name_bn: 'আল-লাইল' },
  { surah_number: 93, name_en: 'Ad-Duhaa', name_bn: 'আদ-দুহা' },
  { surah_number: 94, name_en: 'Ash-Sharh', name_bn: 'আশ-শারহ' },
  { surah_number: 95, name_en: 'At-Tin', name_bn: 'আত-তীন' },
  { surah_number: 96, name_en: 'Al-Alaq', name_bn: 'আল-আলাক' },
  { surah_number: 97, name_en: 'Al-Qadr', name_bn: 'আল-কদর' },
  { surah_number: 98, name_en: 'Al-Bayyinah', name_bn: 'আল-বাইয়্যিনাহ' },
  { surah_number: 99, name_en: 'Az-Zalzalah', name_bn: 'আয-যিলযাল' },
  { surah_number: 100, name_en: 'Al-Adiyat', name_bn: 'আল-আদিয়াত' },
  { surah_number: 101, name_en: 'Al-Qariah', name_bn: 'আল-কারিয়াহ' },
  { surah_number: 102, name_en: 'At-Takathur', name_bn: 'আত-তাকাসুর' },
  { surah_number: 103, name_en: 'Al-Asr', name_bn: 'আল-আসর' },
  { surah_number: 104, name_en: 'Al-Humazah', name_bn: 'আল-হুমাযাহ' },
  { surah_number: 105, name_en: 'Al-Fil', name_bn: 'আল-ফীল' },
  { surah_number: 106, name_en: 'Quraysh', name_bn: 'কুরাইশ' },
  { surah_number: 107, name_en: 'Al-Maun', name_bn: 'আল-মাউন' },
  { surah_number: 108, name_en: 'Al-Kawthar', name_bn: 'আল-কাউসার' },
  { surah_number: 109, name_en: 'Al-Kafirun', name_bn: 'আল-কাফিরুন' },
  { surah_number: 110, name_en: 'An-Nasr', name_bn: 'আন-নাসর' },
  { surah_number: 111, name_en: 'Al-Masad', name_bn: 'আল-মাসাদ' },
  { surah_number: 112, name_en: 'Al-Ikhlas', name_bn: 'আল-ইখলাস' },
  { surah_number: 113, name_en: 'Al-Falaq', name_bn: 'আল-ফালাক' },
  { surah_number: 114, name_en: 'An-Nas', name_bn: 'আন-নাস' },
];

function buildEmbeddingText(surah: QuranSurahRaw): string {
  return `${surah.name_en} | ${surah.name_bn} | Surah ${surah.surah_number} | সূরা ${surah.surah_number}`;
}

function isRateLimitError(err: unknown): boolean {
  const msg = ((err as Error).message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('too many requests');
}

async function embedWithRotation(
  keyService: GeminiKeyService,
  fallbackApiKey: string | undefined,
  modelName: string,
  text: string,
): Promise<number[]> {
  const tried = new Set<string>();

  while (true) {
    let keyData;
    try {
      keyData = await keyService.getNextKey();
    } catch (err) {
      logger.warn(`Unable to read a DB Gemini key, using fallback key if available: ${(err as Error).message}`);
      break;
    }

    if (!keyData || tried.has(keyData.id)) break;
    tried.add(keyData.id);

    try {
      const result = await new GoogleGenerativeAI(keyData.apiKey)
        .getGenerativeModel({ model: modelName })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .embedContent({ content: { parts: [{ text }], role: 'user' }, outputDimensionality: 768 } as any);
      return result.embedding.values;
    } catch (err) {
      if (isRateLimitError(err)) {
        logger.warn(`DB key ${keyData.id.slice(0, 8)}... rate-limited, rotating to next key...`);
        await keyService.markRateLimited(keyData.id);
        continue;
      }
      throw err;
    }
  }

  if (!fallbackApiKey) {
    throw new Error('No Gemini API keys available');
  }

  logger.warn('All DB keys exhausted, falling back to .env GEMINI_API_KEY with backoff...');
  const fallbackModel = new GoogleGenerativeAI(fallbackApiKey).getGenerativeModel({ model: modelName });
  let delay = 10_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fallbackModel.embedContent({ content: { parts: [{ text }], role: 'user' }, outputDimensionality: 768 } as any);
      return result.embedding.values;
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        logger.warn(`Fallback key rate-limited, waiting ${delay / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 120_000);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Max retries exceeded on fallback key');
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const ragService = app.get(RagService);
  const configService = app.get(ConfigService);
  const keyService = app.get(GeminiKeyService);
  const fallbackApiKey = configService.get<string>('gemini.apiKey');
  const modelName =
    configService.get<string>('gemini.embeddingModel') ?? 'gemini-embedding-001';

  const seededNumbers = await ragService.getSeededSurahNumbers();
  const pending = QURAN_SURAHS.filter((surah) => !seededNumbers.has(surah.surah_number));

  logger.log(
    `Already seeded: ${seededNumbers.size} | Remaining: ${pending.length} | Total: ${QURAN_SURAHS.length}`,
  );

  if (pending.length === 0) {
    logger.log('All surahs already seeded. Nothing to do.');
    await app.close();
    process.exit(0);
  }

  let success = 0;
  let skipped = 0;

  for (let i = 0; i < pending.length; i++) {
    const surah = pending[i];

    try {
      const embedding = await embedWithRotation(
        keyService,
        fallbackApiKey,
        modelName,
        buildEmbeddingText(surah),
      );
      await ragService.saveQuranSurah(surah, embedding);
      success += 1;
      logger.log(`Seeded Surah ${surah.surah_number}: ${surah.name_en}`);
    } catch (err) {
      skipped += 1;
      logger.warn(`Skipping Surah ${surah.surah_number}: ${(err as Error).message}`);
    }

    if (i < pending.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_REQUEST_MS));
    }
  }

  logger.log(`Done. Seeded=${success}, skipped=${skipped}`);
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
