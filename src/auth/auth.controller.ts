import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { TurnstileService } from '../common/services/turnstile.service';
import { AuthService, AdminLoginResult } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly turnstileService: TurnstileService,
  ) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<AdminLoginResult> {
    await this.turnstileService.verifyToken(dto.captchaToken, req.ip ?? '');
    return this.authService.loginAdmin(dto.email, dto.password);
  }
}
