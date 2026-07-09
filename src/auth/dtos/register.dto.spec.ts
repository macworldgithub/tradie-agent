import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  it('should pass validation with a valid cityCode', async () => {
    const dto = new RegisterDto();
    dto.customerName = 'John Doe';
    dto.companyName = 'Tradie Co.';
    dto.email = 'john@example.com';
    dto.password = 'password123';
    dto.trade = 'Plumber';
    dto.mobileNumber = '0412345678';
    dto.country = 'AU';
    dto.notificationPreference = 'both';
    dto.callReceivedOn = 'mobile';
    dto.cityCode = 'sydney';

    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should fail validation when cityCode is missing', async () => {
    const dto = new RegisterDto();
    dto.customerName = 'John Doe';
    dto.companyName = 'Tradie Co.';
    dto.email = 'john@example.com';
    dto.password = 'password123';
    dto.trade = 'Plumber';
    dto.mobileNumber = '0412345678';
    dto.country = 'AU';
    dto.notificationPreference = 'both';
    dto.callReceivedOn = 'mobile';
    // cityCode is missing

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('cityCode');
  });
});
