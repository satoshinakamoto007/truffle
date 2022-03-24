import WebSocket from "isomorphic-ws";
import axios from "axios";
import {
  base64ToJson,
  jsonToBase64,
  Message
} from "@truffle/dashboard-message-bus-common";

import debugModule from "debug";

import { MessageBusConnectionError } from "../errors";
import {
  DashboardMessageBusConnectionEvents,
  DashboardMessageBusConnectionOptions,
  SocketEventHandlerMap
} from "./types";

import { TypedEmitter } from "tiny-typed-emitter";

const debug = debugModule("dashboard-message-bus-client:connection");
const debugMessage = debugModule("dashboard-message-bus-client:message");

type HandlerFactory<T> = (
  resolve: (result: T) => void,
  reject: (err?: any) => void
) => SocketEventHandlerMap;

export class DashboardMessageBusConnection extends TypedEmitter<DashboardMessageBusConnectionEvents> {
  private _connectionType: "publish" | "subscribe";
  private _socket: WebSocket | undefined;
  private _host: string;
  private _port: number;
  private _publishPort: number | undefined;
  private _subscribePort: number | undefined;

  constructor({
    host,
    port,
    publishPort,
    subscribePort,
    connectionType: socketType
  }: DashboardMessageBusConnectionOptions) {
    super();
    this._host = host;
    this._port = port;
    this._publishPort = publishPort;
    this._subscribePort = subscribePort;
    this._connectionType = socketType;
    debug("constructor: constructed %s connection", this._connectionType);
  }

  get isConnected() {
    return this._socket && this._socket.readyState === WebSocket.OPEN;
  }

  get isConnecting() {
    return this._socket && this._socket.readyState === WebSocket.CONNECTING;
  }

  get isClosing() {
    return this._socket && this._socket.readyState === WebSocket.CLOSING;
  }

  async connect(): Promise<void> {
    debug("connect: %s connection called connect()", this._connectionType);
    if (this._socket && this._socket.readyState === WebSocket.OPEN) {
      debug("connect: connection already active");
      return;
    }

    if (this._socket && this._socket.readyState > WebSocket.OPEN) {
      debug("connect: removing existing closed connection");
      delete this._socket;
    }

    if (!this._socket) {
      const port = await this._getMessageBusPort();
      // check again in case something else called `connect` at the same time
      if (!this._socket) {
        const url = `ws://${this._host}:${port}`;
        debug(
          "connect: opening new %s connection to %s",
          this._connectionType,
          url
        );
        this._socket = new WebSocket(url);

        this._socket?.addEventListener(
          "message",
          ((event: WebSocket.MessageEvent) => {
            if (typeof event.data !== "string") {
              event.data = event.data.toString();
            }

            const message = base64ToJson(event.data);
            debugMessage(
              "%s connection received message %o",
              this._connectionType,
              message
            );
            this.emit("message", message);
          }).bind(this)
        );
      }
    }

    // we now have a socket that's in the process of opening, so return a
    // promise that resolves when it opens, or fails to open
    return this._createEventWrapperPromise((resolve, reject) => {
      return {
        open: () => {
          debug("connect: %s connection succeeded", this._connectionType);
          if (this._connectionType === "subscribe") {
            this._socket?.send("ready");
          }
          resolve();
        },

        error: (event: WebSocket.ErrorEvent) => {
          debug(
            "connect: %s connection failed due to error %s",
            this._connectionType,
            event.error
          );
          reject(
            new MessageBusConnectionError({
              message: event.error.message,
              cause: event.error
            })
          );
        },

        close: (event: WebSocket.CloseEvent) => {
          debug(
            "connect: %s connection closed before successfully connecting due to code %s and reason %s",
            this._connectionType,
            event.code,
            event.reason
          );
          reject(
            new MessageBusConnectionError({
              message: `Socket connection closed with code '${event.code}' and reason '${event.reason}'`
            })
          );
        }
      };
    });
  }

  async send(message: Message): Promise<void>;
  async send(data: string): Promise<void>;
  async send(dataOrMessage: string | Message): Promise<void> {
    const encodedMessage =
      typeof dataOrMessage === "string"
        ? dataOrMessage
        : jsonToBase64(dataOrMessage);

    debug("send: %s connection calling connect()", this._connectionType);
    await this.connect();

    debug(
      "send: %s connection sending %o",
      this._connectionType,
      base64ToJson(encodedMessage)
    );
    this._socket?.send(encodedMessage);
  }

  async close(): Promise<void> {
    if (!this._socket) {
      debug(
        "close: requested to close %s connection that has no active socket",
        this._connectionType
      );
      return;
    }

    if (this._socket.readyState <= WebSocket.CLOSING) {
      const promise = this._createEventWrapperPromise<void>(
        (resolve, reject) => {
          return {
            error: (event: WebSocket.ErrorEvent) => {
              reject(event.error);
            },
            close: () => {
              resolve();
            }
          };
        }
      );
      this._socket?.close();
      return promise;
    } else {
      const state =
        this._socket.readyState === WebSocket.CLOSING ? "closing" : "closed";
      debug(
        "close: requested to close %s connection that was already %s",
        this._connectionType,
        state
      );
    }
  }

  private async _getMessageBusPort(): Promise<number> {
    if (this._connectionType === "subscribe" && this._subscribePort) {
      debug(
        "_getMessageBusPort: subscribe connection was given pre-resolved port %s",
        this._subscribePort
      );
      return this._subscribePort;
    }

    if (this._connectionType === "publish" && this._publishPort) {
      debug(
        "_getMessageBusPort: publish connection was given pre-resolved port %s",
        this._publishPort
      );
      return this._publishPort;
    }

    // otherwise, fetch it from the server
    debug(
      "_getMessageBusPort: fetching ports for %s connection",
      this._publishPort
    );
    try {
      const { data } = await axios.get(
        `http://${this._host}:${this._port}/ports`
      );

      const port =
        this._connectionType === "subscribe"
          ? data.subscribePort
          : data.publishPort;

      debug("_getMessageBusPort: using %s port", this._connectionType, port);

      return port;
    } catch (err) {
      debug(
        "_getMessageBusPort: failed fetching ports for %s connection due to error %s",
        this._connectionType,
        err
      );
      throw err;
    }
  }

  private _createEventWrapperPromise<T>(
    handlerFactory: HandlerFactory<T>
  ): Promise<T> {
    return new Promise<T>(
      ((resolve: (result: T) => void, reject: (err?: any) => void) => {
        this._registerEventHandlers(handlerFactory.call(this, resolve, reject));
      }).bind(this)
    );
  }

  private _registerEventHandlers(handlers: SocketEventHandlerMap) {
    debug(
      "_registerEventHandlers: called on %s connection",
      this._connectionType
    );
    let wrappedHandlers: SocketEventHandlerMap = {};
    for (const eventType in handlers) {
      wrappedHandlers[eventType] = ((...args: any[]) => {
        handlers[eventType].call(this, ...args);
        this._cleanUpEventHandlers(wrappedHandlers);
      }).bind(this);
      this._socket?.addEventListener(eventType, wrappedHandlers[eventType]);
    }
  }
  private _cleanUpEventHandlers(handlers: SocketEventHandlerMap) {
    for (const eventType in handlers) {
      debug(
        "_cleanUpEventHandlers: %s connection removing %s handler",
        this._connectionType,
        eventType
      );
      this._socket?.removeEventListener(eventType, handlers[eventType]);
    }
  }
}
