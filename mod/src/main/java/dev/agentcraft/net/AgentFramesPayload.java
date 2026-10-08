package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import java.util.List;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/**
 * The agents of a shared HQ for one tick. Client to server from the host (the one player whose game
 * simulates them, {@link HqRolePayload}); server to client, the same frames relayed to every other
 * player there. One source for everyone: all players see the same scene.
 */
public record AgentFramesPayload(int tick, List<AgentFrame> frames) implements CustomPacketPayload {
	/** More agents than any team has; a bound on what a client may send. */
	public static final int MAX_FRAMES = 32;
	public static final Type<AgentFramesPayload> TYPE = new Type<>(AgentCraft.id("agents"));
	public static final StreamCodec<RegistryFriendlyByteBuf, AgentFramesPayload> CODEC = StreamCodec.composite(
		ByteBufCodecs.VAR_INT, AgentFramesPayload::tick,
		AgentFrame.CODEC.apply(ByteBufCodecs.list(MAX_FRAMES)), AgentFramesPayload::frames,
		AgentFramesPayload::new);

	@Override
	public Type<? extends CustomPacketPayload> type() {
		return TYPE;
	}
}
