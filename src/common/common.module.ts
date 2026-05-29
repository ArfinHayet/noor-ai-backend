import { Global, Module } from '@nestjs/common';
import { TurnstileService } from './services/turnstile.service';

@Global()
@Module({
  providers: [TurnstileService],
  exports: [TurnstileService],
})
export class CommonModule {}
