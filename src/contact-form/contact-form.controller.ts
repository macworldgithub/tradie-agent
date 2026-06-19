import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ContactFormService } from './contact-form.service';
import { CreateContactFormDto } from './dtos/create-contact-form.dto';

@ApiTags('Contact Form')
@Controller('contact-form')
export class ContactFormController {
  constructor(private readonly contactFormService: ContactFormService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new contact form message' })
  async create(@Body() dto: CreateContactFormDto) {
    const form = await this.contactFormService.create(dto);
    return {
      success: true,
      message: 'Contact form submitted successfully.',
      data: form,
    };
  }
}
