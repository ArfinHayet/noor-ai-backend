import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageLogEntity } from '../entities/message-log.entity';

export interface MessageLogListParams {
  page: number;
  limit: number;
  userId?: string;
  ipAddress?: string;
}

export interface MessageLogListResult {
  items: MessageLogEntity[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class MessageLogService {
  constructor(
    @InjectRepository(MessageLogEntity)
    private readonly repo: Repository<MessageLogEntity>,
  ) {}

  async log(data: {
    userId: string;
    ipAddress: string;
    message: string;
    response: string | null;
    source: string;
  }): Promise<void> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.repo.insert(this.repo.create(data));
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;

        console.error('Failed to log message:', {
          attempt,
          maxAttempts,
          data,
          error: error instanceof Error ? error.message : error,
        });

        if (isLastAttempt) {
          throw error;
        }

        await this.delay(attempt * 100);
      }
    }
  }

  async list(params: MessageLogListParams): Promise<MessageLogListResult> {
    const page = Math.max(1, params.page);
    const limit = Math.min(Math.max(1, params.limit), 100);
    const query = this.repo
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (params.userId) {
      query.andWhere('log.userId ILIKE :userId', { userId: `%${params.userId}%` });
    }

    if (params.ipAddress) {
      query.andWhere('log.ipAddress ILIKE :ipAddress', { ipAddress: `%${params.ipAddress}%` });
    }

    const [items, total] = await query.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
