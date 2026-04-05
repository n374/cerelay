declare module "@anthropic-ai/claude-agent-sdk" {
  export function query(input: unknown): AsyncIterable<unknown>;
}

declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Socket } from "node:net";

  export default class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readyState: number;
    close(): void;
    send(data: string, cb?: (error?: Error) => void): void;
    on(event: "message", listener: (data: string | Buffer, isBinary: boolean) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer?: boolean });
    close(cb?: () => void): void;
    handleUpgrade(
      request: IncomingMessage,
      socket: Socket,
      head: Buffer,
      cb: (socket: WebSocket, request: IncomingMessage) => void
    ): void;
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    emit(event: "connection", socket: WebSocket, request: IncomingMessage): boolean;
  }
}
