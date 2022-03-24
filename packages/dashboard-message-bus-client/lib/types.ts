import { Message } from "@truffle/dashboard-message-bus-common";

export interface DashboardMessageBusClientOptions {
  host?: string;
  port?: number;
  subscribePort?: number;
  publishPort?: number;
  maxRetries?: number;
  retryDelayMsec?: number;
}

export interface ResolvedDashboardMessageBusClientOptions {
  host: string;
  port: number;
  subscribePort?: number;
  publishPort?: number;
  maxRetries: number;
  retryDelayMsec: number;
}

export interface SendOptions {
  type: string;
  payload: any;
  bestEffort?: boolean;
}

export interface RespondOptions<MessageType extends Message> {
  id: number;
  payload: MessageType["payload"];
  bestEffort?: boolean;
}
export interface ReceiveMessageOptions {
  id?: number;
  type?: string;
}
