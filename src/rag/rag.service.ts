import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CacheEntity } from './entities/cache.entity';
import { QuranVerseEntity } from './entities/quran-verse.entity';
import { QuranSurahEntity } from './entities/quran-surah.entity';
import { HadithEntity } from './entities/hadith.entity';

export interface QuranVerseRaw {
  id: string;
  chapter_number: number;
  chapter_name: string;
  verse_number: number;
  chapter_type: string;
  total_verses: number;
  text_ar: string;
  text_bn: string | null;
  text_en: string | null;
  text_es: string | null;
  text_fr: string | null;
  text_id: string | null;
  text_ru: string | null;
  text_tr: string | null;
  text_zh: string | null;
}

export interface QuranVerseSearchResult {
  id: string;
  chapter_name: string;
  chapter_number: number;
  verse_number: number;
  text_ar: string;
  translation: string | null;
  similarity: number;
}

export interface QuranSurahRaw {
  surah_number: number;
  name_en: string;
  name_bn: string;
}

export interface QuranSurahSearchResult extends QuranSurahRaw {
  similarity: number;
}

interface CachedResult {
  answer: string;
  similarity: number;
  question: string;
}

export interface HadithRaw {
  id: string;
  collection: string;
  collection_name: string;
  hadith_number: number;
  chapter_number: number | null;
  chapter_name: string | null;
  text_ar: string;
  text_en: string | null;
  narrator_en: string | null;
  grade: string | null;
}

export interface HadithSearchResult {
  id: string;
  collection: string;
  collection_name: string;
  hadith_number: number;
  chapter_name: string | null;
  text_ar: string;
  text_en: string | null;
  narrator_en: string | null;
  grade: string | null;
  similarity: number;
}

