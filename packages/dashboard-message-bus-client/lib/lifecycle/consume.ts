import { Message, Response } from "@truffle/dashboard-message-bus-common";
import { DashboardMessageBusConnection } from "lib/connection";
import { AlreadyRespondedError } from "../errors";

interface ReceivedMessageLifecycleOptions<MessageType extends Message> {
  message: MessageType;
  connection: DashboardMessageBusConnection;
}

/**
 *
 */
export class ReceivedMessageLifecycle<MessageType extends Message> {
  readonly message: MessageType;

  private _connection: DashboardMessageBusConnection;
  private _responded: boolean = false;

  constructor({
    message,
    connection
  }: ReceivedMessageLifecycleOptions<MessageType>) {
    this.message = message;
    this._connection = connection;
  }

  async respond<ResponseType extends Response>({
    payload
  }: {
    payload: ResponseType["payload"];
  }): Promise<void> {
    if (this._responded) {
      throw new AlreadyRespondedError({ serviceBusMessage: this.message });
    }
    this._responded = true;

    await this._connection.send({ id: this.message.id, payload });
  }
}
