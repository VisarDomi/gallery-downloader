import { Server } from 'socket.io';
import { Server as HttpServer } from 'https';

class SocketService {
    private io: Server | null = null;

    public init(server: HttpServer) {
        this.io = new Server(server, {
            cors: { origin: "*" }
        });
        console.log('Socket.IO initialized');
    }

    public emitLog(message: string) {
        this.io?.emit('log_chunk', message);
    }

    public emitStatus(status: any) {
        this.io?.emit('status_update', status);
    }
}

export const socketService = new SocketService();