const SUPPORTED_LANG_COLUMNS = new Set(['ar', 'bn', 'en', 'es', 'fr', 'id', 'ru', 'tr', 'zh']);
const QURAN_SEARCH_THRESHOLD = 0.4;
const QURAN_SURAH_SEARCH_THRESHOLD = 0.5;
const QURAN_SURAH_CANDIDATE_THRESHOLD = 0.2;
const HADITH_SEARCH_THRESHOLD = 0.4;

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);

  constructor(
    @InjectRepository(CacheEntity)
    private readonly cacheRepo: Repository<CacheEntity>,
    @InjectRepository(QuranVerseEntity)
    private readonly quranVerseRepo: Repository<QuranVerseEntity>,
    @InjectRepository(QuranSurahEntity)
    private readonly quranSurahRepo: Repository<QuranSurahEntity>,
    @InjectRepository(HadithEntity)
    private readonly hadithRepo: Repository<HadithEntity>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureVectorExtension();
    await this.ensureHadithTable();
  }

  private async ensureVectorExtension(): Promise<void> {
    await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS islamic_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        embedding vector(768) NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migrate column to vector(768) if it exists with different dimensions
    await this.dataSource.query(`
      DO $$
      DECLARE v_typmod integer;
      BEGIN
        SELECT atttypmod INTO v_typmod
        FROM pg_attribute
        WHERE attrelid = 'islamic_cache'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped;
        IF FOUND AND v_typmod IS NOT NULL AND v_typmod != 768 THEN
          DROP INDEX IF EXISTS islamic_cache_embedding_idx;
          TRUNCATE TABLE islamic_cache;
          ALTER TABLE islamic_cache DROP COLUMN embedding;
          ALTER TABLE islamic_cache ADD COLUMN embedding vector(768) NOT NULL;
        END IF;
      EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
      END$$
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS islamic_cache_embedding_idx 
      ON islamic_cache USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
    await this.ensureQuranVersesTable();
    await this.ensureQuranSurahsTable();
    this.logger.log('Vector extension and cache table ensured');
  }

  private async ensureQuranVersesTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS quran_verses (
        id VARCHAR(10) PRIMARY KEY,
        chapter_number INT NOT NULL,
        chapter_name VARCHAR(150) NOT NULL,
        verse_number INT NOT NULL,
        chapter_type VARCHAR(20) NOT NULL,
        total_verses INT NOT NULL,
        text_ar TEXT NOT NULL,
        text_bn TEXT,
        text_en TEXT,
        text_es TEXT,
        text_fr TEXT,
        text_id TEXT,
        text_ru TEXT,
        text_tr TEXT,
        text_zh TEXT,
        embedding vector(768),
        seeded_at TIMESTAMPTZ
      )
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS quran_verses_embedding_idx
      ON quran_verses USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
    this.logger.log('Quran verses table ensured');
  }

  private async ensureQuranSurahsTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS quran_surahs (
        surah_number INT PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_bn TEXT NOT NULL,
        embedding vector(768),
        seeded_at TIMESTAMPTZ
      )
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS quran_surahs_embedding_idx
      ON quran_surahs USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 20)
    `);
    this.logger.log('Quran surahs table ensured');
  }

  private normalizeQuranSurahName(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\u0980-\u09ff]+/g, '')
      .trim();
  }

  async searchSimilar(queryEmbedding: number[]): Promise<CachedResult | null> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const result = await this.dataSource.query<
      Array<{ question: string; answer: string; similarity: string }>
    >(
      `SELECT 
         question,
         answer,
         1 - (embedding::vector <=> $1::vector) AS similarity
       FROM islamic_cache
       ORDER BY embedding::vector <=> $1::vector
       LIMIT 1`,
      [embeddingStr],
    );

    const threshold = this.configService.get<number>('rag.similarityThreshold') ?? 0.85;
    if (result.length > 0 && parseFloat(result[0].similarity) >= threshold) {
      return {
        answer: result[0].answer,
        similarity: parseFloat(result[0].similarity),
        question: result[0].question,
      };
    }
    return null;
  }

  async saveToCache(question: string, answer: string, embedding: number[]): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO islamic_cache (id, question, answer, embedding, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3::vector, NOW())`,
      [question, answer, `[${embedding.join(',')}]`],
    );
  }

  async searchQuranVerses(
    queryEmbedding: number[],
    language: string,
    limit = 5,
  ): Promise<QuranVerseSearchResult[]> {
    // Validate language to prevent SQL injection via column name interpolation
    const lang = SUPPORTED_LANG_COLUMNS.has(language) ? language : 'en';
    const col = lang === 'ar' ? 'text_ar' : `text_${lang}`;
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const rows = await this.dataSource.query<
      Array<{
        id: string;
        chapter_name: string;
        chapter_number: string;
        verse_number: string;
        text_ar: string;
        translation: string | null;
        similarity: string;
      }>
    >(
      `SELECT
         id,
         chapter_name,
         chapter_number,
         verse_number,
         text_ar,
         ${col} AS translation,
         1 - (embedding::vector <=> $1::vector) AS similarity
       FROM quran_verses
       WHERE embedding IS NOT NULL
       ORDER BY embedding::vector <=> $1::vector
       LIMIT $2`,
      [embeddingStr, limit],
    );

    return rows
      .filter((r) => parseFloat(r.similarity) >= QURAN_SEARCH_THRESHOLD)
      .map((r) => ({
        id: r.id,
        chapter_name: r.chapter_name,
        chapter_number: parseInt(r.chapter_number, 10),
        verse_number: parseInt(r.verse_number, 10),
        text_ar: r.text_ar,
        translation: r.translation,
        similarity: parseFloat(r.similarity),
      }));
  }

  async saveQuranVerse(verse: QuranVerseRaw, embedding: number[]): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO quran_verses (
         id, chapter_number, chapter_name, verse_number, chapter_type, total_verses,
         text_ar, text_bn, text_en, text_es, text_fr, text_id, text_ru, text_tr, text_zh,
         embedding, seeded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::vector,NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        verse.id,
        verse.chapter_number,
        verse.chapter_name,
        verse.verse_number,
        verse.chapter_type,
        verse.total_verses,
        verse.text_ar,
        verse.text_bn,
        verse.text_en,
        verse.text_es,
        verse.text_fr,
        verse.text_id,
        verse.text_ru,
        verse.text_tr,
        verse.text_zh,
        `[${embedding.join(',')}]`,
      ],
    );
  }

  async getSeededVerseIds(): Promise<Set<string>> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM quran_verses WHERE embedding IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.id));
  }

  async saveQuranSurah(surah: QuranSurahRaw, embedding: number[]): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO quran_surahs (
         surah_number, name_en, name_bn, embedding, seeded_at
       ) VALUES ($1,$2,$3,$4::vector,NOW())
       ON CONFLICT (surah_number) DO UPDATE SET
         name_en = EXCLUDED.name_en,
         name_bn = EXCLUDED.name_bn,
         embedding = EXCLUDED.embedding,
         seeded_at = NOW()`,
      [
        surah.surah_number,
        surah.name_en,
        surah.name_bn,
        `[${embedding.join(',')}]`,
      ],
    );
  }

  async getSeededSurahNumbers(): Promise<Set<number>> {
    const rows = await this.dataSource.query<Array<{ surah_number: string }>>(
      `SELECT surah_number FROM quran_surahs WHERE embedding IS NOT NULL`,
    );
    return new Set(rows.map((r) => parseInt(r.surah_number, 10)));
  }

  async getQuranSurahByNumber(surahNumber: number): Promise<QuranSurahRaw | null> {
    const rows = await this.dataSource.query<
      Array<{ surah_number: string; name_en: string; name_bn: string }>
    >(
      `SELECT surah_number, name_en, name_bn
       FROM quran_surahs
       WHERE surah_number = $1
       LIMIT 1`,
      [surahNumber],
    );

    if (rows.length === 0) return null;

    return {
      surah_number: parseInt(rows[0].surah_number, 10),
      name_en: rows[0].name_en,
      name_bn: rows[0].name_bn,
    };
  }

  async findQuranSurahByName(rawName: string): Promise<QuranSurahRaw | null> {
    const queryName = this.normalizeQuranSurahName(rawName);
    if (!queryName) return null;

    const rows = await this.dataSource.query<
      Array<{ surah_number: string; name_en: string; name_bn: string }>
    >(
      `SELECT surah_number, name_en, name_bn
       FROM quran_surahs
       WHERE embedding IS NOT NULL`,
    );

    const normalizedRows = rows.map((row) => ({
      row,
      normalizedEnglishName: this.normalizeQuranSurahName(row.name_en),
      normalizedBanglaName: this.normalizeQuranSurahName(row.name_bn),
    }));

    const exactMatch = normalizedRows.find(
      ({ normalizedEnglishName, normalizedBanglaName }) =>
        queryName === normalizedEnglishName || queryName === normalizedBanglaName,
    );

    if (exactMatch) {
      return {
        surah_number: parseInt(exactMatch.row.surah_number, 10),
        name_en: exactMatch.row.name_en,
        name_bn: exactMatch.row.name_bn,
      };
    }

    if (queryName.length < 5) return null;

    const containedMatches = normalizedRows
      .filter(
        ({ normalizedEnglishName, normalizedBanglaName }) =>
          queryName.includes(normalizedEnglishName) ||
          queryName.includes(normalizedBanglaName) ||
          normalizedEnglishName.includes(queryName) ||
          normalizedBanglaName.includes(queryName),
      )
      .sort((a, b) => {
        const aLength = Math.max(a.normalizedEnglishName.length, a.normalizedBanglaName.length);
        const bLength = Math.max(b.normalizedEnglishName.length, b.normalizedBanglaName.length);
        return bLength - aLength;
      });

    const match = containedMatches[0];
    if (!match) return null;

    return {
      surah_number: parseInt(match.row.surah_number, 10),
      name_en: match.row.name_en,
      name_bn: match.row.name_bn,
    };
  }

  async searchQuranSurah(queryEmbedding: number[], limit = 1): Promise<QuranSurahSearchResult[]> {
    const rows = await this.searchQuranSurahCandidates(queryEmbedding, limit);

    return rows.filter((r) => r.similarity >= QURAN_SURAH_SEARCH_THRESHOLD);
  }

  async searchQuranSurahCandidates(queryEmbedding: number[], limit = 8): Promise<QuranSurahSearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const rows = await this.dataSource.query<
      Array<{ surah_number: string; name_en: string; name_bn: string; similarity: string }>
    >(
      `SELECT
         surah_number,
         name_en,
         name_bn,
         1 - (embedding::vector <=> $1::vector) AS similarity
       FROM quran_surahs
       WHERE embedding IS NOT NULL
       ORDER BY embedding::vector <=> $1::vector
       LIMIT $2`,
      [embeddingStr, limit],
    );

    return rows
      .filter((r) => parseFloat(r.similarity) >= QURAN_SURAH_CANDIDATE_THRESHOLD)
      .map((r) => ({
        surah_number: parseInt(r.surah_number, 10),
        name_en: r.name_en,
        name_bn: r.name_bn,
        similarity: parseFloat(r.similarity),
      }));
  }

  private async ensureHadithTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS hadith_entries (
        id VARCHAR(30) PRIMARY KEY,
        collection VARCHAR(30) NOT NULL,
        collection_name VARCHAR(100) NOT NULL,
        hadith_number NUMERIC(10,1) NOT NULL,
        chapter_number INT,
        chapter_name TEXT,
        text_ar TEXT NOT NULL,
        text_en TEXT,
        narrator_en TEXT,
        grade VARCHAR(50),
        embedding vector(768),
        seeded_at TIMESTAMPTZ
      )
    `);
    // Migrate existing INT column to NUMERIC(10,1) to support decimal hadith numbers (e.g. 402.2)
    await this.dataSource.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'hadith_entries'
            AND column_name = 'hadith_number'
            AND data_type = 'integer'
        ) THEN
          ALTER TABLE hadith_entries
            ALTER COLUMN hadith_number TYPE NUMERIC(10,1)
            USING hadith_number::NUMERIC(10,1);
        END IF;
      END$$
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS hadith_entries_embedding_idx
      ON hadith_entries USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
    this.logger.log('Hadith entries table ensured');
  }

  async searchHadiths(
    queryEmbedding: number[],
    collection?: string,
    limit = 5,
  ): Promise<HadithSearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const threshold = HADITH_SEARCH_THRESHOLD;

    const collectionFilter = collection ? `AND collection = $3` : '';
    const params: (string | number)[] = [embeddingStr, limit];
    if (collection) params.push(collection);

    const rows = await this.dataSource.query<
      Array<{
        id: string;
        collection: string;
        collection_name: string;
        hadith_number: string;
        chapter_number: string | null;
        chapter_name: string | null;
        text_ar: string;
        text_en: string | null;
        narrator_en: string | null;
        grade: string | null;
        similarity: string;
      }>
    >(
      `SELECT
         id,
         collection,
         collection_name,
         hadith_number,
         chapter_number,
         chapter_name,
         text_ar,
         text_en,
         narrator_en,
         grade,
         1 - (embedding::vector <=> $1::vector) AS similarity
       FROM hadith_entries
       WHERE embedding IS NOT NULL
       ${collectionFilter}
       ORDER BY embedding::vector <=> $1::vector
       LIMIT $2`,
      params,
    );

    return rows
      .filter((r) => parseFloat(r.similarity) >= threshold)
      .map((r) => ({
        id: r.id,
        collection: r.collection,
        collection_name: r.collection_name,
        hadith_number: parseFloat(r.hadith_number),
        chapter_name: r.chapter_name,
        text_ar: r.text_ar,
        text_en: r.text_en,
        narrator_en: r.narrator_en,
        grade: r.grade,
        similarity: parseFloat(r.similarity),
      }));
  }

  async saveHadithEntry(hadith: HadithRaw, embedding: number[]): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO hadith_entries (
         id, collection, collection_name, hadith_number, chapter_number, chapter_name,
         text_ar, text_en, narrator_en, grade, embedding, seeded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        hadith.id,
        hadith.collection,
        hadith.collection_name,
        hadith.hadith_number,
        hadith.chapter_number,
        hadith.chapter_name,
        hadith.text_ar,
        hadith.text_en,
        hadith.narrator_en,
        hadith.grade,
        `[${embedding.join(',')}]`,
      ],
    );
  }

  async getSeededHadithIds(): Promise<Set<string>> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM hadith_entries WHERE embedding IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.id));
  }
}
