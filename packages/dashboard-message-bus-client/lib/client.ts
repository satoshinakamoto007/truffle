import {
  DashboardMessageBusClientOptions,
  SendOptions,
  ResolvedDashboardMessageBusClientOptions,
  ReceiveMessageOptions
} from "./types";
import {
  createMessage,
  Message,
  Response
} from "@truffle/dashboard-message-bus-common";

import { DashboardMessageBusConnection } from "./connection";
import delay from "delay";
import debugModule from "debug";
import { PublishMessageLifecycle, ReceivedMessageLifecycle } from "./lifecycle";

const debug = debugModule(`dashboard-message-bus-client:client`);

export class DashboardMessageBusClient {
  private _options: ResolvedDashboardMessageBusClientOptions;

  private _publishConnection: DashboardMessageBusConnection;
  private _subscribeConnection: DashboardMessageBusConnection;

  public get options(): ResolvedDashboardMessageBusClientOptions {
    return { ...this._options };
  }

  public constructor(options: DashboardMessageBusClientOptions) {
    this._options = {
      host: "localhost",
      port: 24012,
      maxRetries: 4,
      retryDelayMsec: 1000,
      ...(options ?? {})
    };

    const { host, port, publishPort, subscribePort } = this._options;
    this._publishConnection = new DashboardMessageBusConnection({
      host,
      port,
      publishPort,
      connectionType: "publish"
    });

    this._subscribeConnection = new DashboardMessageBusConnection({
      host,
      port,
      subscribePort,
      connectionType: "subscribe"
    });
  }

  async ready() {
    await Promise.all([
      this._publishConnection.connect(),
      this._subscribeConnection.connect()
    ]);
  }

  async publish<MessageType extends Message, ResponseType extends Response>(
    options: SendOptions
  ): Promise<PublishMessageLifecycle<MessageType, ResponseType>> {
    const { type, payload, bestEffort } = options;
    let message = createMessage(type, payload);
    try {
      return await this._withRetriesAsync(
        (async () => {
          debug("publisher sending message %o", message);
          await this._publishConnection.send(message);
          return new PublishMessageLifecycle({
            message,
            connection: this._publishConnection
          });
        }).bind(this),
        bestEffort
      );
    } catch (err) {
      debug("sending message %o failed due to error %s", message, err);
      throw err;
    }
  }

  async receiveSingleMessage<MessageType extends Message>(
    options: ReceiveMessageOptions
  ): Promise<ReceivedMessageLifecycle<MessageType>> {
    const { id, type } = options;
    try {
      const predicate = (response: Message) =>
        (id === undefined || response.id === id) &&
        (type === undefined || response.type === type);

      await this._withRetriesAsync(
        async () => this._subscribeConnection.connect(),
        false
      );

      return await new Promise<ReceivedMessageLifecycle<MessageType>>(
        resolve => {
          const messageHandler = (message: MessageType) => {
            if (predicate(message)) {
              debug(
                "subscriber with filter %o received message %o",
                options,
                message
              );
              this._subscribeConnection.off("message", messageHandler);
              resolve(
                new ReceivedMessageLifecycle<MessageType>({
                  message,
                  connection: this._subscribeConnection
                })
              );
            }
          };

          this._subscribeConnection.on("message", messageHandler);
        }
      );
    } catch (err) {
      debug("subscriber receiving message failed due to error %s", err);
      throw err;
    }
  }

  async *subscribe<MessageType extends Message>(
    options: ReceiveMessageOptions
  ): AsyncIterable<ReceivedMessageLifecycle<MessageType>> {
    while (true) {
      // TODO: this needs to be refactored, as the `.once`-like behaviour of
      // `receiveSingleMessage` will cause us to miss messages w/ this approach
      yield this.receiveSingleMessage<MessageType>(options);
    }
  }

  async close(): Promise<void> {
    await this._subscribeConnection?.close();
    await this._publishConnection?.close();
  }

  async _withRetriesAsync(f: Function, bestEffort: boolean | undefined) {
    const { maxRetries, retryDelayMsec } = this._options;

    for (let tryCount = 0; tryCount <= maxRetries; tryCount++) {
      try {
        const result = f.call(this);
        if (result.then) {
          // ensure any promise rejections are handled here so we count them as
          // failures to retry
          return await result;
        } else {
          return result;
        }
      } catch (err) {
        debug("Retry failed, %s of %s tries remaining", tryCount, maxRetries);
        if (tryCount < maxRetries) {
          await delay(retryDelayMsec);
        }
        if (tryCount == maxRetries && !bestEffort) {
          throw err;
        }
      }
    }
  }
}

export class TaskTrackingDashboardMessageBusClient extends DashboardMessageBusClient {
  private static _singletonInstance: TaskTrackingDashboardMessageBusClient | null;
  private _outstandingTasks: Map<Promise<any>, true> = new Map<
    Promise<any>,
    true
  >();

  public constructor(options: DashboardMessageBusClientOptions) {
    super(options);
  }

  static getSingletonInstance(options: DashboardMessageBusClientOptions) {
    if (!TaskTrackingDashboardMessageBusClient._singletonInstance) {
      const instanceProxyHandler: ProxyHandler<TaskTrackingDashboardMessageBusClient> =
        {
          get: (target: any, propertyName) => {
            const prop: any = target[propertyName];

            if (typeof prop === "function") {
              return target._wrapFunction(prop);
            }
            return prop;
          }
        };

      const constructorProxyHandler: ProxyHandler<
        typeof TaskTrackingDashboardMessageBusClient
      > = {
        construct: (target, args) => {
          return new Proxy(
            new TaskTrackingDashboardMessageBusClient(args[0]),
            instanceProxyHandler
          );
        }
      };

      const ProxiedDashboardMessageBusClient = new Proxy(
        TaskTrackingDashboardMessageBusClient,
        constructorProxyHandler
      );

      TaskTrackingDashboardMessageBusClient._singletonInstance =
        new ProxiedDashboardMessageBusClient(options);
    }

    return TaskTrackingDashboardMessageBusClient._singletonInstance;
  }

  async waitForOutstandingTasks(): Promise<void> {
    await Promise.all(this._outstandingTasks);
  }

  private _wrapFunction(f: Function): (...args: any[]) => Promise<unknown> {
    return ((...args: any[]) => {
      const returnValue = f.call(this, ...args);

      if (typeof returnValue.then === "function") {
        this._outstandingTasks.set(returnValue, true);

        return returnValue
          .then((val: Promise<unknown>) => {
            try {
              return val;
            } finally {
              this._outstandingTasks.delete(returnValue);
            }
          })
          .catch((err: any) => {
            try {
              throw err;
            } finally {
              this._outstandingTasks.delete(returnValue);
            }
          });
      }
      return returnValue;
    }).bind(this);
  }
}
