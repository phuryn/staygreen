import { Hash, Mail, MessageCircle, Send, Webhook } from "lucide-react";
import type { ChannelKind } from "@/lib/model";

const icons = { email: Mail, telegram: Send, slack: Hash, discord: MessageCircle, webhook: Webhook };

export const kindName: Record<ChannelKind, string> = { email: "Email", telegram: "Telegram", slack: "Slack", discord: "Discord", webhook: "Webhook" };

export function ChannelIcon({ kind, size = 18 }: { kind: ChannelKind; size?: number }) {
  const I = icons[kind];
  return <I width={size} height={size} strokeWidth={1.75} aria-hidden="true" />;
}
