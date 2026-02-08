// import {
//   CanActivate,
//   ExecutionContext,
//   Injectable,
//   UnauthorizedException,
// } from '@nestjs/common';
// import { JwtService } from '@nestjs/jwt';
// import { AuthenticatedSocket } from 'src/chat/chat-gateway';
// import { JwtPayload } from 'src/common/interfaces/jwtPayload';

// @Injectable()
// export class WsAuthGuard implements CanActivate {
//   constructor(private readonly jwtService: JwtService) {}

//   async canActivate(context: ExecutionContext): Promise<boolean> {
//     const client: AuthenticatedSocket = context.switchToWs().getClient();

//     // console.log(client.handshake);
//     const authHeader = client.handshake.headers?.authorization;

//     const tokenFromHeader =
//       typeof authHeader === 'string' ? authHeader.split(' ')[1] : undefined;

//     const token = (client.handshake.auth?.token as string) || tokenFromHeader;

//     if (!token) {
//       throw new UnauthorizedException('Missing token');
//     }

//     try {
//       const payload: JwtPayload = await this.jwtService.verifyAsync(token);
//       client.data.user = payload;
//       return true;
//     } catch {
//       throw new UnauthorizedException('Invalid token');
//     }
//   }
// }
