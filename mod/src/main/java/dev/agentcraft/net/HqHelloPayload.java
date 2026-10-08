package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/**
 * Server to client: "this server is the AgentCraft HQ", with its layout (anchors JSON, see
 * {@code Anchors.toJson}). Sent when a player joins the HQ and again whenever the layout changes.
 * Clients turn AgentCraft on (agents, HUD, keys, Foreman link) only while they are on a server that
 * said so, so the mod stays silent on the other servers of a network.
 */
public record HqHelloPayload(String layoutJson) implements CustomPacketPayload {
	public static final Type<HqHelloPayload> TYPE = new Type<>(AgentCraft.id("hq"));
	/** A layout is a few KB; a megabyte is room to spare and still a bound. */
	public static final StreamCodec<RegistryFriendlyByteBuf, HqHelloPayload> CODEC = StreamCodec.composite(
		ByteBufCodecs.stringUtf8(1 << 20), HqHelloPayload::layoutJson, HqHelloPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return TYPE;
	}
}
