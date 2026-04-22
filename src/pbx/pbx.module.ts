import { Module, forwardRef } from '@nestjs/common';
import { PbxService } from './pbx.service';
import { PbxController } from './pbx.controller';
import { CallModule } from '../call/call.module';

@Module({
  imports: [
    forwardRef(() => CallModule),
  ],
  controllers: [PbxController],
  providers: [PbxService],
  exports: [PbxService],
})
export class PbxModule {}
