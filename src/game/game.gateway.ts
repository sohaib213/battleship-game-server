import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from 'src/common/interfaces/jwtPayload';

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      username: string;
    };
  };
}

enum GameEvents {
  Join_game = 'join_game',
  Game_Ready = 'game_ready',
}

@WebSocketGateway({
  cors: { origin: '*' },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly jwtService: JwtService) {}

  currentGameId: string = '';

  @WebSocketServer()
  server: Server;

  connectedUsers = new Map<string, string>(); // userId -> socketId

  handleConnection(client: AuthenticatedSocket) {
    const token = client.handshake.auth?.token as string;
    if (!token) {
      client.emit('error', 'No token provided');
      client.disconnect();
      return;
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify(token);
      client.data.user = payload;
      console.log('User connected:', payload.username);
    } catch {
      client.emit('error', 'Invalid token');
      client.disconnect();
      return;
    }

    const oldSocketId = this.connectedUsers.get(payload.id);

    if (oldSocketId) {
      // Get the actual old socket from the server
      const oldSocket = this.server.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.emit(
          'error',
          'You have been disconnected because of a new login.',
        );
        oldSocket.disconnect(true); // force disconnect old socket
      }
    }

    this.connectedUsers.set(payload.id, client.id);
    console.log('User connected:', payload.username);
  }

  handleDisconnect(client: AuthenticatedSocket) {
    console.log('User disconnected:', client.data.user?.username);
  }

  // Join game
  @SubscribeMessage(GameEvents.Join_game)
  async handleJoinGame(client: AuthenticatedSocket) {
    // Check if user is already in any game room (ignore default room = socket.id)
    const joinedRooms = Array.from(client.rooms).filter(
      (room) => room !== client.id,
    );

    if (joinedRooms.length > 0) {
      // User is already in a game
      client.emit('error', 'You are already in a game!');
      return;
    }

    if (this.currentGameId.length !== 0) {
      await client.join(this.currentGameId);
      this.server
        .to(this.currentGameId)
        .emit(GameEvents.Game_Ready, this.currentGameId);
      this.currentGameId = '';
    } else {
      const randomString = Math.random().toString(36).substring(2, 7);
      console.log('new randomString: ', randomString);
      this.currentGameId = randomString;
      await client.join(this.currentGameId);
    }
  }
}
