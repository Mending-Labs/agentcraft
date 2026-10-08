package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.world.HqWorld;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
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
 */
public final class HqNetwork {
	private static volatile @Nullable MinecraftServer server;

	private HqNetwork() {
	}

	public static void init() {
		PayloadTypeRegistry.clientboundPlay().register(HqHelloPayload.TYPE, HqHelloPayload.CODEC);
		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> server = null);
		ServerPlayConnectionEvents.JOIN.register((handler, sender, s) -> {
			if (HqWorld.isHq(s)) {
				hello(handler.getPlayer(), Anchors.current());
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
