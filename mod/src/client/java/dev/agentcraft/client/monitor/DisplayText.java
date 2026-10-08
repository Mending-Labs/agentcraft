package dev.agentcraft.client.monitor;

import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.LinkStatus;
import dev.agentcraft.client.foreman.Protocol.AgentState;
import dev.agentcraft.client.ui.Tr;
import org.jspecify.annotations.Nullable;

/**
 * Words shared by every in-world display, so the monitors, the Task Wall and the HUD connection
 * pill ({@code hud.ConnectionBanner}) always say the same thing about the Foreman link.
 */
public final class DisplayText {
	private DisplayText() {
	}

	/** The link was live and dropped: the last known state stays on screen, dimmed. */
	public static String offline() {
		return Tr.t("monitor.foreman_offline");
	}

	/** An agent's state as shown when it reports no activity line (the wire value stays untouched). */
	public static String agentState(AgentState state) {
		return Tr.t("monitor.state_" + state.wire());
	}

	/** Why there is nothing to show yet (no snapshot ever received): the HUD pill's wording. */
	public static String noData(@Nullable ForemanState s) {
		if (s == null || s.link().phase() == LinkStatus.Phase.DISABLED) {
			return Tr.t("monitor.foreman_link_off");
		}
		return Tr.t("monitor.foreman_not_running");
	}
}
