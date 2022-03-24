import {
  createMessage,
  invalidateMessageType,
  Message
} from "@truffle/dashboard-message-bus-common";
import { DashboardMessageBusConnection } from "lib/connection";

interface PublishMessageLifecycleOptions {
  message: Message;
  connection: DashboardMessageBusConnection;
}

export class PublishMessageLifecycle<
  MessageType extends Message,
  ResponseType extends Message
> {
  /**
   * The initially published message that triggered the creation of this message lifecycle.
   */
  readonly message: MessageType;

  /**
   * The response to the message that was published, or null when that message
   * has been invalidated.
   */
  readonly response: Promise<ResponseType | null>;

  private _connection: DashboardMessageBusConnection;
  private _responsePromiseResolve: (err: any) => void;

  private _responseReceived: boolean = false;
  private _invalidated: boolean = false;

  constructor({ message, connection }: PublishMessageLifecycleOptions) {
    this.message = message as MessageType;
    const self = this;

    /*
     * Resolving with `null` is the best of the bad options when a message is
     * invalidated
     *
     * Other options included rejecting with an error, and simply letting the
     * promise go unresolved.
     *
     * Letting the promise go unresolved is worst option, as it prevents the `finally`
     * block/handler from ever running.
     *
     * Rejecting with an error is maybe okay, but there's nothing to prompt the
     * consumer of this library to know that they'll need to catch this error or
     * else they'll encounter terminations due to unresolved promises.
     *
     * Returning null means that authors writing TS code against this library
     * will at least have some indicator that the message invalidation mechanism
     * exists, and they may need to write code to handle it.
     *
     */
    this.response = new Promise<ResponseType | null>(resolve => {
      self._responsePromiseResolve = resolve;

      function messageHandler(response: ResponseType) {
        if (self._invalidated) {
          connection.off("message", messageHandler);
          return resolve(null);
        }

        if (response.id === message.id) {
          self._responseReceived = true;
          connection.off("message", messageHandler);
          return resolve(response);
        }

        if (invalidatesMessage({ response, message })) {
          self._invalidated = true;
          return resolve(null);
        }
      }

      connection.on("message", messageHandler);
    });
  }

  /**
   * Notify other potential subscribers of this message that it has been
   * invalidated, and they therefore should not respond.
   */
  async invalidate(): Promise<void> {
    if (this._invalidated || this._responseReceived) {
      return;
    }

    this._invalidated = true;

    await this._connection.send(
      createMessage(invalidateMessageType, this.message.id)
    );
  }
}

interface InvalidatesMessageOptions {
  response: Message;
  message: Message;
}

function invalidatesMessage({
  response,
  message
}: InvalidatesMessageOptions): boolean {
  if (
    response.type !== invalidateMessageType &&
    message.type !== invalidateMessageType
  ) {
    return false;
  }

  return response.payload === message.id;
}
