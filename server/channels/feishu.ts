import { ChannelNotImplementedError, type ChannelAdapter } from "./types";

/** 飞书渠道桩：接入后在此推送。 */
export function createFeishuChannel(): ChannelAdapter {
  return {
    channel: "feishu",
    async deliverSystemMessage() {
      throw new ChannelNotImplementedError("飞书渠道尚未接入");
    },
  };
}
