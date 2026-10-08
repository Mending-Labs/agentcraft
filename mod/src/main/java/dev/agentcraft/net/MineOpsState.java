package dev.agentcraft.net;

import dev.agentcraft.AgentCraft;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import net.minecraft.server.MinecraftServer;

/**
 * A dedicated HQ server run by MineOps: MineOps puts a server in its Velocity proxy (so players reach
 * it with {@code /server <name>}) once the server publishes its state in
 * {@code .mineops/game-state.properties}, which its Paper plugin does for Paper servers. This writes
 * the same file for a Fabric server: every 10 s while running, CLOSING when stopping. It is written
 * from a timer of its own, not from server ticks: an empty server pauses its ticks after a minute
 * (pause-when-empty-seconds), and MineOps drops a server whose state is older than 90 s.
 *
 * <p>Off unless {@code AGENTCRAFT_MINEOPS_STATE=1} (env or {@code -Dagentcraft.mineops.state=1}),
 * and never in singleplayer.
 */
public final class MineOpsState {
	static final String FILE = ".mineops/game-state.properties";
	private static final long EVERY_SECONDS = 10;
	private static ScheduledExecutorService timer;

	private MineOpsState() {
	}

	public static void init() {
		if (!enabled()) {
			return;
		}
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			if (!server.isDedicatedServer()) {
				return;
			}
			timer = Executors.newSingleThreadScheduledExecutor(r -> {
				Thread t = new Thread(r, "AgentCraft-MineOpsState");
				t.setDaemon(true);
				return t;
			});
			// player count and tick time are read off-thread: a slightly stale value is fine here
			timer.scheduleAtFixedRate(() -> {
				try {
					write(server, null);
				} catch (RuntimeException e) {
					AgentCraft.LOGGER.warn("Could not publish the MineOps state", e); // an exception would cancel the timer
				}
			}, 0, EVERY_SECONDS, TimeUnit.SECONDS);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (!server.isDedicatedServer()) {
				return;
			}
			if (timer != null) {
				timer.shutdownNow();
				timer = null;
			}
			write(server, "CLOSING");
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

	private static synchronized void write(MinecraftServer server, String status) {
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
