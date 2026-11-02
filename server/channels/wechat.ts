import { ChannelNotImplementedError, type ChannelAdapter } from "./types";

/** 微信渠道桩：接入后在此推送。 */
export function createWechatChannel(): ChannelAdapter {
  return {
    channel: "wechat",
    async deliverSystemMessage() {
      throw new ChannelNotImplementedError("微信渠道尚未接入");
    },
  };
}
