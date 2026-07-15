import { ConfigService } from '@nestjs/config';
import * as path from 'path';

/**
 * Converts an absolute file path to a publicly accessible URL.
 * 
 * @param filePath - Absolute file path (e.g., /var/www/tradie-agent/uploads/number-porting/123/file.pdf)
 * @param configService - NestJS ConfigService to get BASE_URL
 * @returns Public URL (e.g., https://api.example.com/uploads/number-porting/123/file.pdf)
 */
export function filePathToPublicUrl(filePath: string, configService: ConfigService): string {
  const baseUrl = configService.get<string>('BASE_URL') || 'http://localhost:3000';
  
  // Get the relative path from the uploads directory
  const uploadsDir = path.join(process.cwd(), 'uploads');
  const relativePath = path.relative(uploadsDir, filePath);
  
  // Normalize path separators for URLs
  const normalizedPath = relativePath.replace(/\\/g, '/');
  
  return `${baseUrl}/uploads/${normalizedPath}`;
}
