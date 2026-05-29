import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
}

interface TurnstileAccessOptions {
  captchaPass?: string;
  captchaToken?: string;
  ip: string;
}

interface TurnstilePassPayload {
  exp: number;
  ip: string;
  v: 1;
}

export interface TurnstilePass {
  captchaPass: string;
  expiresAt: string;
}

@Injectable()
export class TurnstileService {
  constructor(private readonly configService: ConfigService) {}

  async verifyToken(token: string | undefined, ip: string): Promise<void> {
    const secretKey = this.getSecretKey();

    if (!secretKey) return;

    if (!token) {
      throw new BadRequestException('Turnstile verification is required.');
    }

    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
    });

    if (ip) body.set('remoteip', ip);

    const response = await axios.post<TurnstileResponse>(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    if (!response.data.success) {
      throw new BadRequestException('Turnstile verification failed.');
    }
  }

  async verifyAccess({ captchaPass, captchaToken, ip }: TurnstileAccessOptions): Promise<void> {
    if (!this.getSecretKey()) return;
    if (this.isValidPass(captchaPass, ip)) return;

    await this.verifyToken(captchaToken, ip);
  }

  createPass(ip: string): TurnstilePass {
    const expiresAtMs = Date.now() + this.getPassTtlMs();
    const payload: TurnstilePassPayload = { exp: expiresAtMs, ip: this.getIpFingerprint(ip), v: 1 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.signPassBody(body);

    return {
      captchaPass: `${body}.${signature}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  isValidPass(pass: string | undefined, ip: string): boolean {
    if (!this.getSecretKey() || !pass) return false;

    const [body, signature] = pass.split('.');
    if (!body || !signature) return false;

    const expectedSignature = this.signPassBody(body);
    const signatureBuffer = Buffer.from(signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
    ) {
      return false;
    }

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TurnstilePassPayload;
      return payload.v === 1 && payload.exp > Date.now() && payload.ip === this.getIpFingerprint(ip);
    } catch {
      return false;
    }
  }

  private getSecretKey(): string {
    return this.configService.get<string>('turnstile.secretKey') ?? '';
  }

  private getPassTtlMs(): number {
    return this.configService.get<number>('turnstile.passTtlMs') ?? 86400000;
  }

  private signPassBody(body: string): string {
    return createHmac('sha256', this.getSecretKey()).update(body).digest('base64url');
  }

  private getIpFingerprint(ip: string): string {
    return createHmac('sha256', this.getSecretKey()).update(ip || 'unknown').digest('base64url');
  }
}
