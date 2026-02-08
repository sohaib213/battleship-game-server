import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(email: string, username: string, password: string) {
    const existUserEmail = await this.prisma.users.findUnique({
      where: { email },
    });
    if (existUserEmail) {
      throw new ConflictException('email already exists');
    }

    const existUserUsername = await this.prisma.users.findUnique({
      where: { username },
    });
    if (existUserUsername) {
      throw new ConflictException('username already exists');
    }
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = this.prisma.users.create({
      data: {
        email,
        username,
        password: hashedPassword,
      },
      select: {
        email: true,
        username: true,
      },
    });

    return newUser;
  }

  findAll() {
    return `This action returns all users`;
  }

  findOne(email: string) {
    return this.prisma.users.findUnique({
      where: { email },
    });
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
