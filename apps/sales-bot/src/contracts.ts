export type Actor = { telegramId: string; role: "admin" | "customer" };
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
    photo?: { file_id: string }[];
    document?: { file_id: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id?: number; chat: { id: number; type: string }; text?: string; caption?: string; photo?: { file_id: string }[] };
    data?: string;
  };
}
export type Policy = {
  nodeId: string;
  revision: number;
  expiresAt: number;
  clients: { credentialId: string; uuid: string; validUntil: number }[];
};
export type InstallJob = {
  id: string;
  nodeId: string;
  targetIp: string;
  port: number;
  username: string;
  hostFingerprint: string;
  encryptedCredentials: string;
  credentialsExpireAt: number;
  leaseUntil: number;
  artifactVersion: string;
};
export const epoch = () => Math.floor(Date.now() / 1000);
export function admin(actor: Actor) {
  if (actor.role !== "admin") throw new Error("ADMIN_REQUIRED");
}
