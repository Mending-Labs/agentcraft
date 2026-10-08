package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/**
 * Server to client on a dedicated HQ: {@code host} = your game simulates the agents and sends them
 * to the server ({@link AgentFramesPayload}); otherwise it shows the frames the server relays.
 * Exactly one player present is the host; when they leave, the next one takes over.
 */
public record HqRolePayload(boolean host) implements CustomPacketPayload {
	public static final Type<HqRolePayload> TYPE = new Type<>(AgentCraft.id("hq_role"));
	public static final StreamCodec<RegistryFriendlyByteBuf, HqRolePayload> CODEC = StreamCodec.composite(
		ByteBufCodecs.BOOL, HqRolePayload::host, HqRolePayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return TYPE;
	}
}
