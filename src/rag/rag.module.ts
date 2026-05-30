import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RagService } from './rag.service';
import { CacheEntity } from './entities/cache.entity';
import { QuranVerseEntity } from './entities/quran-verse.entity';
import { QuranSurahEntity } from './entities/quran-surah.entity';
import { HadithEntity } from './entities/hadith.entity';
import { GeminiKeyEntity } from './entities/gemini-key.entity';
import { GeminiKeyService } from './services/gemini-key.service';
import { CryptoService } from '../common/services/crypto.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CacheEntity, QuranVerseEntity, QuranSurahEntity, HadithEntity, GeminiKeyEntity]),
  ],
  providers: [RagService, GeminiKeyService, CryptoService],
  exports: [RagService, GeminiKeyService, CryptoService],
})
export class RagModule {}
