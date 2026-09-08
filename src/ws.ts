const WS_URL = process.env.PREDICT_WS_URL ?? "wss://ws.predict.fun/ws";

export type OrderbookSnapshot = {
  version: number;
  marketId: number;
  updateTimestampMs: number;
  orderCount?: number;
  asks: [number, number][];
  bids: [number, number][];
};

type ServerMessage =
  | { type: "R"; requestId: number; success: boolean; error?: { code: string; message?: string } }
  | { type: "M"; topic: string; data: unknown };

export type PredictWs = {
  subscribe: (topic: string) => void;
  unsubscribe: (topic: string) => void;
  close: () => void;
};

type ConnectOptions = {
  apiKey: string;
  onBook: (book: OrderbookSnapshot) => void;
  onReady: () => void;
  onError: (message: string) => void;
};

export function connectOrderbook(options: ConnectOptions): PredictWs {
  let socket: WebSocket | null = null;
  let requestId = 1;
  let closed = false;
  let reconnectAttempt = 0;
  const topics = new Set<string>();

  const send = (payload: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const subscribe = (topic: string) => {
    topics.add(topic);
    send({ method: "subscribe", requestId: requestId++, params: [topic] });
  };

  const unsubscribe = (topic: string) => {
    topics.delete(topic);
    send({ method: "unsubscribe", requestId: requestId++, params: [topic] });
  };

  const open = () => {
    if (closed) return;

    socket = new WebSocket(WS_URL, {
      headers: { "x-api-key": options.apiKey },
    });

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      options.onReady();
      for (const topic of topics) {
        send({ method: "subscribe", requestId: requestId++, params: [topic] });
      }
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        options.onError("Received a non-JSON websocket frame");
        return;
      }

      if (message.type === "R") {
        if (!message.success) {
          options.onError(message.error?.message ?? message.error?.code ?? "subscribe failed");
        }
        return;
      }

      if (message.type !== "M") return;

      if (message.topic === "heartbeat") {
        send({ method: "heartbeat", data: message.data });
        return;
      }

      if (message.topic.startsWith("predictOrderbook/")) {
        options.onBook(message.data as OrderbookSnapshot);
      }
    });

    socket.addEventListener("error", () => {
      options.onError("WebSocket error");
    });

    socket.addEventListener("close", () => {
      if (closed) return;
      const delay = Math.min(15_000, 1000 * 2 ** reconnectAttempt++);
      options.onError(`Disconnected, retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(open, delay);
    });
  };

  open();

  return {
    subscribe,
    unsubscribe,
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
