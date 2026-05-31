/**
 * NDJSON framing for net.Socket — 줄 단위로 JSON 메시지 파싱.
 *
 * 한 청크에 여러 메시지가 올 수도, 한 메시지가 여러 청크에 걸쳐 올 수도 있어서
 * 버퍼링 + 줄바꿈 split 필요.
 */

import type { Socket } from "node:net";
import type { JsonRpcMessage } from "./protocol.js";

export interface NdjsonReader {
  on(event: "message", listener: (msg: JsonRpcMessage) => void): NdjsonReader;
  on(event: "error", listener: (err: Error) => void): NdjsonReader;
  on(event: "end", listener: () => void): NdjsonReader;
  emit(event: string, ...args: unknown[]): boolean;
}

export function attachNdjsonReader(sock: Socket): NdjsonReader {
  const reader = new EventEmitterShim();
  let buffer = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        reader.emit("message", msg);
      } catch (err) {
        reader.emit("error", err as Error);
      }
    }
  });
  sock.on("end", () => reader.emit("end"));
  sock.on("error", (err) => reader.emit("error", err));
  return reader;
}

export function writeMessage(sock: Socket, msg: JsonRpcMessage): boolean {
  return sock.write(JSON.stringify(msg) + "\n");
}

// 작은 EventEmitter shim — 외부 의존성 안 늘리려고
import { EventEmitter as NodeEventEmitter } from "node:events";
class EventEmitterShim extends NodeEventEmitter {}
