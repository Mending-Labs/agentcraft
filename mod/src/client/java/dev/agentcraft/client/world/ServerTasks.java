package dev.agentcraft.client.world;

import dev.agentcraft.client.hq.HqSession;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.world.level.Level;

/**
 * Run world changes driven by Foreman state (lamp status, podium open, merge station active, ...)
 * where the HQ is. Keep the work small and idempotent (only set a block state when it actually
 * differs).
 *
 * <ul>
 * <li>singleplayer: on the integrated server thread, with the overworld (the world itself changes,
 * as before);</li>
 * <li>a dedicated HQ server: right away, in this client's own view of the world. The server never
 * changes these blocks, so the client's copy stays as set (and the drivers re-apply it every few
 * seconds, e.g. after a chunk is sent again). Every player is on the same Foreman, so all of them
 * see the same lamps and podium.</li>
 * </ul>
 *
 * <pre>
 * ServerTasks.run(level -> {
 *     BlockState s = level.getBlockState(pos);
 *     if (s.getValue(StatusLampBlock.STATUS) != wanted) level.setBlock(pos, s.setValue(StatusLampBlock.STATUS, wanted), Block.UPDATE_CLIENTS);
 * });
 * </pre>
 */
public final class ServerTasks {
	private ServerTasks() {
	}

	/** Apply {@code task} to the HQ world; false when not at the HQ (nothing is run). Client thread. */
	public static boolean run(Consumer<Level> task) {
		Minecraft mc = Minecraft.getInstance();
		IntegratedServer server = mc.getSingleplayerServer();
		if (server != null) {
			server.execute(() -> task.accept(server.overworld()));
			return true;
		}
		if (mc.level != null && HqSession.active()) {
			task.accept(mc.level);
			return true;
		}
		return false;
	}
}
