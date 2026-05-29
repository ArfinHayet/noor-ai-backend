import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface SupabasePasswordGrantResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user?: {
    id?: string;
    email?: string;
  };
}

export interface AdminLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt?: number;
  tokenType: string;
  user: {
    id?: string;
    email?: string;
  };
}

@Injectable()
export class AuthService {
  constructor(private readonly configService: ConfigService) {}

  async loginAdmin(email: string, password: string): Promise<AdminLoginResult> {
    const supabaseUrl = this.configService.get<string>('supabase.url');
    const supabaseAnonKey = this.configService.get<string>('supabase.anonKey');
    const adminEmails = this.configService.get<string[]>('supabase.adminEmails') ?? [];

    if (!supabaseUrl || !supabaseAnonKey || adminEmails.length === 0) {
      throw new ForbiddenException('Admin authentication is not configured.');
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!adminEmails.includes(normalizedEmail)) {
      throw new ForbiddenException('This account is not allowed to access admin tools.');
    }

    try {
      const response = await axios.post<SupabasePasswordGrantResponse>(
        `${supabaseUrl}/auth/v1/token?grant_type=password`,
        {
          email: normalizedEmail,
          password,
        },
        {
          headers: {
            apikey: supabaseAnonKey,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseEmail = response.data.user?.email?.toLowerCase();

      if (!responseEmail || !adminEmails.includes(responseEmail)) {
        throw new ForbiddenException('This account is not allowed to access admin tools.');
      }

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: response.data.expires_at,
        tokenType: response.data.token_type,
        user: {
          id: response.data.user?.id,
          email: response.data.user?.email,
        },
      };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      throw new UnauthorizedException('Invalid email or password.');
    }
  }
}
