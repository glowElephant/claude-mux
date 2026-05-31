import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { attachNdjsonReader, writeMessage } from "./framing.js";
import type { Socket } from "node:net";

/** 최소 Socket-호환 mock — data/error/end 이벤트 emit + setEncoding/write 흡수 */
function mockSocket(): Socket {
  const e = new EventEmitter() as unknown as Socket & EventEmitter;
  e.setEncoding = vi.fn() as Socket["setEncoding"];
  e.write = vi.fn(() => true) as unknown as Socket["write"];
  return e as Socket;
}

describe("attachNdjsonReader", () => {
  it("parses one message split into multiple data chunks", () => {
    const sock = mockSocket();
    const reader = attachNdjsonReader(sock);
    const onMsg = vi.fn();
    reader.on("message", onMsg);
    const json = '{"jsonrpc":"2.0","id":1,"method":"x","params":{}}';
    // 일부러 1글자씩 쪼개서 emit
    for (const c of json) {
      (sock as unknown as EventEmitter).emit("data", c);
    }
    expect(onMsg).not.toHaveBeenCalled();
    (sock as unknown as EventEmitter).emit("data", "\n");
    expect(onMsg).toHaveBeenCalledTimes(1);
    expect(onMsg).toHaveBeenCalledWith(JSON.parse(json));
  });

  it("parses multiple messages in one chunk", () => {
    const sock = mockSocket();
    const reader = attachNdjsonReader(sock);
    const got: unknown[] = [];
    reader.on("message", (m) => got.push(m));
    const chunk =
      '{"jsonrpc":"2.0","id":1,"method":"a","params":{}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"b","params":{}}\n' +
      '{"jsonrpc":"2.0","id":3,"method":"c","params":{}}\n';
    (sock as unknown as EventEmitter).emit("data", chunk);
    expect(got).toHaveLength(3);
    expect(got.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it("ignores empty lines", () => {
    const sock = mockSocket();
    const reader = attachNdjsonReader(sock);
    const got: unknown[] = [];
    reader.on("message", (m) => got.push(m));
    (sock as unknown as EventEmitter).emit(
      "data",
      '\n\n{"jsonrpc":"2.0","id":1,"method":"x","params":{}}\n\n',
    );
    expect(got).toHaveLength(1);
  });

  it("emits error on malformed JSON line, keeps reading subsequent lines", () => {
    const sock = mockSocket();
    const reader = attachNdjsonReader(sock);
    const got: unknown[] = [];
    const errs: Error[] = [];
    reader.on("message", (m) => got.push(m));
    reader.on("error", (e) => errs.push(e));
    (sock as unknown as EventEmitter).emit(
      "data",
      'not json at all\n{"jsonrpc":"2.0","id":1,"method":"x","params":{}}\n',
    );
    expect(errs).toHaveLength(1);
    expect(got).toHaveLength(1);
  });

  it("emits end on socket end", () => {
    const sock = mockSocket();
    const reader = attachNdjsonReader(sock);
    const onEnd = vi.fn();
    reader.on("end", onEnd);
    (sock as unknown as EventEmitter).emit("end");
    expect(onEnd).toHaveBeenCalled();
  });
});

describe("writeMessage", () => {
  it("serializes JSON + newline and calls sock.write", () => {
    const sock = mockSocket();
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "x", params: {} };
    writeMessage(sock, msg);
    expect(sock.write).toHaveBeenCalledWith(JSON.stringify(msg) + "\n");
  });
});
