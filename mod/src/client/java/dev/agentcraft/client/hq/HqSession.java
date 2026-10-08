package dev.agentcraft.client.hq;

import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.agents.AgentManager;
import dev.agentcraft.hq.HqFeature;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.net.AgentFramesPayload;
import dev.agentcraft.net.HqHelloPayload;
import dev.agentcraft.net.HqRolePayload;
import dev.agentcraft.world.HqWorld;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.client.networking.v1.ClientConfigurationConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;

/**
 * Is the player at the AgentCraft HQ right now? The agents, the HUD, the sounds, the AgentCraft keys
 * and (with a shared Foreman) the Foreman link only run there, so the mod stays silent on the other
 * servers of a network it is installed for.
 *
 * <ul>
 * <li>singleplayer: the open world is the HQ world ("AgentCraft HQ"), as before;</li>
 * <li>multiplayer: the server said so ({@link HqHelloPayload}) since the player arrived on it. A
 * proxy server switch goes back through the configuration phase, which turns it off until the next
 * server speaks; so does a new play session or a disconnect. The layout it sent becomes the client's
 * anchors (on a dedicated server they live in another JVM).</li>
 * </ul>
 *
 * <p>On a dedicated HQ one player is the host ({@link #remoteHost()}): their game simulates the
 * agents and sends them; every other player ({@link #follower()}) shows those frames, so everyone
 * sees the same scene.
 */
public final class HqSession {
	private static volatile boolean remoteHq;
	/** A dedicated HQ named this game the host: it simulates the agents for everyone ({@link HqRolePayload}). */
	private static volatile boolean host;
	private static final List<Runnable> ON_ACTIVE = new CopyOnWriteArrayList<>();

	private HqSession() {
	}

	public static void init() {
		ClientPlayNetworking.registerGlobalReceiver(HqHelloPayload.TYPE, (payload, context) -> onHello(context.client(), payload));
		ClientPlayNetworking.registerGlobalReceiver(HqRolePayload.TYPE, (payload, context) -> {
			if (host != payload.host()) {
				AgentCraft.LOGGER.info(payload.host() ? "This game now runs the HQ agents for everyone" : "Showing the HQ agents of the host");
			}
			host = payload.host();
		});
		ClientPlayNetworking.registerGlobalReceiver(AgentFramesPayload.TYPE, (payload, context) -> AgentManager.get().onFrames(payload));
		ClientPlayConnectionEvents.JOIN.register((handler, sender, mc) -> leave(mc));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> leave(mc));
		ClientConfigurationConnectionEvents.START.register((handler, mc) -> leave(mc));
	}

	/** At the HQ: the singleplayer HQ world, or a server that announced itself as the HQ. */
	public static boolean active() {
		Minecraft mc = Minecraft.getInstance();
		if (mc == null || mc.level == null) {
			return false;
		}
		IntegratedServer local = mc.getSingleplayerServer();
		if (local != null) {
			return HqWorld.isHq(local) || HqFeature.anyWorld();
		}
		return remoteHq;
	}

	/** On a dedicated HQ and not its host: the agents are the host's frames, not our simulation. */
	public static boolean follower() {
		Minecraft mc = Minecraft.getInstance();
		return remoteHq && !host && mc != null && mc.getSingleplayerServer() == null;
	}

	/** On a dedicated HQ and its host: our simulation is sent to the server for the other players. */
	public static boolean remoteHost() {
		Minecraft mc = Minecraft.getInstance();
		return remoteHq && host && mc != null && mc.getSingleplayerServer() == null;
	}

	/** Run each time a server announces the HQ (e.g. connect the shared Foreman, once). */
	public static void onActive(Runnable r) {
		ON_ACTIVE.add(r);
	}

	private static void onHello(Minecraft mc, HqHelloPayload payload) {
		// singleplayer: the HQ runs in this JVM and its anchors are already ours
		if (mc.getSingleplayerServer() == null) {
			try {
				Anchors.setRemote(Anchors.fromJson(JsonParser.parseString(payload.layoutJson()).getAsJsonObject()));
			} catch (RuntimeException e) {
				AgentCraft.LOGGER.warn("Ignoring a malformed HQ layout from the server", e);
				return;
			}
		}
		boolean arrived = !remoteHq;
		remoteHq = true;
		if (arrived) {
			AgentCraft.LOGGER.info("Arrived at the AgentCraft HQ ({} anchors)", Anchors.current().anchors().size());
			for (Runnable r : ON_ACTIVE) {
				try {
					r.run();
				} catch (RuntimeException e) {
					AgentCraft.LOGGER.warn("HQ arrival hook failed", e);
				}
			}
		}
	}

	private static void leave(Minecraft mc) {
		boolean wasRemote = remoteHq;
		remoteHq = false;
		host = false;
		AgentManager.get().clearFrames();
		if (wasRemote && mc.getSingleplayerServer() == null) {
			Anchors.setRemote(Anchors.Layout.EMPTY);
		}
	}
}
