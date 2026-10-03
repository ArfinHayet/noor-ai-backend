import { BadRequestException, Controller, Post, Get, Body, Req, Res, UseGuards, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import axios from 'axios';
import { IpDailyLimitGuard } from '../common/guards/ip-daily-limit.guard';
import { SupabaseAdminGuard } from '../common/guards/supabase-admin.guard';
import { TurnstilePass, TurnstileService } from '../common/services/turnstile.service';
import { ChatService, ChatResponse } from './chat.service';
import { ChatDto, ChatSummarizeDto, ChatTtsDto, TurnstilePassDto } from './dto/chat.dto';
import { GeoService } from '../common/services/geo.service';
import { MessageLogListResult, MessageLogService } from './services/message-log.service';
import { GeminiService } from '../gemini/gemini.service';

interface PrayerTimesResponse {
  data: unknown;
}

type CachedPrayerTimesResponse = Array<{ '1': unknown; '0': unknown }>;

@Controller('chat')
export class ChatController {
  private static readonly PRAYER_TIMES_CACHE_TIME_ZONE = 'Asia/Dhaka';
  private prayerTimesCache = new Map<string, CachedPrayerTimesResponse>();
  private prayerTimesCacheDate = this.getCacheDateKey();

  constructor(
    private readonly chatService: ChatService,
    private readonly geminiService: GeminiService,
    private readonly geoService: GeoService,
    private readonly messageLogService: MessageLogService,
    private readonly turnstileService: TurnstileService,
  ) {}

  private getCacheDateKey(): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: ChatController.PRAYER_TIMES_CACHE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    return formatter.format(new Date());
  }

  private clearPrayerTimesCacheIfDateChanged(): void {
    const currentDate = this.getCacheDateKey();

    if (this.prayerTimesCacheDate !== currentDate) {
      this.prayerTimesCache.clear();
      this.prayerTimesCacheDate = currentDate;
    }
  }

  private normalizePrayerTimesQueryParam(value?: string): string {
    return value?.trim().toLowerCase() ?? '';
  }

  private getPrayerTimesCacheKey(city: string, country: string): string {
    return `${this.normalizePrayerTimesQueryParam(city)}::${this.normalizePrayerTimesQueryParam(country)}`;
  }

  private async persistMessageLog(data: {
    userId: string;
    ipAddress: string;
    message: string;
    response: string | null;
    source: string;
    failureReason?: string | null;
  }): Promise<void> {
    try {
      await this.messageLogService.log(data);
    } catch (error) {
      console.error('Failed to log chat message:', {
        data,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async verifyChatAccess(dto: { captchaPass?: string; captchaToken?: string }, ip: string): Promise<void> {
    await this.turnstileService.verifyAccess({
      captchaPass: dto.captchaPass,
      captchaToken: dto.captchaToken,
      ip,
    });
  }

  @Post('turnstile-pass')
  async createChatTurnstilePass(@Body() dto: TurnstilePassDto, @Req() req: Request): Promise<TurnstilePass> {
    const ip = req.ip ?? '';
    await this.turnstileService.verifyToken(dto.captchaToken, ip);
    return this.turnstileService.createPass();
  }

  // @Post()
  // async chat(@Body() dto: ChatDto, @Req() req: Request): Promise<ChatResponse> {
  //   const ip = req.ip ?? '';
  //   await this.verifyChatAccess(dto, ip);
  //   const location = await this.geoService.getLocationFromIp(ip, req.headers);
  //   const result = await this.chatService.chat(dto.userId, dto.message, location);
  //   await this.persistMessageLog({
  //     userId: dto.userId,
  //     ipAddress: ip,
  //     message: dto.message,
  //     response: result.reply,
  //     source: result.source,
  //   });
  //   return result;
  // }

  @Post('stream')
  @UseGuards(IpDailyLimitGuard)
  async chatStream(@Body() dto: ChatDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const ip = req.ip ?? '';
    await this.verifyChatAccess(dto, ip);
    const location = await this.geoService.getLocationFromIp(ip, req.headers);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const chunks: string[] = [];
    let source = 'model';
    let mediaEmitted = false;
    let failureReason: string | null = null;

    const FRIENDLY_ERROR_MSG = 'Noor AI encountered an issue. Please try again or rephrase your question.';

    try {
      for await (const event of this.chatService.chatStream(dto.userId, dto.message, location)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'chunk') chunks.push(event.text);
        if (event.type === 'done')  source = event.source;
        if (event.type === 'media') mediaEmitted = true;
        if (event.type === 'error') {
          failureReason = event.message || 'Stream error';
        }
      }

      // ── Silent empty response detection ──────────────────────────────────
      // Stream completed without error but produced no text and no media.
      const fullReply = chunks.join('');
      if (!fullReply && !mediaEmitted && !failureReason) {
        failureReason = 'empty_response: stream completed with no text or media output';
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: FRIENDLY_ERROR_MSG })}\n\n`,
        );
      }
    } catch (err) {
      // ── Exception during streaming ────────────────────────────────────────
      // Store the raw error message for admin visibility.
      failureReason = (err as Error).message;
      res.write(
        `data: ${JSON.stringify({ type: 'error', message: FRIENDLY_ERROR_MSG })}\n\n`,
      );
    } finally {
      await this.persistMessageLog({
        userId: dto.userId,
        ipAddress: ip,
        message: dto.message,
        // Preserve any partial text accumulated before an error
        response: chunks.join('') || null,
        source,
        failureReason,
      });

      if (!res.writableEnded) {
        try {
          res.end();
        } catch (error) {
          console.error('Failed to end chat stream response:', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }
    }
  }

  @Post('summarize/stream')
  @UseGuards(IpDailyLimitGuard)
  async summarizeStream(@Body() dto: ChatSummarizeDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const ip = req.ip ?? '';
    await this.verifyChatAccess(dto, ip);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const summaryChunks: string[] = [];
    let hasText = false;
    let failureReason: string | null = null;

    try {
      for await (const event of this.chatService.summarizeStream(dto.content)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        if (event.type === 'chunk') {
          summaryChunks.push(event.text);
          hasText = true;
        }
        if (event.type === 'error') {
          failureReason = event.message || 'Summary stream error';
        }
      }

      if (!hasText && !failureReason) {
        failureReason = 'empty_response: summary stream completed with no text';
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: 'Could not create a summary. Please try again.',
          })}\n\n`,
        );
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
      console.error('Summary stream failed:', failureReason);
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: 'Could not create a summary. Please try again.',
        })}\n\n`,
      );
    } finally {
      await this.persistMessageLog({
        userId: dto.userId,
        ipAddress: ip,
        message: dto.content,
        response: summaryChunks.join('') || null,
        source: 'summary',
        failureReason,
      });

      if (!res.writableEnded) res.end();
    }
  }

  @Post('tts')
  @UseGuards(IpDailyLimitGuard)
  async textToSpeech(@Body() dto: ChatTtsDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const ip = req.ip ?? '';
    await this.verifyChatAccess(dto, ip);

    const audio = await this.geminiService.generateSpeech(dto.text);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', audio.length.toString());
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(audio);
  }

  @Get('health')
  health(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('admin/message-logs')
  @UseGuards(SupabaseAdminGuard)
  async getMessageLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('userId') userId?: string,
    @Query('ipAddress') ipAddress?: string,
  ): Promise<MessageLogListResult> {
    return this.messageLogService.list({
      page: Number.parseInt(page, 10) || 1,
      limit: Number.parseInt(limit, 10) || 20,
      userId: userId?.trim() || undefined,
      ipAddress: ipAddress?.trim() || undefined,
    });
  }

  @Get('prayer-times')
  async getPrayerTimes(
    @Req() req: Request,
    @Query('city') city?: string,
    @Query('country') country?: string,
  ): Promise<Array<{ '1': unknown; '0': unknown }>> {
    this.clearPrayerTimesCacheIfDateChanged();

    const location = await this.geoService.getLocationFromIp(req.ip ?? '', req.headers);
    const normalizedCity = city?.trim() || location?.city?.trim();
    const normalizedCountry = country?.trim() || location?.country?.trim();

    if (!normalizedCity || !normalizedCountry) {
      throw new BadRequestException('Unable to determine city and country from the request.');
    }

    const cacheKey = this.getPrayerTimesCacheKey(normalizedCity, normalizedCountry);
    const cachedPrayerTimes = this.prayerTimesCache.get(cacheKey);

    if (cachedPrayerTimes) {
      return cachedPrayerTimes;
    }

    const [schoolOneResponse, schoolZeroResponse] = await Promise.all([
      axios.get<PrayerTimesResponse>(
        `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(normalizedCity)}&country=${encodeURIComponent(normalizedCountry)}&school=1`,
      ),
      axios.get<PrayerTimesResponse>(
        `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(normalizedCity)}&country=${encodeURIComponent(normalizedCountry)}&school=0`,
      ),
    ]);

    const prayerTimesResponse = [
      {
        '1': schoolOneResponse.data,
        '0': schoolZeroResponse.data,
      },
    ];

    this.prayerTimesCache.set(cacheKey, prayerTimesResponse);

    return prayerTimesResponse;
  }

  @Get('tafsir')
  async getTafsir(
    @Query('surahNumber') surahNumber: string,
    @Query('startAyah') startAyah?: string,
    @Query('endAyah') endAyah?: string,
  ): Promise<Array<{ verse_number: number; verse_key: string; text_html: string }>> {
    const sNum = Number(surahNumber);
    if (isNaN(sNum) || sNum < 1 || sNum > 114) {
      throw new BadRequestException('Invalid surahNumber. Must be between 1 and 114.');
    }

    const start = startAyah ? Number(startAyah) : 1;
    const end = endAyah ? Number(endAyah) : 300;

    return this.chatService.getRawTafsir(sNum, start, end);
  }
}
