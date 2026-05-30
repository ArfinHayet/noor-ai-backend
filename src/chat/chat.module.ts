import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { GeminiModule } from '../gemini/gemini.module';
import { McpModule } from '../mcp/mcp.module';
import { RagModule } from '../rag/rag.module';
import { GeoService } from '../common/services/geo.service';
import { SupabaseAdminGuard } from '../common/guards/supabase-admin.guard';
import { MessageLogEntity } from './entities/message-log.entity';
import { MessageLogService } from './services/message-log.service';

@Module({
  imports: [GeminiModule, McpModule, RagModule, TypeOrmModule.forFeature([MessageLogEntity])],
  controllers: [ChatController],
  providers: [ChatService, GeoService, MessageLogService, SupabaseAdminGuard],
})
export class ChatModule {}
