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
import { Mutex } from 'async-mutex';

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      username: string;
    };
    gameId?: string;
  };
}

interface PlayerInfo {
  userId: string;
  board?: boolean[][];
  shipsPlaced: boolean;
  firedPositions: Set<string>;
}

interface GameInfo {
  players: PlayerInfo[];
  currentTurn: string;
  status: 'waiting' | 'ready' | 'in_progress' | 'finished';
  createdAt: Date;
}

enum GameEvents {
  JOIN_GAME = 'join_game',
  GAME_READY = 'game_ready',
  GAME_START = 'game_start',
  PLAYER_LEFT = 'player_left',
  PLACE_SHIPS = 'place_ships',
  FIRE = 'fire',
  FIRED = 'fired',
  ERROR = 'error',
  FINISH_GAME = 'finish_game',
  TURN_CHANGE = 'turn_change',
  LEAVE_GAME = 'leave_game',
}

@WebSocketGateway({
  cors: { origin: '*' },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly jwtService: JwtService) {}
  @WebSocketServer()
  server: Server;

  private connectedUsers = new Map<string, string>(); // userId -> socketId
  private games = new Map<string, GameInfo>(); // gameId -> GameInfo
  private waitingGameId: string | null = null;

  // locks
  private connectionLocks = new Map<string, Mutex>(); // userId -> Mutex
  private gameLocks = new Map<string, Mutex>(); // gameId -> Mutex

  private authenticateClient(client: AuthenticatedSocket): boolean {
    const authHeader = client.handshake.headers?.authorization;
    const tokenFromHeader =
      typeof authHeader === 'string' ? authHeader.split(' ')[1] : undefined;
    const token = (client.handshake.auth?.token as string) || tokenFromHeader;

    if (!token) {
      client.emit(GameEvents.ERROR, 'No token provided');
      client.disconnect();
      return false;
    }

    try {
      const payload: JwtPayload = this.jwtService.verify(token);
      client.data.user = payload;
      return true;
    } catch {
      client.emit(GameEvents.ERROR, 'Invalid token');
      client.disconnect();
      return false;
    }
  }

  private generateGameId(): string {
    return `game_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private getClientById(socketId: string): AuthenticatedSocket | undefined {
    return this.server.sockets.sockets.get(socketId) as AuthenticatedSocket;
  }

  private getConnectionLock(userId: string): Mutex {
    if (!this.connectionLocks.has(userId)) {
      this.connectionLocks.set(userId, new Mutex());
    }
    return this.connectionLocks.get(userId)!;
  }

  private getGameLock(gameId: string): Mutex {
    if (!this.gameLocks.has(gameId)) {
      this.gameLocks.set(gameId, new Mutex());
    }
    return this.gameLocks.get(gameId)!;
  }

  async handleConnection(client: AuthenticatedSocket) {
    if (!this.authenticateClient(client)) {
      return;
    }

    const payload = client.data.user;
    const userLock = this.getConnectionLock(payload.id);

    await userLock.runExclusive(async () => {
      const oldSocketId = this.connectedUsers.get(payload.id);
      if (oldSocketId && oldSocketId !== client.id) {
        const oldSocket = this.getClientById(oldSocketId);
        if (oldSocket) {
          oldSocket.emit(
            GameEvents.ERROR,
            'You have been disconnected because of a new login.',
          );
          await new Promise<void>((resolve) => {
            oldSocket.disconnect(true);
            setTimeout(resolve, 100);
          });
        }
      }

      this.connectedUsers.set(payload.id, client.id);
      console.log('User connected:', payload.username);
    });
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    const user = client.data.user;
    if (!user) return;

    const userLock = this.getConnectionLock(user.id);

    await userLock.runExclusive(async () => {
      const currentSocketId = this.connectedUsers.get(user.id);
      if (currentSocketId === client.id) {
        this.connectedUsers.delete(user.id);
        console.log('User disconnected:', user.username);
      }

      const gameId = client.data.gameId;
      if (gameId) {
        await this.handlePlayerLeaveGame(gameId, user.id);
      }

      if (!this.connectedUsers.has(user.id)) {
        this.connectionLocks.delete(user.id);
      }
    });
  }

  @SubscribeMessage(GameEvents.JOIN_GAME)
  async handleJoinGame(client: AuthenticatedSocket) {
    const user = client.data.user;

    const joinedRooms = Array.from(client.rooms).filter(
      (room) => room !== client.id,
    );

    if (joinedRooms.length > 0) {
      client.emit(GameEvents.ERROR, 'You are already in a game!');
      return;
    }

    if (this.waitingGameId) {
      const game = this.games.get(this.waitingGameId);

      if (game && game.players.length === 1) {
        const gameId = this.waitingGameId;

        game.players.push({
          userId: user.id,
          shipsPlaced: false,
          firedPositions: new Set(),
        });

        game.status = 'ready';
        this.waitingGameId = null;
        client.data.gameId = gameId;

        // Notify both players
        this.server.to(gameId).emit(GameEvents.GAME_READY, {
          gameId,
          players: game.players.map((p) => ({ userId: p.userId })),
        });

        const gameLock = this.getGameLock(gameId);
        const release = await gameLock.acquire();
        try {
          await client.join(gameId);
        } finally {
          release();
        }
      }
    } else {
      const gameId = this.generateGameId();

      const newGame: GameInfo = {
        players: [
          {
            userId: user.id,
            shipsPlaced: false,
            firedPositions: new Set(),
          },
        ],
        currentTurn: user.id,
        status: 'waiting',
        createdAt: new Date(),
      };

      this.games.set(gameId, newGame);
      this.waitingGameId = gameId;

      client.data.gameId = gameId;

      client.emit('waiting_for_opponent', {
        gameId,
        message: 'Waiting for another player to join...',
      });
      await client.join(gameId);
    }
  }

  @SubscribeMessage(GameEvents.LEAVE_GAME)
  async handleLeaveGame(client: AuthenticatedSocket) {
    const user = client.data.user;
    const gameId = client.data.gameId;

    if (!gameId) {
      client.emit(GameEvents.ERROR, 'You are not in a game');
      return;
    }

    await this.handlePlayerLeaveGame(gameId, user.id);
  }

  private async handlePlayerLeaveGame(gameId: string, userId: string) {
    const game = this.games.get(gameId);
    if (!game) return;

    const otherPlayers = game.players.filter((p) => p.userId !== userId);
    for (const player of otherPlayers) {
      const clientId = this.connectedUsers.get(player.userId);
      if (!clientId) return;
      const socket = this.getClientById(clientId);
      if (socket) {
        socket.emit(GameEvents.PLAYER_LEFT, {
          message: 'Your opponent has left the game',
        });
        await socket.leave(gameId);
        socket.data.gameId = undefined;
      }
    }

    const gameLock = this.getGameLock(gameId);
    const release = await gameLock.acquire();
    try {
      this.games.delete(gameId);
    } finally {
      release();
    }

    if (this.waitingGameId === gameId) {
      this.waitingGameId = null;
    }

    const player = game.players.find((p) => p.userId === userId);
    if (player) {
      const clientId = this.connectedUsers.get(player.userId);
      if (clientId) {
        const socket = this.getClientById(clientId);
        if (socket) {
          await socket.leave(gameId);
          socket.data.gameId = undefined;
        }
      }
    }
  }
  @SubscribeMessage(GameEvents.PLACE_SHIPS)
  handlePlaceShips(
    client: AuthenticatedSocket,
    payload: { board: boolean[][] },
  ) {
    const gameId = client.data.gameId;
    if (!gameId) {
      client.emit(GameEvents.ERROR, 'You are not in a game');
      return;
    }

    const game = this.games.get(gameId);
    if (!game) {
      client.emit(GameEvents.ERROR, 'Game not found');
      return;
    }

    const numberOfPlacedShips = payload.board.reduce(
      (count, row) => count + row.filter((cell) => cell).length,
      0,
    );

    if (numberOfPlacedShips !== 10) {
      client.emit(GameEvents.ERROR, 'You must place exactly 10 ship segments');
      return;
    }

    const player = game.players.find((p) => p.userId === client.data.user.id);
    if (player) {
      player.board = payload.board;
      player.shipsPlaced = true;

      if (game.players.every((p) => p.shipsPlaced)) {
        game.status = 'in_progress';
        this.server.to(gameId).emit(GameEvents.GAME_START, {
          currentTurn: game.currentTurn,
        });
      }
    }
  }

  @SubscribeMessage(GameEvents.FIRE)
  handleFire(client: AuthenticatedSocket, payload: { x: number; y: number }) {
    const gameId = client.data.gameId;
    if (!gameId) {
      client.emit(GameEvents.ERROR, 'You are not in a game');
      return;
    }

    const game = this.games.get(gameId);

    if (!game) {
      client.emit(GameEvents.ERROR, 'Game not found');
      return;
    }

    if (game.status !== 'in_progress') {
      client.emit(GameEvents.ERROR, 'Game is not in progress');
      return;
    }

    if (game.currentTurn !== client.data.user.id) {
      client.emit(GameEvents.ERROR, 'This is not your turn');
      return;
    }

    const { x, y } = payload;

    if (x < 0 || x >= 5 || y < 0 || y >= 5) {
      client.emit(GameEvents.ERROR, 'Invalid coordinates');
      return;
    }

    const opponentPlayer = game.players.find(
      (p) => p.userId !== client.data.user.id,
    );

    if (!opponentPlayer?.board) {
      client.emit(GameEvents.ERROR, 'Opponent board not found');
      return;
    }

    if (opponentPlayer.firedPositions?.has(`${x},${y}`)) {
      client.emit(GameEvents.ERROR, 'You already fired at this position');
      return;
    }

    const hit = opponentPlayer.board[x][y];

    opponentPlayer.board[x][y] = false;

    if (!opponentPlayer.firedPositions) {
      opponentPlayer.firedPositions = new Set();
    }
    opponentPlayer.firedPositions.add(`${x},${y}`);

    this.server.to(gameId).emit(GameEvents.FIRED, {
      x,
      y,
      hit,
      playerId: client.data.user.id,
      opponentId: opponentPlayer.userId,
    });

    if (hit) {
      let stillShips = false;

      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          if (opponentPlayer.board[i][j]) {
            stillShips = true;
            break;
          }
          if (stillShips) break;
        }
      }

      if (!stillShips) {
        game.status = 'finished';
        this.server.to(gameId).emit(GameEvents.FINISH_GAME, {
          winnerId: client.data.user.id,
          loserId: opponentPlayer.userId,
        });
        return;
      }
    }

    game.currentTurn = opponentPlayer.userId;

    this.server.to(gameId).emit(GameEvents.TURN_CHANGE, {
      currentTurn: opponentPlayer.userId,
    });
  }
}
