package dev.agentcraft.client.ui;

import dev.agentcraft.client.hq.HqSession;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;

/** A HUD element whose failures are logged and swallowed ({@link Guard}): a broken overlay never crashes the game. */
public final class GuardedHud {
	private GuardedHud() {
	}

	public static HudElement of(String kind, HudElement element) {
		return (g, deltaTracker) -> Guard.run(kind, () -> element.extractRenderState(g, deltaTracker));
	}

	/** Drawn only at the AgentCraft HQ ({@link HqSession}). */
	public static HudElement atHq(String kind, HudElement element) {
		return (g, deltaTracker) -> Guard.run(kind, () -> {
			if (HqSession.active()) {
				element.extractRenderState(g, deltaTracker);
			}
		});
	}
}
