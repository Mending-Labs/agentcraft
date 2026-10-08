package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.world.HqWorld;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * The HQ announces itself to its players ({@link HqHelloPayload}): on join, and to everyone online
 * when a new layout is published. Works the same in singleplayer (the integrated server) and on a
 * dedicated HQ server behind a proxy; clients without the mod are simply not sent anything.
 *
 * <p>On a dedicated HQ the agents have one source for everyone: the server names one player the
 * host ({@link HqRolePayload}), whose game simulates the agents and sends them every tick
 * ({@link AgentFramesPayload}); the server relays those frames to every other player. When the
 * host leaves, the next player with the mod takes over (from where the agents are). Frames from
 * anyone but the current host are ignored.
 */
public final class HqNetwork {
	private static volatile @Nullable MinecraftServer server;
	private static volatile @Nullable UUID host;
	private static int ticks;

	private HqNetwork() {
	}

	public static void init() {
		PayloadTypeRegistry.clientboundPlay().register(HqHelloPayload.TYPE, HqHelloPayload.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(HqRolePayload.TYPE, HqRolePayload.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(AgentFramesPayload.TYPE, AgentFramesPayload.CODEC);
		PayloadTypeRegistry.serverboundPlay().register(AgentFramesPayload.TYPE, AgentFramesPayload.CODEC);
		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			host = null;
		});
		ServerPlayConnectionEvents.JOIN.register((handler, sender, s) -> {
			if (!HqWorld.isHq(s)) {
				return;
			}
			hello(handler.getPlayer(), Anchors.current());
		});
		// The host is chosen once a player can take the frames: at JOIN the player is not in the
		// player list yet and its game has not declared its channels (it may only after the login
		// packet), so the server checks every second while there is no host.
		ServerTickEvents.END_SERVER_TICK.register(s -> {
			if (++ticks % 20 == 0 && s.isDedicatedServer() && current(s) == null && HqWorld.isHq(s)) {
				electHost(s, null);
			}
		});
		ServerPlayConnectionEvents.DISCONNECT.register((handler, s) -> {
			UUID h = host;
			if (s.isDedicatedServer() && h != null && h.equals(handler.getPlayer().getUUID())) {
				host = null;
				electHost(s, h);
			}
		});
		ServerPlayNetworking.registerGlobalReceiver(AgentFramesPayload.TYPE, (payload, context) -> {
			MinecraftServer s = context.server();
			ServerPlayer from = context.player();
			if (!s.isDedicatedServer() || !HqWorld.isHq(s) || !from.getUUID().equals(host)) {
				return;
			}
			for (ServerPlayer p : s.getPlayerList().getPlayers()) {
				if (p != from && ServerPlayNetworking.canSend(p, AgentFramesPayload.TYPE)) {
					ServerPlayNetworking.send(p, payload);
				}
			}
		});
		// a new layout (an HQ build) reaches every player already there
		Anchors.addListener(layout -> {
			MinecraftServer s = server;
			if (s == null || !s.isRunning() || !HqWorld.isHq(s)) {
				return;
			}
			s.execute(() -> s.getPlayerList().getPlayers().forEach(p -> hello(p, layout)));
		});
	}

	/** The host if they are still online. */
	private static @Nullable ServerPlayer current(MinecraftServer s) {
		UUID h = host;
		return h == null ? null : s.getPlayerList().getPlayer(h);
	}

	/** The first player (other than {@code leaving}) whose game can simulate the agents becomes the host. */
	private static void electHost(MinecraftServer s, @Nullable UUID leaving) {
		ServerPlayer chosen = null;
		for (ServerPlayer p : s.getPlayerList().getPlayers()) {
			if (!p.getUUID().equals(leaving) && ServerPlayNetworking.canSend(p, AgentFramesPayload.TYPE)) {
				chosen = p;
				break;
			}
		}
		if (chosen == null) {
			host = null;
			return; // nobody can take the frames yet: everyone keeps waiting, checked again in a second
		}
		host = chosen.getUUID();
		AgentCraft.LOGGER.info("HQ host: {} (simulates the agents for everyone)", chosen.getName().getString());
		for (ServerPlayer p : s.getPlayerList().getPlayers()) {
			if (!p.getUUID().equals(leaving)) {
				role(p, p == chosen);
			}
		}
	}

	private static void role(ServerPlayer player, boolean isHost) {
		if (ServerPlayNetworking.canSend(player, HqRolePayload.TYPE)) {
			ServerPlayNetworking.send(player, new HqRolePayload(isHost));
		}
	}

	private static void hello(ServerPlayer player, Anchors.Layout layout) {
		if (!ServerPlayNetworking.canSend(player, HqHelloPayload.TYPE)) {
			return;
		}
		try {
			ServerPlayNetworking.send(player, new HqHelloPayload(Anchors.toJson(layout).toString()));
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.warn("Could not send the HQ layout to {}", player.getName().getString(), e);
		}
	}
}
