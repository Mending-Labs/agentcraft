package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;

/**
 * A dedicated HQ server run by MineOps: MineOps puts a server in its Velocity proxy (so players reach
 * it with {@code /server <name>}) once the server publishes its state in
 * {@code .mineops/game-state.properties}, which its Paper plugin does for Paper servers. This writes
 * the same file for a Fabric server: every 10 s while running, CLOSING when stopping.
 *
 * <p>Off unless {@code AGENTCRAFT_MINEOPS_STATE=1} (env or {@code -Dagentcraft.mineops.state=1}),
 * and never in singleplayer.
 */
public final class MineOpsState {
	static final String FILE = ".mineops/game-state.properties";
	private static final int EVERY_TICKS = 200;
	private static int ticks;

	private MineOpsState() {
	}

	public static void init() {
		if (!enabled()) {
			return;
		}
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			if (server.isDedicatedServer() && ++ticks % EVERY_TICKS == 1) {
				write(server, null);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (server.isDedicatedServer()) {
				write(server, "CLOSING");
			}
		});
	}

	static boolean enabled() {
		String v = System.getProperty("agentcraft.mineops.state");
		if (v == null || v.isBlank()) {
			v = System.getenv("AGENTCRAFT_MINEOPS_STATE");
		}
		return v != null && switch (v.trim().toLowerCase(Locale.ROOT)) {
			case "1", "true", "yes", "on" -> true;
			default -> false;
		};
	}

	/** The file's content: the keys and checks of MineOps' GameBridge (version 1). */
	static String render(int online, int max, double tickMs, long now, String status) {
		String s = status != null ? status : online >= max ? "FULL" : "OPEN";
		return "version=1\n"
			+ "timestampMs=" + now + "\n"
			+ "onlinePlayers=" + online + "\n"
			+ "maxPlayers=" + max + "\n"
			+ "tickTimeMs=" + String.format(Locale.ROOT, "%.3f", Math.max(0, tickMs)) + "\n"
			+ "status=" + s + "\n";
	}

	private static void write(MinecraftServer server, String status) {
		Path file = server.getServerDirectory().resolve(FILE);
		try {
			Files.createDirectories(file.getParent());
			Path tmp = file.resolveSibling("game-state.properties.tmp");
			Files.writeString(tmp, render(server.getPlayerCount(), server.getPlayerList().getMaxPlayers(),
				server.getAverageTickTimeNanos() / 1_000_000.0, System.currentTimeMillis(), status), StandardCharsets.UTF_8);
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			AgentCraft.LOGGER.warn("Could not write {}", file, e);
		}
	}
}
