import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Request } from 'express';

interface SupabaseUserResponse {
  email?: string;
}

@Injectable()
export class SupabaseAdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing admin authentication token.');
    }

    const supabaseUrl = this.configService.get<string>('supabase.url');
    const supabaseAnonKey = this.configService.get<string>('supabase.anonKey');
    const adminEmails = this.configService.get<string[]>('supabase.adminEmails') ?? [];

    if (!supabaseUrl || !supabaseAnonKey || adminEmails.length === 0) {
      throw new ForbiddenException('Admin authentication is not configured.');
    }

    try {
      const response = await axios.get<SupabaseUserResponse>(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      const email = response.data.email?.toLowerCase();

      if (!email || !adminEmails.includes(email)) {
        throw new ForbiddenException('This account is not allowed to access admin tools.');
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      throw new UnauthorizedException('Invalid admin authentication token.');
    }
  }

  private extractBearerToken(request: Request): string | null {
    const authorization = request.headers.authorization;
    const [type, token] = authorization?.split(' ') ?? [];

    return type?.toLowerCase() === 'bearer' && token ? token : null;
  }
}
