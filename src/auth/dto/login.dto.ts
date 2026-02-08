import { PickType } from '@nestjs/mapped-types';
import { SignUpDto } from './signup.dto';

export class LoginDto extends PickType(SignUpDto, ['email', 'password']) {}
