import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSupportIncidentDto {
  @IsOptional()
  @IsIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])
  status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  resolutionNotes?: string;
}
