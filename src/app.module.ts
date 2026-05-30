import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { CacheEntity } from './rag/entities/cache.entity';
import { QuranVerseEntity } from './rag/entities/quran-verse.entity';
import { QuranSurahEntity } from './rag/entities/quran-surah.entity';
import { HadithEntity } from './rag/entities/hadith.entity';
import { GeminiKeyEntity } from './rag/entities/gemini-key.entity';
import { MessageLogEntity } from './chat/entities/message-log.entity';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CommonModule } from './common/common.module';
import { GeminiModule } from './gemini/gemini.module';
import { McpModule } from './mcp/mcp.module';
import { RagModule } from './rag/rag.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('database.url'),
        ssl: { rejectUnauthorized: false },
        synchronize: false,
        logging: false,
        entities: [CacheEntity, QuranVerseEntity, QuranSurahEntity, HadithEntity, GeminiKeyEntity, MessageLogEntity],
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttle.ttl') ?? 60000,
            limit: config.get<number>('throttle.limit') ?? 20,
          },
        ],
      }),
    }),
    CommonModule,
    AuthModule,
    ChatModule,
    GeminiModule,
    McpModule,
    RagModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
