import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('quran_surahs')
export class QuranSurahEntity {
  @PrimaryColumn({ type: 'int' })
  surah_number!: number;

  @Column({ type: 'text' })
  name_en!: string;

  @Column({ type: 'text' })
  name_bn!: string;

  // Stored as text in TypeORM; actual DB column is vector(768) managed via raw SQL
  @Column({ type: 'text', nullable: true })
  embedding!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  seeded_at!: Date | null;
}
