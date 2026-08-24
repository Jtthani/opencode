import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { HttpRecorderInternal } from "../src/internal"
import type { Interaction } from "../src/schema"

const runWithCassette = <A, E>(
  initial: Record<string, ReadonlyArray<Interaction>>,
  effect: Effect.Effect<A, E, HttpRecorderInternal.Cassette.Service | Scope.Scope>,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(HttpRecorderInternal.Cassette.memory(initial)))))

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? "" : Cause.prettyErrors(exit.cause).join("\n")

describe("WebSocket executor", () => {
  test("returns the live executor in passthrough mode", async () => {
    const sent: string[] = []
    const live = {
      open: () =>
        Effect.succeed({
          sendText: (message: string) =>
            Effect.sync(() => {
              sent.push(message)
            }),
          messages: Stream.empty,
          close: Effect.void,
        }),
    }

    await runWithCassette(
      {},
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        const executor = yield* HttpRecorderInternal.makeWebSocketExecutor({
          name: "direct-passthrough",
          mode: "passthrough",
          cassette,
          live,
        })

        expect(executor).toBe(live)
        const connection = yield* executor.open({ url: "wss://example.test/live", headers: Headers.empty })
        yield* connection.sendText("hello live")
      }),
    )

    expect(sent).toEqual(["hello live"])
  })

  test("records redacted handshake data and observed frames once on close", async () => {
    const sent: string[] = []
    const closes: string[] = []
    const serverText = '{"type":"response.completed","token":"server-secret"}'
    const serverBinary = new Uint8Array([3, 4])
    const live = {
      open: () =>
        Effect.succeed({
          sendText: (message: string) =>
            Effect.sync(() => {
              sent.push(message)
            }),
          messages: Stream.fromIterable([serverText, serverBinary]),
          close: Effect.sync(() => {
            closes.push("closed")
          }),
        }),
    }

    const result = await runWithCassette(
      {},
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        const executor = yield* HttpRecorderInternal.makeWebSocketExecutor({
          name: "direct-record",
          mode: "record",
          cassette,
          live,
        })
        const connection = yield* executor.open({
          url: "wss://example.test/realtime?api_key=secret-key",
          headers: Headers.fromInput({
            authorization: "Bearer secret-token",
            "content-type": "application/json",
          }),
        })
        yield* connection.sendText('{"type":"response.create","token":"client-secret"}')
        const messages = Array.from(yield* Stream.runCollect(connection.messages))
        yield* connection.close
        yield* connection.close

        return { messages, recorded: yield* cassette.read("direct-record") }
      }),
    )

    expect(sent).toEqual(['{"type":"response.create","token":"client-secret"}'])
    expect(closes).toEqual(["closed"])
    expect(result.messages).toEqual([serverText, serverBinary])
    expect(result.recorded).toEqual([
      {
        transport: "websocket",
        open: {
          url: "wss://example.test/realtime?api_key=%5BREDACTED%5D",
          headers: { "content-type": "application/json" },
        },
        events: [
          {
            direction: "client",
            kind: "text",
            body: '{"type":"response.create","token":"[REDACTED]"}',
          },
          {
            direction: "server",
            kind: "text",
            body: '{"type":"response.completed","token":"[REDACTED]"}',
          },
          {
            direction: "server",
            kind: "binary",
            body: "AwQ=",
            bodyEncoding: "base64",
          },
        ],
      },
    ])
  })

  test("replays recorded text and binary frames without opening the live executor", async () => {
    const liveOpens: string[] = []
    const recorded: Interaction = {
      transport: "websocket",
      open: {
        url: "wss://example.test/realtime?api_key=%5BREDACTED%5D",
        headers: { "content-type": "application/json" },
      },
      events: [
        {
          direction: "client",
          kind: "text",
          body: '{"prompt":"hello","token":"[REDACTED]","type":"response.create"}',
        },
        {
          direction: "server",
          kind: "text",
          body: '{"type":"response.completed","token":"[REDACTED]"}',
        },
        {
          direction: "server",
          kind: "binary",
          body: "BQY=",
          bodyEncoding: "base64",
        },
      ],
    }

    const messages = await runWithCassette(
      { "direct-replay": [recorded] },
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        const executor = yield* HttpRecorderInternal.makeWebSocketExecutor({
          name: "direct-replay",
          mode: "replay",
          cassette,
          compareClientMessagesAsJson: true,
          live: {
            open: () =>
              Effect.sync(() => {
                liveOpens.push("opened")
                throw new Error("Replay unexpectedly opened the live WebSocket")
              }),
          },
        })
        const connection = yield* executor.open({
          url: "wss://example.test/realtime?api_key=secret-key",
          headers: Headers.fromInput({ "content-type": "application/json" }),
        })
        yield* connection.sendText('{"type":"response.create","token":"[REDACTED]","prompt":"hello"}')
        const output = Array.from(yield* Stream.runCollect(connection.messages))
        yield* connection.close
        return output
      }),
    )

    expect(liveOpens).toEqual([])
    expect(messages).toEqual(['{"type":"response.completed","token":"[REDACTED]"}', new Uint8Array([5, 6])])
  })

  test("reports replay handshake, client frame, and frame count mismatches", async () => {
    const interaction: Interaction = {
      transport: "websocket",
      open: { url: "wss://example.test/realtime", headers: {} },
      events: [{ direction: "client", kind: "text", body: "expected" }],
    }
    const live = {
      open: () => Effect.die(new Error("Replay unexpectedly opened the live WebSocket")),
    }

    const failures = await runWithCassette(
      {
        "open-mismatch": [interaction],
        "frame-mismatch": [interaction],
      },
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        const openExecutor = yield* HttpRecorderInternal.makeWebSocketExecutor({
          name: "open-mismatch",
          mode: "replay",
          cassette,
          live,
        })
        const open = yield* Effect.exit(
          openExecutor.open({ url: "wss://example.test/different", headers: Headers.empty }),
        )

        const frameExecutor = yield* HttpRecorderInternal.makeWebSocketExecutor({
          name: "frame-mismatch",
          mode: "replay",
          cassette,
          live,
        })
        const connection = yield* frameExecutor.open({
          url: "wss://example.test/realtime",
          headers: Headers.empty,
        })
        const frame = yield* Effect.exit(connection.sendText("actual"))
        const close = yield* Effect.exit(connection.close)
        return { close: failureText(close), frame: failureText(frame), open: failureText(open) }
      }),
    )

    expect(failures.open).toContain("WebSocket open 1 does not match")
    expect(failures.frame).toContain("WebSocket client frame 1: expected")
    expect(failures.close).toContain("WebSocket client frame count: expected 1, received 0")
  })
})
