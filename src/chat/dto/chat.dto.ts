import { IsString, IsNotEmpty, MinLength, MaxLength, IsOptional } from 'class-validator';

export class ChatDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(1000)
  message: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  captchaToken?: string;

  @IsString()
  @IsOptional()
  captchaPass?: string;
}

export class TurnstilePassDto {
  @IsString()
  @IsNotEmpty()
  captchaToken: string;
}
